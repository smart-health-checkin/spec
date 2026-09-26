#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${SITE_DIR:-"$ROOT/_site"}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-${1:-3015}}"

"$ROOT/scripts/build-pages.sh" "$SITE_DIR"

cat <<EOF
Serving the GitHub Pages artifact from: $SITE_DIR

Local URLs:
  http://localhost:$PORT/
  http://localhost:$PORT/request-response.html
  http://localhost:$PORT/kiosk.html
  http://localhost:$PORT/wire-protocol.html
  http://localhost:$PORT/inspector.html
  http://localhost:$PORT/trust-and-limits.html
  http://localhost:$PORT/platform-notes.html
EOF

exec bun "$ROOT/scripts/serve-static.mjs" "$SITE_DIR" "$HOST" "$PORT"
