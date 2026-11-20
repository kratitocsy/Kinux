# ERC / DRC report fixtures

Input for `workers/pcb/erc-drc-report.mjs` (step S2.6) and for
`tests/pcb-erc-drc.test.mjs`.

**These are report files, not live tool output.** This container has
`kicad-cli` 7.0.11, which has no `sch erc` and no `pcb drc` subcommand — both
arrived in KiCad 8.0 (see [`docs/SPIKE-ENV.md`](../../../docs/SPIKE-ENV.md)).
So no real report can be produced here. The parser is therefore driven by these
files, and the tests prove the parser, not the invocation.

## Provenance — read this before trusting a passing test

| File | Provenance |
|---|---|
| `erc-clean.json` | **Real.** Copied unmodified from copperhead's `test/fixtures/reports/`. Written by a real `kicad-cli sch erc` run; the file says `"kicad_version": "10.0.4"`. |
| `erc-unconnected-pin.json` | **Real**, same source. Two sheet-nested violations: one `pin_not_connected` at `error`, one `no_connect_dangling` at `warning`. |
| `drc-clean.json` | **Real**, same source. Written by a real `kicad-cli pcb drc` run, `kicad_version` `10.0.4`. |
| `drc-unrouted.json` | **Hand-authored.** Not validated against a real KiCad 8+ run. |
| `drc-intrinsic.json` | **Hand-authored.** Not validated against a real KiCad 8+ run. |
| `drc-violations.json` | **Hand-authored.** Not validated against a real KiCad 8+ run. |
| `drc-lib-footprint-issues.json` | **Hand-authored.** Not validated against a real KiCad 8+ run. |
| `drc-truncated.json` | **Hand-authored**: the first 620 bytes of `drc-violations.json`, i.e. a report cut off mid-write, as happens when `kicad-cli` is killed. |

The hand-authored DRC files follow the shapes the upstream TypeScript interfaces
describe (`violations[].{severity,type,description,items[].{description,pos}}`,
plus `unconnected_items` and `schematic_parity`) and the item wording the
upstream parser matches on (`"Pad A1 [GND] of J1 on F.Cu"`, `"NPTH pad of J1"`,
`"Track [GND] on F.Cu, length 2.1 mm"`, `"Footprint J1"`). The envelope fields
(`$schema`, `coordinate_units`, `date`, `kicad_version`, `source`,
`included_severities`) were copied from the real files. The violation
descriptions and `uuid` values are invented.

**What that means:** the three real files pin the ERC shape and the clean-DRC
shape against what KiCad genuinely emits. Every DRC test about unrouted
ratsnest, single-footprint findings, shorts and unvouched footprints runs on a
shape we believe is right but have not observed. If a real KiCad 8 report nests
or names something differently, those tests would pass while the parser was
wrong. Re-derive them from a real `kicad-cli pcb drc --format json` run as soon
as KiCad 8+ is available in the container, and delete this paragraph then.
