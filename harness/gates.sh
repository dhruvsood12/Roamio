#!/usr/bin/env bash
# FlightBrain autonomous-harness verification gate.
# Deterministic ground truth: a cycle is only "done" when this exits 0.
# Usage: bash harness/gates.sh [--fast]
#   --fast  run only tracker tests + typecheck + diff check (quick inner loop)
#   (none)  run the full suite + typecheck + diff check (cycle completion gate)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

fail() { echo "GATE-FAIL: $1"; exit 1; }

echo "== gate: git diff --check (whitespace/conflict markers) =="
git diff --check || fail "diff-check"

echo "== gate: typecheck (tsc --noEmit) =="
npm run --silent typecheck || fail "typecheck"

if [ "$FAST" = "1" ]; then
  echo "== gate: tracker tests (fast) =="
  npm run --silent test:tracker || fail "test:tracker"
else
  echo "== gate: full suite =="
  npm run --silent test || fail "test"
fi

echo "GATE-PASS"
