# Third-party notices

Kinux contains code derived from other open-source projects. This file records
what, from where, and under which licence, as those licences require.

## Copperhead

- **Project:** copperhead — <https://github.com/copperheadhq/copperhead>
- **Copyright:** Copyright 2026 Chouhan Industries
- **Licence:** Apache License 2.0 — full text in [`licenses/copperhead-Apache-2.0.txt`](licenses/copperhead-Apache-2.0.txt)
- **Upstream NOTICE**, reproduced as Apache-2.0 section 4(d) requires:

  ```
  copperhead
  Copyright 2026 Chouhan Industries

  This product includes software developed at Chouhan Industries
  (https://github.com/copperheadhq/copperhead).
  ```

Apache-2.0 section 4(b) requires derived files to carry prominent notice that
they were changed. Each file below states its origin and its modifications in
its own header, and every one of them was changed: Copperhead is TypeScript
built with a bundler, Kinux is dependency-free ESM, and Kinux's verdict rules
(`NOT_CHECKED` and `ERROR` are never a pass) are not part of the originals.

| Kinux file | Derived from | What changed |
|---|---|---|
| `workers/ngspice/assertions.mjs` | `src/kicad/spice.ts` | Ported to ESM; wired to Kinux's ngspice runner, which upstream does not have; verdicts mapped to the Kinux contract |
| `workers/kicad/sexp.mjs` | `src/kicad/sexp.ts`, `src/kicad/spans.ts` | Ported to ESM; rewritten as a single pass so every list and atom carries a source span, which the original does not track; `listEnd`/`childSpans` ported near-verbatim from `spans.ts` |
| `workers/kicad/fixtures/open-key.kicad_sch` | `test/fixtures/open-key/hardware/open-key.kicad_sch` | Copied verbatim, unmodified |
| `workers/kicad/schematic.mjs` | `src/kicad/sexp.ts`, `symlib.ts` (format reading only) | Our own module. Its rules for reading the `.kicad_sch` format — which `(symbol …)` is a real component, power-symbol recognition, pin mapping, the two spellings of `Sheetfile` — follow their reading; spans, hierarchy walk and the not-derivable result are ours |
| `workers/pcb/erc-drc-report.mjs` | `src/kicad/report.ts` | Ported to ESM; results mapped to Kinux verdicts, with the KiCad version gate Kinux needs |
| `workers/pcb/fixtures/reports/erc-clean.json`, `erc-unconnected-pin.json`, `drc-clean.json` | `test/fixtures/reports/` | Copied verbatim, unmodified. Real `kicad-cli` output, self-reporting `kicad_version` 10.0.4 |

Kinux's own licence is not yet decided. Note that Apache-2.0 code can be
combined with MIT, BSD, Apache-2.0 and GPLv3, but **not** GPLv2. Taking this
code therefore rules out a GPLv2 Kinux.

The report fixtures above and `open-key.kicad_sch` are the only files taken byte-for-byte; everything
else listed was rewritten. Other fixtures under `workers/pcb/fixtures/reports/`
are our own hand-authored files, not upstream material, and their README says
which is which.

No Copperhead trademark is used, and nothing here implies endorsement.

## three.js (vendored in the viewer)

| Component | Version | Licence | Where | What was taken |
|---|---|---|---|---|
| three.js | 0.169.0, from the npm registry (tarball sha256 c86d0937570fb425d981e156ddf919c43dbc45d4e91fd7c8dd0de56723b3ec71) | MIT, Copyright © 2010-2024 three.js authors; full text in `viewer/vendor/three/LICENSE` | `viewer/vendor/three/` | `build/three.module.min.js`, and from `examples/jsm/`: `loaders/GLTFLoader.js`, `controls/OrbitControls.js`, `utils/BufferGeometryUtils.js`. Unmodified. Used only by the viewer's 3D board view; nothing on the verdict path loads it (tests/no-model-in-verdict.test.mjs). Decided with the founder on 2026-11-22 (CONTRIBUTING rule 6). |

