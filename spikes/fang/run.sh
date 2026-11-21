#!/usr/bin/env bash
# Spike: give designs written in Copperhead's `fang` to the Kinux mutation engine.
#
# usage: spikes/fang/run.sh /path/to/a/clone/of/github.com/copperheadhq/fang [workdir]
#
# Needs: Python 3.11+, ngspice, Node 22. Builds fang from a COPY into a throwaway
# virtualenv, so the clone is left untouched. Nothing of fang is stored in this
# repository; decks are generated at run time and live in the workdir. fang is
# Apache-2.0 and untrusted code: this runs it, so run it where you accept that.
set -eu

FANG_SRC=${1:?usage: run.sh /path/to/fang-clone [workdir]}
WORK=${2:-$(mktemp -d)}
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
mkdir -p "$WORK"
export HOME=${HOME:-/tmp} NODE_NO_WARNINGS=1

echo "workdir: $WORK"
rm -rf "$WORK/src" "$WORK/v"
cp -r "$FANG_SRC" "$WORK/src"
python3 -m venv "$WORK/v"
"$WORK/v/bin/pip" install -q "$WORK/src"
"$WORK/v/bin/python" -I -c "import fang; print('fang', fang.__version__)"

score() {  # name  include-dir-file-ok
  ex=$1
  d="$WORK/$ex"; rm -rf "$d"; mkdir -p "$d"
  cp -r "$WORK/src/examples/$ex/." "$d/"
  cp "$HERE/capture.py" "$d/"
  ( cd "$d" && "$WORK/v/bin/python" -I capture.py verify "$ex.py" | grep -E "PASS|FAIL|UNDECIDED" | head -3 )
  "$WORK/v/bin/python" -I "$HERE/convert.py" "$d/captured1.cir" "$d/design.cir" "$d"
  node "$ROOT/engine/cli.mjs" verify "$d/design.cir" --checks "$HERE/$ex.checks.md" \
    --out "$d/out" --threshold 0 | grep -E "mutation score"
}

echo; echo "== rc_filter =="; score rc_filter
echo; echo "== buck_regulator =="; score buck_regulator
