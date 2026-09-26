#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${1:-"$ROOT/_site"}"

rm -rf "$SITE_DIR"
mkdir -p "$SITE_DIR"

for page in \
  smart-model-explainer.html \
  kiosk-flow-explainer.html \
  wire-protocol-explainer.html \
  wire-protocol-inspector.html
do
  cp "$ROOT/site/$page" "$SITE_DIR/$page"
done
cp "$ROOT/spec.md" "$SITE_DIR/spec.md"
bun "$ROOT/scripts/render-spec.ts" "$ROOT/spec.md" "$SITE_DIR/spec.html"
# The web-wallet hand-off is now documented by the client library.
HANDOFF="https://smart-health-checkin.org/client/docs/web-wallet-handoff.html"
printf '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=%s"><link rel="canonical" href="%s"><title>Moved</title><p>Moved to <a href="%s">%s</a>.</p>\n' "$HANDOFF" "$HANDOFF" "$HANDOFF" "$HANDOFF" > "$SITE_DIR/web-wallet-protocol.html"
# This repo deploys to smart-health-checkin.org/spec/. The org site
# (smart-health-checkin.github.io) serves the apex and /assets/ — the design
# system and the shared chrome every page here loads — and the draft spec is
# this section's front page.
cp "$SITE_DIR/spec.html" "$SITE_DIR/index.html"
bun "$ROOT/scripts/generate-llms-txt.mjs" "$SITE_DIR/llms.txt"
# llms.txt here is already the full bundle; every section also serves it as llms-full.txt.
cp "$SITE_DIR/llms.txt" "$SITE_DIR/llms-full.txt"
cp -R "$ROOT/fixtures" "$SITE_DIR/fixtures"

touch "$SITE_DIR/.nojekyll"

find "$SITE_DIR" -type f -name ".DS_Store" -delete

echo "Built GitHub Pages site at $SITE_DIR"
