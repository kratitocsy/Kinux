"""Run a `fang` command and save the SPICE deck it builds.

fang's `verify` runs ngspice but leaves no deck on disk, and `fang sim` refuses
whole systems that lack models. fang's own `NgspiceBackend.run` receives the
deck, so this wraps that one method inside this process, saves each deck as
captured<N>.cir, then runs fang unchanged. Nothing in fang is modified.

It leans on an internal class, so it may break when fang changes. There is no
supported command that writes a verification deck, which is part of what this
spike found.

usage: python -I capture.py verify some_program.py
"""
import sys

import fang.simulation as S

_orig = S.NgspiceBackend.run
_n = 0


def _spy(self, netlist, *, workspace, timeout=60):
    global _n
    _n += 1
    with open(f"captured{_n}.cir", "w") as f:
        f.write(netlist)
    return _orig(self, netlist, workspace=workspace, timeout=timeout)


S.NgspiceBackend.run = _spy

from fang.cli import main  # noqa: E402

sys.exit(main(sys.argv[1:]))
