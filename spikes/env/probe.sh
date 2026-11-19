#!/usr/bin/env bash
# Re-runs the Phase A environment spike. Prints a table of findings.
# Safe to run repeatedly; writes only into a temp dir it creates.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="${HOME:-/tmp}"

say() { printf '%-34s %s\n' "$1" "$2"; }

say "node" "$(node -v 2>/dev/null || echo MISSING)"
say "python3" "$(python3 -V 2>&1 || echo MISSING)"

if docker info >/dev/null 2>&1; then
  say "docker daemon" "RUNNING $(docker info --format '{{.ServerVersion}}' 2>/dev/null)"
else
  say "docker daemon" "NOT RUNNING (client $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,))"
fi

if command -v ngspice >/dev/null 2>&1; then
  say "ngspice" "$(ngspice -v 2>&1 | sed -n 's/.*\(ngspice-[0-9]*\).*/\1/p' | head -1)"
  # reproducibility: 5 runs, one hash
  for i in 1 2 3 4 5; do
    ngspice -b "$HERE/rc.cir" 2>/dev/null | grep -E '^v_(tau|3tau|final)' > "$WORK/r$i.txt"
  done
  N=$(sha256sum "$WORK"/r*.txt | awk '{print $1}' | sort -u | wc -l)
  say "  ngspice reproducible x5" "$([ "$N" -eq 1 ] && echo 'YES (one hash)' || echo "NO ($N hashes)")"
  # shell escape probe
  cd "$WORK" && rm -f pwned.txt
  ngspice -b "$HERE/inject.cir" >/dev/null 2>&1
  say "  .control shell escape" "$([ -f "$WORK/pwned.txt" ] && echo 'EXECUTES -> sanitizer REQUIRED' || echo 'blocked')"
else
  say "ngspice" "MISSING"
fi

if command -v kicad-cli >/dev/null 2>&1; then
  V="$(kicad-cli version 2>/dev/null | head -1)"
  say "kicad-cli" "$V"
  kicad-cli pcb export --help 2>&1 | grep -q 'glb' && G=yes || G=no
  kicad-cli pcb 2>&1 | grep -qw 'drc' && D=yes || D=no
  kicad-cli sch 2>&1 | grep -qw 'erc' && E=yes || E=no
  say "  pcb drc subcommand" "$D"
  say "  sch erc subcommand" "$E"
  say "  pcb export glb" "$G"
  (cd "$WORK" && unset DISPLAY; kicad-cli pcb export svg --layers F.Cu,Edge.Cuts -o o.svg "$HERE/mini.kicad_pcb" >/dev/null 2>&1)
  say "  headless svg export" "$([ -s "$WORK/o.svg" ] && echo "OK ($(wc -c < "$WORK/o.svg") bytes)" || echo FAILED)"
else
  say "kicad-cli" "MISSING"
fi
