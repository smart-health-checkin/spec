#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

paths=(
  "$ROOT/_site"
  "$ROOT/tools/capture/browser-branching"
  "$ROOT/tools/capture/android-rp-flow"
  "$ROOT/tools/capture/current-handler-run"
  "$ROOT/tools/fixtures-tool/.pytest_cache"
)

for path in "${paths[@]}"; do
  if [[ -e "$path" ]]; then
    rm -rf "$path"
    echo "removed ${path#$ROOT/}"
  fi
done
