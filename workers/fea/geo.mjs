// Geometry for Gmsh: a parametric box we generate ourselves, and a strict
// sanitizer for design-supplied .geo text.
//
// Why the sanitizer exists: the Gmsh .geo language can run shell commands.
//     SystemCall "echo OWNED > pwned.txt";
// creates that file when `gmsh file.geo -3` runs (verified on Gmsh 4.12.1 in
// tests/fea.test.mjs). It can also read files (Include, Merge, ShapeFromFile),
// write files (Save, Print, Printf > "file") and set options that name
// executables (Solver.Executable0 then OnelabRun). So the policy is DEFAULT
// DENY at the token level: every identifier must be a known-safe geometry
// keyword or a plain variable assigned earlier in the same file; dotted option
// names (General.*, Solver.*, Mesh.*) are rejected; strings are allowed only as
// short [A-Za-z0-9_ -] labels. Anything else is rejected with a reason, never
// silently stripped.

const num = x => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`geometry value must be a finite number, got ${x}`);
  // Fixed, locale-free, round-trippable formatting.
  return String(x);
};

/** The six faces of an OpenCASCADE Box, in OCC's surface order. */
export const BOX_FACES = ['xmin', 'xmax', 'ymin', 'ymax', 'zmin', 'zmax'];

/**
 * A box from (0,0,0) to (L,W,H) with physical groups: "solid" for the volume
 * and xmin..zmax for its faces. Degenerate sizes are passed through on
 * purpose: Gmsh decides whether it can mesh them (a failure is mesh_failed).
 */
export function boxGeo({ L, W, H }) {
  const lines = [
    'SetFactory("OpenCASCADE");',
    `Box(1) = {0, 0, 0, ${num(L)}, ${num(W)}, ${num(H)}};`,
    'Physical Volume("solid") = {1};',
    ...BOX_FACES.map((f, i) => `Physical Surface("${f}") = {${i + 1}};`),
  ];
  return lines.join('\n') + '\n';
}

export const ALLOWED_GEO_KEYWORDS = new Set([
  'SetFactory', 'Point', 'Line', 'Circle', 'Ellipse', 'Spline', 'BSpline', 'Curve', 'Loop',
  'Plane', 'Surface', 'Volume', 'Physical', 'Box', 'Cylinder', 'Sphere', 'Cone', 'Rectangle',
  'Disk', 'Torus', 'Wedge', 'BooleanUnion', 'BooleanDifference', 'BooleanIntersection',
  'BooleanFragments', 'Delete', 'Extrude', 'Translate', 'Rotate', 'Dilate', 'Symmetry',
  'Characteristic', 'Length', 'Pi', 'Sqrt', 'Sin', 'Cos', 'Tan', 'Atan', 'Atan2', 'Fabs', 'Abs', 'Exp', 'Log',
]);

/** Named only so a rejection carries a precise reason; default-deny already catches them. */
export const DENIED_GEO_KEYWORDS = new Set([
  'SystemCall', 'NonBlockingSystemCall', 'Include', 'Merge', 'MergeWithBoundingBox', 'ShapeFromFile',
  'Save', 'Print', 'Printf', 'Sprintf', 'Exit', 'Abort', 'Sleep', 'Plugin', 'OnelabRun', 'Call',
  'Function', 'Macro', 'Return', 'For', 'EndFor', 'If', 'EndIf', 'GetEnv', 'SetString', 'GetString',
  'StrCat', 'Str', 'DefineConstant', 'DefineString', 'DefineNumber', 'View', 'Background', 'Draw',
  'CreateDir', 'RenameFile', 'DeleteFile', 'GetValue', 'Exists', 'FileExists', 'Solver', 'General', 'Mesh',
  'Geometry', 'PostProcessing', 'Print', 'Combine', 'Coherence', 'Hide', 'Show', 'Recursive',
]);

export const MAX_GEO_BYTES = 200_000;
const SAFE_LABEL = /^[A-Za-z0-9_ -]{0,64}$/;
const FACTORIES = new Set(['OpenCASCADE', 'Built-in']);

/**
 * Validate design-supplied .geo text. Returns { ok, violations }.
 * Lexes the whole file; every identifier and string is checked.
 */
export function sanitizeGeo(text) {
  const violations = [];
  const bad = (code, line, detail) => violations.push({ code, line, detail });
  if (typeof text !== 'string') return { ok: false, violations: [{ code: 'not_text', line: 0, detail: 'geometry is not text' }] };
  if (Buffer.byteLength(text) > MAX_GEO_BYTES) bad('too_large', 0, `more than ${MAX_GEO_BYTES} bytes`);
  // Control characters (other than \n \r \t) and non-ASCII are refused outright.
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) bad('bad_char', 0, 'non-ASCII or control character');

  const assigned = new Set();
  let i = 0, line = 1;
  let prevIdent = null;      // last identifier at statement start, for `x = ...` detection
  let atStatementStart = true;
  let lastString = { factory: false };
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) { bad('unterminated_comment', line, '/* without */'); break; }
      line += (text.slice(i, end).match(/\n/g) || []).length;
      i = end + 2; continue;
    }
    if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) { bad('unterminated_string', line, 'string without closing quote'); break; }
      const s = text.slice(i + 1, end);
      if (!SAFE_LABEL.test(s)) bad('unsafe_string', line, `string "${s.slice(0, 40)}" is not a plain label`);
      if (lastString.factory && !FACTORIES.has(s)) bad('unsafe_string', line, `unknown factory "${s}"`);
      lastString.factory = false;
      i = end + 1; atStatementStart = false; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(text[j])) j++;
      const id = text.slice(i, j);
      // Dotted names are Gmsh options (General.*, Solver.*, Mesh.*): refused.
      if (text[j] === '.' && /[A-Za-z_]/.test(text[j + 1] ?? '')) {
        bad('option_assignment', line, `option ${id}.${text.slice(j + 1).match(/^[A-Za-z0-9_]*/)[0]} is not allowed`);
      }
      if (DENIED_GEO_KEYWORDS.has(id)) bad('denied_keyword', line, `${id} is not allowed (file, option or command access)`);
      else if (ALLOWED_GEO_KEYWORDS.has(id)) { /* fine */ }
      else {
        // A variable: allowed if being assigned now, or assigned earlier.
        let k = j;
        while (k < n && /[ \t]/.test(text[k])) k++;
        const isAssign = atStatementStart && text[k] === '=' && text[k + 1] !== '=';
        if (isAssign) {
          if ([...DENIED_GEO_KEYWORDS].some(d => d.toLowerCase() === id.toLowerCase())) bad('denied_keyword', line, `variable name ${id} shadows a denied keyword`);
          else assigned.add(id);
        } else if (!assigned.has(id)) {
          bad('unknown_identifier', line, `${id} is neither an allowed keyword nor a variable assigned earlier`);
        }
      }
      lastString.factory = id === 'SetFactory';
      prevIdent = id; atStatementStart = false;
      i = j; continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = text.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
      if (!m) { bad('bad_token', line, `unexpected '${c}'`); i++; continue; }
      i += m[0].length; atStatementStart = false; continue;
    }
    if ('{}()[],=+-*/^;<>!&|?:%'.includes(c)) {
      // `>` after Printf would redirect to a file; Printf is already denied.
      // `#` (array length) and `~` (string concat in some versions) are not in this list.
      if (c === ';') atStatementStart = true;
      else if (c === '{' || c === '}') atStatementStart = c === '}' ? atStatementStart : true;
      else atStatementStart = false;
      i++; continue;
    }
    bad('bad_token', line, `unexpected character '${c}'`);
    i++;
  }
  void prevIdent;
  return { ok: violations.length === 0, violations };
}

export function describeGeoViolations(violations) {
  return violations.map(v => `line ${v.line}: ${v.code}: ${v.detail}`).join('\n');
}
