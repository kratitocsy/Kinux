// Allowlist sanitizer for ngspice netlists.
//
// Why this file exists: ngspice `.control` blocks execute arbitrary shell
// commands EVEN IN BATCH MODE (`ngspice -b`). A netlist containing
//     .control
//     shell echo OWNED > pwned.txt
//     .endc
// creates that file. Netlists here are derived from untrusted user KiCad
// projects, so an unsanitized netlist is a remote code execution path.
//
// Policy: DEFAULT DENY. Only commands and dot-directives on the allowlists
// below survive. Anything unrecognised is REJECTED (never silently stripped),
// with a structured reason, so the caller can report "we did not run this"
// instead of pretending a check passed.

/** Control-block commands that are safe: they only simulate and print. */
export const ALLOWED_CONTROL_COMMANDS = new Set([
  'run', 'op', 'tran', 'ac', 'dc', 'reset',
  'set', 'unset', 'setplot', 'option', 'options',
  'let', 'save', 'destroy', 'remzerovectors',
  'print', 'echo', 'meas', 'measure',
  'write', 'wrdata',
  'quit',
]);

/** Commands that are explicitly dangerous. Default-deny already catches them;
 *  naming them gives a precise reason code instead of "unknown command". */
export const DENIED_CONTROL_COMMANDS = new Set([
  'shell', 'sh', 'exec', 'system', 'source', 'load', 'cd', 'rusage',
  'spawn', 'aspice', 'rspice', 'edit', 'eval', 'alias', 'define',
  'hardcopy', 'gnuplot', 'wrs2p', 'cdump', 'codemodel', 'osdi', 'pre_osdi',
  'shift', 'rehash', 'history', 'mdump', 'mrdump',
]);

/** Deck-level dot directives that are safe. `.include`, `.lib`, `.inc` read
 *  arbitrary files off this machine, so they are NOT on the list. */
export const ALLOWED_DOT_DIRECTIVES = new Set([
  '.title', '.end', '.ends', '.subckt', '.model', '.param', '.global',
  '.tran', '.ac', '.dc', '.op', '.noise', '.disto', '.tf', '.pz', '.sens',
  '.four', '.fourier', '.temp', '.ic', '.nodeset', '.options', '.option',
  '.print', '.save', '.probe', '.meas', '.measure', '.func', '.csparam',
  '.control', '.endc', '.step', '.width', '.nodeset',
]);

export const MAX_BYTES = 1_000_000;
export const MAX_LINES = 50_000;

const SAFE_BASENAME = /^[A-Za-z0-9._-]+$/;

/** A violation the caller can render or log. */
function v(code, line, text, detail) {
  return { code, line, text, detail };
}

/** Split a raw line into `;`-separated segments. ngspice treats a line in a
 *  control block as one command, but `;` is used both as a comment marker and,
 *  in places, as a separator. We validate EVERY segment: strictly more
 *  conservative than ngspice, which is the safe direction. */
function segments(line) {
  return line.split(';').map(s => s.trim()).filter(s => s.length > 0);
}

/** Join `+` continuation lines (and defensive `\` continuations) into logical
 *  lines, remembering the physical line number the logical line started on. */
function foldContinuations(rawLines) {
  const out = [];
  for (let i = 0; i < rawLines.length; i++) {
    let text = rawLines[i];
    const isPlusCont = /^\s*\+/.test(text);
    const prev = out[out.length - 1];
    if (prev && isPlusCont) {
      prev.text += ' ' + text.replace(/^\s*\+/, '').trim();
      prev.physical.push(i + 1);
      continue;
    }
    if (prev && prev.openBackslash) {
      prev.text += ' ' + text.trim();
      prev.physical.push(i + 1);
      prev.openBackslash = /\\\s*$/.test(text);
      prev.text = prev.text.replace(/\\\s*(?=\s|$)/g, ' ').trim();
      continue;
    }
    out.push({
      line: i + 1,
      text: text.replace(/\\\s*$/, ' ').trimEnd(),
      physical: [i + 1],
      openBackslash: /\\\s*$/.test(text),
    });
  }
  return out;
}

/**
 * Sanitize a netlist.
 * @param {string} source raw netlist text (untrusted)
 * @param {{allowWriteFiles?: string[]}} [opts] basenames `write`/`wrdata` may target
 * @returns {{ok: true, netlist: string, controlBlocks: number, commands: string[]}
 *         | {ok: false, violations: Array<{code:string,line:number,text:string,detail:string}>}}
 */
export function sanitize(source, opts = {}) {
  const violations = [];
  const allowWrite = new Set(opts.allowWriteFiles ?? []);

  if (typeof source !== 'string') {
    return { ok: false, violations: [v('not_text', 0, '', 'netlist must be a string')] };
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_BYTES) {
    return { ok: false, violations: [v('too_large', 0, '', `netlist exceeds ${MAX_BYTES} bytes`)] };
  }
  // NUL and other control characters can hide content from a line-based review.
  const bad = source.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  if (bad) {
    const idx = source.indexOf(bad[0]);
    const line = source.slice(0, idx).split('\n').length;
    violations.push(v('nonprintable', line, '', `control character U+${bad[0].charCodeAt(0).toString(16).padStart(4, '0')}`));
  }

  const rawLines = source.replace(/\r\n?/g, '\n').split('\n');
  if (rawLines.length > MAX_LINES) {
    return { ok: false, violations: [v('too_large', 0, '', `netlist exceeds ${MAX_LINES} lines`)] };
  }

  const logical = foldContinuations(rawLines);
  let inControl = false;
  let controlBlocks = 0;
  const commands = [];

  for (let i = 0; i < logical.length; i++) {
    const L = logical[i];
    const text = L.text;
    const trimmed = text.trim();
    const lower = trimmed.toLowerCase();

    // Line 1 of a SPICE deck is the title; ngspice never interprets it.
    const isTitle = i === 0;

    // Command substitution and backticks are dangerous wherever they appear.
    if (/`/.test(text)) violations.push(v('backtick', L.line, trimmed, 'backtick command substitution'));
    if (/\$\s*\(/.test(text)) violations.push(v('command_substitution', L.line, trimmed, '$( ... ) command substitution'));

    if (isTitle) continue;
    if (trimmed === '' || trimmed.startsWith('*')) continue;

    if (lower === '.control' || lower.startsWith('.control ')) {
      if (inControl) violations.push(v('nested_control', L.line, trimmed, 'nested .control block'));
      inControl = true;
      controlBlocks++;
      continue;
    }
    if (lower === '.endc' || lower.startsWith('.endc ')) {
      if (!inControl) violations.push(v('unbalanced_endc', L.line, trimmed, '.endc without .control'));
      inControl = false;
      continue;
    }

    if (!inControl) {
      // Deck line. Dot directives are allowlisted; element lines (R1, V1, Q1 ...)
      // cannot execute code, so a leading letter is accepted.
      if (trimmed.startsWith('.')) {
        const directive = lower.split(/[\s(=]/)[0];
        if (!ALLOWED_DOT_DIRECTIVES.has(directive)) {
          violations.push(v('directive_not_allowed', L.line, trimmed, `dot directive ${directive} is not on the allowlist`));
        }
      } else if (!/^[A-Za-z]/.test(trimmed)) {
        violations.push(v('unparsable_deck_line', L.line, trimmed, 'deck line is neither a comment, a dot directive nor a device'));
      }
      continue;
    }

    // --- inside a .control block ---
    // Shell metacharacters: redirection and pipelines are never needed, and
    // `shell echo OWNED > pwned.txt` is exactly the attack we block.
    const meta = trimmed.match(/[|&<>]/);
    if (meta) {
      violations.push(v('shell_metacharacter', L.line, trimmed, `'${meta[0]}' (redirection / pipeline) is not allowed in a .control block`));
    }

    for (const seg of segments(text)) {
      const word = seg.trim().split(/[\s(]+/)[0].toLowerCase();
      if (word === '') continue;
      // A `.endc` hidden after a `;` still closes the block for ngspice.
      if (word === '.endc') { inControl = false; continue; }
      if (word === '.control') { violations.push(v('nested_control', L.line, seg, 'nested .control block')); continue; }
      if (DENIED_CONTROL_COMMANDS.has(word)) {
        violations.push(v('denied_command', L.line, seg, `'${word}' can execute code or read the host filesystem`));
        continue;
      }
      if (!ALLOWED_CONTROL_COMMANDS.has(word)) {
        violations.push(v('command_not_allowed', L.line, seg, `'${word}' is not on the control-command allowlist (default deny)`));
        continue;
      }
      if (word === 'write' || word === 'wrdata') {
        const args = seg.trim().split(/\s+/).slice(1);
        for (const a of args) {
          if (a.includes('/') || a.includes('\\') || a.includes('..') || a.startsWith('~') || a.startsWith('$')) {
            violations.push(v('write_path_not_allowed', L.line, seg, `'${a}' escapes the run directory`));
          }
        }
        if (args.length > 0 && SAFE_BASENAME.test(args[0]) && !allowWrite.has(args[0]) && args[0].includes('.')) {
          violations.push(v('write_path_not_allowed', L.line, seg, `'${args[0]}' is not an allowed output file`));
        }
      }
      commands.push(word);
    }
  }

  if (inControl) violations.push(v('unterminated_control', logical.length, '', '.control block is never closed by .endc'));

  if (violations.length) return { ok: false, violations };
  // Nothing is rewritten: a netlist either passes unchanged or is rejected.
  return { ok: true, netlist: source, controlBlocks, commands };
}

/** One-line human summary of a rejection. */
export function describeViolations(violations) {
  return violations.map(x => `line ${x.line}: [${x.code}] ${x.detail}${x.text ? ` -- ${x.text}` : ''}`).join('\n');
}
