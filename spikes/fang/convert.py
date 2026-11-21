"""Turn a deck captured from fang into a design Kinux can mutate.

Kinux wants the circuit and writes its own analysis, so this keeps the circuit
and drops what fang added around it: its `.options` and `.control` block, and
its measurement comments. A `.include` is inlined, because Kinux's sanitizer
refuses `.include` on purpose.

usage: python -I convert.py captured1.cir design.cir [include_dir]
"""
import re
import sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
inc_dir = Path(sys.argv[3]) if len(sys.argv) > 3 else src.parent

out, in_control = [], False
for line in src.read_text().splitlines():
    low = line.strip().lower()
    if low.startswith(".control"):
        in_control = True
        continue
    if low.startswith(".endc"):
        in_control = False
        continue
    if in_control or low.startswith(".options") or low == ".end" or line.startswith("* fang_m"):
        continue
    m = re.match(r"\s*\.include\s+(\S+)", line, re.I)
    if m:
        out.append(f"* inlined from {m.group(1)}")
        out.append((inc_dir / m.group(1)).read_text().strip())
        continue
    out.append(line)
out.append(".end")
dst.write_text("\n".join(out) + "\n")
print(f"wrote {dst} ({len(out)} lines)")
