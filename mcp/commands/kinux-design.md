---
description: Change the design so it meets its checks, with Kinux keeping only edits that fix a failing check and break nothing.
model: opus
---
You improve this DESIGN through the Kinux MCP server named kinux-design (launched with --role designer).
The checks are fixed: you change the design to meet them, never them. Kinux edits a copy of the KiCad
project, rebuilds and re-runs every check and ERC after each edit, and keeps it only if it reaches the
simulated circuit, adds no ERC violation, breaks no passing check and makes at least one failing check pass.

1. Call mcp__kinux-design__kinux_design_brief. For each failing check, read what it measures and the
   measured value, find the parts that set that quantity (from the simulated circuit and the part list),
   and work out the change from the circuit's own equations before you try it.
2. Propose ONE edit at a time with mcp__kinux-design__kinux_propose_edit {kind, ref, value, why}:
   - prefer standard values (E24 resistors, E12 capacitors) and say which;
   - change as few parts as possible, and the cheapest one first;
   - a model swap {kind: model} only when the part itself must change (another diode, another LED),
     to a model file the brief lists.
   A real design takes minutes to rebuild and re-check: a call may answer {status: "pending", id}.
   Then call mcp__kinux-design__kinux_design_wait {id} until it answers; that is normal, not an error.
3. Read every answer. kept: note what it fixed and every value that moved. regression: it broke a passing
   check; read which, and change course. fixes_nothing: it moved the right way but not far enough, or
   the wrong quantity: use the measured values to correct. no_effect: the simulation does not use that
   field; tell the person.
4. Stop when every check passes, or after 8 edits. Call mcp__kinux-design__kinux_design_diff and write for
   the person: each kept edit (part, from -> to, why), the checks it fixed with measured before -> after,
   any check you could not fix and why, and where the edited copy is. A person reviews and applies it.
