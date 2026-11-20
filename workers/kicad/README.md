# `workers/kicad/` — the `.kicad_sch` front end

Step 1 of the mutation engine (`docs/STEPS.md`, "Mutation engine pieces"): a
KiCad schematic becomes components, sheet structure and — when it honestly can
— nets, with a source map back to the file. Kinux already reads boards
(`workers/pcb/parse.mjs`); this is the schematic side, where the circuit lives.

| File | What |
|---|---|
| `sexp.mjs` | the s-expression reader, with a span for every node |
| `schematic.mjs` | `.kicad_sch` extraction: components, labels, wires, sheets, connectivity-or-refusal |
| `fixtures/` | small schematics the tests read |

Tests: `tests/kicad-sexp.test.mjs` (`node --test tests/kicad-sexp.test.mjs`).

## Provenance

`sexp.mjs` is derived from [copperhead](https://github.com/copperheadhq/copperhead)'s
`src/kicad/sexp.ts` and `src/kicad/spans.ts`, Copyright 2026 Chouhan
Industries, Apache-2.0. Its header states what was taken and what changed;
`licenses/copperhead-Apache-2.0.txt` and `THIRD-PARTY-NOTICES.md` carry the
licence and the notice. `fixtures/open-key.kicad_sch` is copied unchanged from
copperhead's `test/fixtures/open-key/hardware/open-key.kicad_sch` under the
same licence, so that the two projects' parsers can be compared on identical
input. The other fixtures are Kinux's own.

## Read-only, and why

Nothing here serialises a KiCad file, and nothing ever should. KiCad writes
these files with its own formatting, UUIDs and node types, many of which no
third-party reader understands; round-tripping through a parse tree silently
drops whatever the tree did not model. An edit is therefore an **anchored text
replace**: take the span of the atom you mean to change, and splice.

```js
import { readFileSync } from 'node:fs';
import { parseSchematic } from './schematic.mjs';
import { replaceSpan, sliceSpan } from './sexp.mjs';

const text  = readFileSync(file, 'utf8');
const sheet = parseSchematic(text, file);
const r1    = sheet.components.find(c => c.refdes === 'R1');

sliceSpan(text, r1.span);         // '(symbol\n\t\t(lib_id "Device:R") …)'
sliceSpan(text, r1.spans.value);  // '"10k"'
r1.file; r1.line;                 // '/…/open-key.kicad_sch', 177

const mutated = replaceSpan(text, r1.spans.value, '100k', { inner: true });
// every other byte of the file is identical
```

`{ inner: true }` replaces what is between the quotes and escapes the
replacement the way KiCad escapes a quoted atom.

### Offsets are string indices, not bytes

Spans carry `start`/`end` as JS string offsets (UTF-16 code units) into the
decoded text, plus a 1-based `line` and `column`. Those offsets equal byte
offsets only while the file is pure ASCII, and real schematics carry `Ω`, `µ`
and em dashes. Converting is explicit: `toByteSpan(text, span)`. Anything that
hands an offset to a byte-oriented consumer must convert; nothing pretends the
two are the same.

### Unknown nodes

Any node type parses. A `.kicad_sch` has dozens, and new ones arrive with each
KiCad release — `text_box` in 7, `(hide yes)` moving in 10, `table` and
`rule_area` later still. An unfamiliar node is format we have not met yet, not
a parse failure, so it is read into the tree with its span and tallied in
`sheet.skipped`; node types we recognise but deliberately do not extract
(graphics, images) are tallied apart in `sheet.ignored`. What *does* throw is
structural corruption: unbalanced parentheses or an unterminated string, with
the line and column.

## Connectivity: often not derivable, and said so

**A `.kicad_sch` does not contain nets.** KiCad recomputes them every time from
geometry and naming: pins and wire ends that touch, junctions where wires
cross, local labels (which join by *name*, not only by touching), global labels
shared across the whole design, hierarchical labels tied to the parent sheet's
sheet pins, buses expanded into members, power ports that name a net
implicitly. The net names a netlist shows for unlabelled nets —
`Net-(R1-Pad1)` — are **invented by the netlister** and appear nowhere in the
file.

`deriveConnectivity()` therefore derives nets only for the case where the
geometry really is the whole story, and otherwise refuses:

```js
{ status: 'not_derivable', derivable: false, nets: null,
  blockers: [{ code, detail, file, line }], caveats: [...] }
```

`nets` is `null` when refused. No partial net graph, no guessed names. The
blockers:

| code | why it blocks |
|---|---|
| `hierarchical_design` | more than one sheet: nets cross through sheet pins and global labels |
| `sheet_references` | this sheet has child sheets |
| `hierarchical_labels` | this sheet is a child; its nets continue into the parent |
| `buses` / `bus_label` | bus members are not expanded here |
| `missing_lib_symbol` | a placed symbol has no `lib_symbols` entry, so its pin coordinates are unknown |
| `lib_symbol_without_pins` | the library definition draws no pins |
| `wire_touch_without_junction` | a wire ends part-way along another with no junction: KiCad would not join them, but this is as likely a missing junction, and we will not choose |

When it does derive (`status: 'derived'`), the result still carries `caveats`,
every net name is either one the file states or `null`, and every pin on an
unnamed net also appears in `unresolvedPins` with the reason. Two different
labels on one net produce `name: null`, both `nameCandidates`, and a
`conflicting_net_names` anomaly — that is an ERC error in KiCad and not ours to
resolve.

**The authority is `kicad-cli sch export netlist`.** This module is a fast
local approximation of it for the single-sheet case, useful for picking
mutation targets without launching KiCad. It is not a netlister, and the
mutation engine must treat `not_derivable` as "go ask KiCad", never as "no
nets".

## KiCad format notes worth keeping

Learned from copperhead's `sexp.ts`, `symlib.ts`, `libtable.ts` and
`footprints.ts`, and from the fixtures:

- A placed component and a library definition are both `(symbol …)`. The
  placement has a `(lib_id …)` child; the definition, inside `(lib_symbols …)`,
  does not. That absence is the only reliable discriminator.
- A library symbol's pins live in nested `(symbol "<name>_<unit>_<style>" …)`
  children. `<unit>` 0 is common to every unit; `<style>` ≥ 2 is a de Morgan
  alternate body — the same pins again, so it must be skipped or every pin is
  counted twice. A placed unit shows its own unit's pins plus unit 0's;
  resolving the whole package at one placement invents connection points at
  every other gate's coordinates.
- Symbol Y grows upward, schematic Y grows downward. Placing a pin is mirror,
  then rotate, then `y = symbol.y - rotatedY`.
- Power and ground ports are `(symbol …)` like anything else and must be kept
  out of a BOM. Two tells: a `power:` lib_id prefix, or `(power)` on the
  `lib_symbols` entry. A custom power library (`MyPower:GND`) is only
  recognisable by the second. A power port's `Value` is the net name it
  imposes.
- In a hierarchy the displayed `(property "Reference" …)` is a cache. The
  authoritative refdes is per sheet path, in `(instances (project … (path "/uuid"
  (reference "R1") (unit 1))))`. One sheet file placed twice is two sets of
  refdes from one file — which is why `readDesignGraph` reports
  `duplicateRefdes` and `repeatedSheets` rather than treating a repeat as an
  error.
- A child sheet is named by `(property "Sheetfile" …)` / `"Sheetname"`, and in
  older files by `"Sheet file"` / `"Sheet name"`. Paths are relative to the
  parent sheet's directory.
- `hide` has been written three ways across versions: a bare atom inside
  `(effects …)`, `(hide yes)` inside `(effects …)`, and in KiCad 10 `(hide yes)`
  as a direct child of the property. `flag()` accepts all three; reading only
  one of them misclassifies hidden fields.
- KiCad writes a multi-line text item as `line1\nline2` inside a quoted atom.
  The escape must decode to a real newline; mapping it to the letter `n` gives
  `line1nline2`.
- `.kicad_sch` coordinates are millimetres, same as `.kicad_pcb`.

Library *resolution* (where `Device:R` or `Resistor_SMD:R_0603_1608Metric`
actually lives) is not implemented here, but copperhead's rules are worth
copying when Kinux needs it: project `sym-lib-table`/`fp-lib-table` first, then
the user's global table under the running KiCad's own config version directory,
then the stock install; `${VAR}`/`$(VAR)` URIs expanded, and a row whose
variable has no value treated as unavailable rather than half-expanded; a
`Lib:Name` resolving to exactly `Name` in exactly that library and nothing
else, because a "similar" footprint is how surrogate pads reach a board. Env
overrides are exclusive, and versioned ones (`KICAD9_FOOTPRINT_DIR`) apply only
to the KiCad major version actually running.

## Known limits

- Connectivity, as above: single flat sheet only, and refused rather than
  guessed otherwise. Buses are never expanded.
- Pin-to-wire contact is modelled as "the pin lies anywhere along the
  segment"; wire-to-wire contact needs a shared endpoint or a junction. KiCad's
  own rules are close to this but not provably identical, hence the caveat on
  every result.
- No ERC, no netclasses, no net-tie footprints, no `no_connect` suppression
  (markers are reported, not applied).
- Library resolution and symbol/footprint cross-checking are not ported.
- A SPICE netlist is not produced here; this module supplies the graph and the
  spans it would be built from.

## Checked against real designs

Run over all 19 `.kicad_sch` files in Copperhead's repository — ten real
projects under `manual-tests/real-designs/` (KiCad's own demos, including
`complex_hierarchy`, `multichannel`, `pic_programmer` and `ecc83`, up to 165
components), four reference boards, and their test fixtures.

**No crashes.** Components and spans were extracted from every file.
Connectivity derived for 10 and was refused for 9, which is the intended
behaviour rather than a shortfall: a refusal names its blockers and returns no
nets, instead of guessing.

This is a robustness check, not a correctness check. Nothing here verifies the
derived nets against what KiCad itself computes; `kicad-cli sch export netlist`
remains the authority, and every derived result says so in its caveats.
