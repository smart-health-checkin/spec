#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_DIR="${1:-"$ROOT/_site"}"

# Every JSON example in the model explainer must pass the client validators.
bun "$ROOT/scripts/check-explainer.ts"
# The spec's requirement IDs are unique and current in requirements.json, its
# JSON examples validate, and Appendix A matches the captured fixture.
bun "$ROOT/scripts/spec-requirements.ts" --check
bun "$ROOT/scripts/check-spec-examples.ts"
bun "$ROOT/scripts/worked-example.ts" --check
# The real capture matches the normative CDDL (needs `gem install cddl`).
bun "$ROOT/scripts/check-spec-cddl.ts"

rm -rf "$SITE_DIR"
mkdir -p "$SITE_DIR"

for page in \
  smart-model-explainer.html \
  kiosk-flow-explainer.html \
  wire-protocol-explainer.html \
  wire-protocol-inspector.html \
  trust-and-limits.html \
  platform-notes.html
do
  cp "$ROOT/site/$page" "$SITE_DIR/$page"
done
cp "$ROOT/spec.md" "$SITE_DIR/spec.md"
# This section's menu, read by the site chrome.
cp "$ROOT/site/nav.json" "$SITE_DIR/nav.json"
bun "$ROOT/scripts/render-spec.ts" "$ROOT/spec.md" "$SITE_DIR/spec.html"
# Links from other sites into the spec keep resolving.
bun "$ROOT/scripts/check-spec-anchors.ts" "$SITE_DIR/spec.html"
# Every link from the explainers into the spec or between pages resolves.
bun "$ROOT/scripts/check-site-links.ts" "$SITE_DIR"
cp "$ROOT/requirements.json" "$SITE_DIR/requirements.json"
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
