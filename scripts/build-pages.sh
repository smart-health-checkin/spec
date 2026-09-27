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

for file in \
  request-response.html \
  kiosk.html \
  wire-protocol.html \
  inspector.html \
  trust-and-limits.html \
  platform-notes.html \
  pages.css \
  inspector.css
do
  cp "$ROOT/site/$file" "$SITE_DIR/$file"
done
# Static JSON examples in the pages get the site's syntax colors.
bun "$ROOT/scripts/highlight.ts" "$SITE_DIR"/*.html
cp "$ROOT/spec.md" "$SITE_DIR/spec.md"
# This section's menu, read by the site chrome.
cp "$ROOT/site/nav.json" "$SITE_DIR/nav.json"
bun "$ROOT/scripts/render-spec.ts" "$ROOT/spec.md" "$SITE_DIR/spec.html"
# Links from other sites into the spec keep resolving.
bun "$ROOT/scripts/check-spec-anchors.ts" "$SITE_DIR/spec.html"
# Every link from the explainers into the spec or between pages resolves, and
# no page shows an unfilled {{…}} marker.
bun "$ROOT/scripts/check-site-links.ts" "$SITE_DIR"
cp "$ROOT/requirements.json" "$SITE_DIR/requirements.json"
# This repo deploys to smart-health-checkin.org/spec/. The org site
# (smart-health-checkin.github.io) serves the apex and /assets/ — the design
# system and the shared chrome every page here loads — and the draft spec is
# this section's front page.
cp "$SITE_DIR/spec.html" "$SITE_DIR/index.html"
cp -R "$ROOT/fixtures" "$SITE_DIR/fixtures"
# llms.txt: the shared background fetched from the apex, then every page as
# Markdown. Fails if a page is neither in it nor skipped with a reason.
bun "$ROOT/scripts/llms.ts" "$SITE_DIR"

touch "$SITE_DIR/.nojekyll"

find "$SITE_DIR" -type f -name ".DS_Store" -delete

echo "Built GitHub Pages site at $SITE_DIR"
