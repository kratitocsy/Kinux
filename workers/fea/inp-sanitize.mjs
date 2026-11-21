// Allowlist sanitizer for CalculiX .inp decks supplied by a design.
//
// What a CalculiX 2.21 deck can reach (from the ccx binary's keyword table,
// its imported symbols, and experiments recorded in tests/fea.test.mjs):
//   * *INCLUDE,INPUT=<path>  reads ANY file, absolute or ../relative. Blanks and
//     case do not matter: `* incl ude , input = ../x.inp` is the same card,
//     because ccx strips all blanks and upper-cases keyword lines. Error
//     messages echo the card images, so an included secret can leak into logs.
//   * *SUBMODEL,INPUT=<path>                reads another model's results file.
//   * *VIEWFACTOR,READ/WRITE,INPUT=/OUTPUT= reads/writes view-factor files.
//   * *SUBSTRUCTUREMATRIXOUTPUT,FILENAME=   writes a file at a chosen path.
//   * *RESTART,READ/WRITE                   reads/writes <job>.rin/.rout; the write
//     path runs `mv temporaryrestartfile ...` through system(): ccx links
//     _gfortran_system_sub and contains the strings "rm -f " and "mv ".
//     The job name is fixed by us ("job"), so no deck text reaches those
//     command lines, but the keyword is refused anyway.
//   * *USERMATERIAL / *USERELEMENT / *USERSECTION call compiled-in user
//     routines (no dlopen in this binary); refused as out of scope.
//   * Contact keywords are refused with reason unsupported_contact.
//   * Lines are read 132 columns at a time; longer lines are refused.
//
// Policy: DEFAULT DENY. Keyword lines are normalised exactly like ccx does
// (blanks removed, upper-cased); the keyword must be on ALLOWED_KEYWORDS
// exactly, every parameter name must be on ALLOWED_PARAMETERS, and parameter
// values must be plain tokens (no '/', '\\', '..', quotes). *INCLUDE is
// resolved HERE: its target must be a bare file name present in the
// caller-supplied `files` map; its content is sanitised recursively and
// inlined, so the deck CalculiX sees contains no *INCLUDE and ccx never opens
// a file by a name that came from the design.

export const ALLOWED_KEYWORDS = new Set([
  '*HEADING', '*NODE', '*ELEMENT', '*NSET', '*ELSET', '*SURFACE',
  '*MATERIAL', '*ELASTIC', '*DENSITY', '*EXPANSION', '*CONDUCTIVITY', '*SPECIFICHEAT', '*PLASTIC',
  '*SOLIDSECTION', '*SHELLSECTION', '*BEAMSECTION', '*ORIENTATION', '*TRANSFORM',
  '*BOUNDARY', '*CLOAD', '*DLOAD', '*CFLUX', '*DFLUX', '*FILM', '*TEMPERATURE', '*INITIALCONDITIONS',
  '*EQUATION', '*AMPLITUDE', '*PHYSICALCONSTANTS',
  '*STEP', '*ENDSTEP', '*STATIC', '*FREQUENCY', '*BUCKLE', '*HEATTRANSFER',
  '*UNCOUPLEDTEMPERATURE-DISPLACEMENT', '*COUPLEDTEMPERATURE-DISPLACEMENT',
  '*NODEPRINT', '*ELPRINT', '*NODEFILE', '*ELFILE', '*NODEOUTPUT', '*ELEMENTOUTPUT',
]);

export const CONTACT_KEYWORDS = new Set([
  '*CONTACTPAIR', '*SURFACEINTERACTION', '*SURFACEBEHAVIOR', '*FRICTION', '*GAP', '*GAPCONDUCTANCE',
  '*TIE', '*CONTACTDAMPING', '*CHANGECONTACTTYPE', '*CHANGEFRICTION', '*CLEARANCE', '*CONTACTPRINT',
  '*CONTACTFILE', '*CONTACTOUTPUT', '*CHANGESURFACEBEHAVIOR', '*GAPHEATGENERATION',
]);

/** Named so a rejection gives a precise reason; default-deny catches them anyway. */
export const FILE_KEYWORDS = new Set([
  '*SUBMODEL', '*VIEWFACTOR', '*SUBSTRUCTUREGENERATE', '*SUBSTRUCTUREMATRIXOUTPUT', '*RESTART',
  '*USERMATERIAL', '*USERELEMENT', '*USERSECTION', '*MATRIXASSEMBLE', '*INITIALMESH', '*REFINEMESH',
  '*CRACKPROPAGATION', '*RANDOMFIELD', '*ROBUSTDESIGN', '*DISTRIBUTIONTABLE',
]);

export const ALLOWED_PARAMETERS = new Set([
  'NAME', 'NSET', 'ELSET', 'TYPE', 'MATERIAL', 'ORIENTATION', 'OP', 'OUTPUT', 'TOTALS', 'GLOBAL',
  'FREQUENCY', 'TIMEPOINTS', 'SOLVER', 'PERTURBATION', 'NLGEOM', 'INC', 'AMPLITUDE', 'STEADYSTATE',
  'DIRECT', 'SECTION', 'OFFSET', 'TIME', 'ZERO', 'DEPENDENCIES', 'STORAGE', 'GENERATE', 'SYSTEM',
  'DEFINITION', 'CONSTANT', 'ABSOLUTEZERO', 'STEFANBOLTZMANN', 'NEWTONGRAVITY', 'POISSON', 'NODALTHICKNESS',
  'MASSFLOW', 'LOADCASE', 'TEMPERATURE',
]);

/** Parameters that, on any keyword, mean "file": named for precise reasons. */
const FILE_PARAMETERS = new Set(['INPUT', 'FILE', 'FILENAME', 'OUTPUT_FILE', 'LIBRARY', 'USER', 'READ', 'WRITE']);

export const MAX_LINE_CHARS = 132;
export const MAX_DECK_BYTES = 20_000_000;
export const MAX_INCLUDE_DEPTH = 4;
const SAFE_BASENAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;
const SAFE_VALUE = /^[A-Za-z0-9_+\-.]*$/;

function violation(code, file, line, text, detail) {
  return { code, file, line, text: String(text).slice(0, 160), detail };
}

/** ccx's own normalisation of a card: every blank removed, upper case. */
export function normalizeCard(line) {
  return line.replace(/[\s]+/g, '').toUpperCase();
}

function sanitizeText(text, file, files, depth, out, violations, seen) {
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) {
    violations.push(violation('bad_char', file, 0, '', 'non-ASCII or control character'));
    return;
  }
  const lines = text.split('\n');
  let prevKeywordEndedWithComma = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const ln = i + 1;
    if (raw.length > MAX_LINE_CHARS) { violations.push(violation('line_too_long', file, ln, raw, `longer than ${MAX_LINE_CHARS} characters`)); continue; }
    const card = normalizeCard(raw);
    if (card.startsWith('**')) { out.push(raw); prevKeywordEndedWithComma = false; continue; }
    // Abaqus allows a keyword line ending with ',' to continue. Treat such a
    // continuation as more parameters: strictly more conservative.
    const isKeyword = card.startsWith('*') || prevKeywordEndedWithComma;
    if (!isKeyword) { out.push(raw); continue; }
    const fields = card.split(',');
    const keyword = prevKeywordEndedWithComma ? null : fields[0];
    const params = (prevKeywordEndedWithComma ? fields : fields.slice(1)).filter(p => p !== '');
    prevKeywordEndedWithComma = card.endsWith(',');

    if (keyword === '*INCLUDE') {
      const p = params.map(s => s.split('='));
      const input = raw.match(/input\s*=\s*(.*)$/i);
      const name = input ? input[1].replace(/\s+/g, '').replace(/^["']|["']$/g, '') : null;
      if (p.length !== 1 || p[0][0] !== 'INPUT' || !name) { violations.push(violation('include_malformed', file, ln, raw, '*INCLUDE needs exactly INPUT=<file>')); continue; }
      if (!SAFE_BASENAME.test(name) || name.includes('..')) { violations.push(violation('include_outside', file, ln, raw, `include target "${name}" is not a bare file name inside the job directory`)); continue; }
      if (!Object.prototype.hasOwnProperty.call(files, name)) { violations.push(violation('include_missing', file, ln, raw, `include target "${name}" was not supplied with the design`)); continue; }
      if (depth >= MAX_INCLUDE_DEPTH) { violations.push(violation('include_depth', file, ln, raw, `includes nested deeper than ${MAX_INCLUDE_DEPTH}`)); continue; }
      if (seen.has(name)) { violations.push(violation('include_cycle', file, ln, raw, `include cycle through "${name}"`)); continue; }
      out.push(`** --- inlined from ${name} by the Kinux sanitizer ---`);
      sanitizeText(String(files[name]), name, files, depth + 1, out, violations, new Set([...seen, name]));
      out.push(`** --- end of ${name} ---`);
      continue;
    }
    if (keyword !== null) {
      if (CONTACT_KEYWORDS.has(keyword)) { violations.push(violation('unsupported_contact', file, ln, raw, `${keyword} (contact) is not supported by this worker`)); continue; }
      if (FILE_KEYWORDS.has(keyword) || keyword.startsWith('*INCLUDE')) { violations.push(violation('file_access', file, ln, raw, `${keyword} reads or writes files or runs user code`)); continue; }
      if (!ALLOWED_KEYWORDS.has(keyword)) { violations.push(violation('unknown_keyword', file, ln, raw, `${keyword} is not on the allowlist`)); continue; }
    }
    let ok = true;
    for (const p of params) {
      const [k, ...rest] = p.split('=');
      const v = rest.join('=');
      if (FILE_PARAMETERS.has(k)) { violations.push(violation('file_access', file, ln, raw, `parameter ${k} can name a file`)); ok = false; continue; }
      if (!ALLOWED_PARAMETERS.has(k)) { violations.push(violation('unknown_parameter', file, ln, raw, `parameter ${k} is not on the allowlist`)); ok = false; continue; }
      if (!SAFE_VALUE.test(v) || v.includes('..')) { violations.push(violation('unsafe_value', file, ln, raw, `value "${v}" of ${k} is not a plain token`)); ok = false; }
    }
    if (ok) out.push(raw);
  }
}

/**
 * Sanitise a deck. `files` maps bare file names to their text: the only
 * things *INCLUDE may name. Returns { ok, deck, violations, reason_code }.
 */
export function sanitizeInp(text, { files = {} } = {}) {
  const violations = [];
  if (typeof text !== 'string') return { ok: false, deck: null, violations: [violation('not_text', 'deck', 0, '', 'deck is not text')], reason_code: 'netlist_unsupported' };
  const total = Buffer.byteLength(text) + Object.values(files).reduce((s, f) => s + Buffer.byteLength(String(f)), 0);
  if (total > MAX_DECK_BYTES) return { ok: false, deck: null, violations: [violation('too_large', 'deck', 0, '', `more than ${MAX_DECK_BYTES} bytes`)], reason_code: 'netlist_unsupported' };
  const out = [];
  sanitizeText(text, 'deck', files, 0, out, violations, new Set());
  if (violations.length) {
    const contact = violations.some(v => v.code === 'unsupported_contact');
    return { ok: false, deck: null, violations, reason_code: contact ? 'unsupported_contact' : 'netlist_unsupported' };
  }
  return { ok: true, deck: out.join('\n') + '\n', violations: [], reason_code: null };
}

export function describeInpViolations(violations) {
  return violations.map(v => `${v.file}:${v.line}: ${v.code}: ${v.detail}`).join('\n');
}
