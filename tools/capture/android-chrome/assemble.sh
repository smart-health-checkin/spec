#!/usr/bin/env bash
# Assemble fixtures/{dcapi-requests,responses}/android-chrome-capture from one
# wallet handler run (pulled with scripts/pull-android-handler-run.sh) and the
# verifier page's own record (artifacts.json, credential.json, capture-env.json in WORK).
#   assemble.sh <spec checkout> <handler run dir> <work dir>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SPEC="$1"; RUN="$2"; WORK="$3"
REQ="$SPEC/fixtures/dcapi-requests/android-chrome-capture"
RES="$SPEC/fixtures/responses/android-chrome-capture"
OLDREQ=$(cd "$SPEC" && git ls-files fixtures/dcapi-requests/android-chrome-capture | xargs -n1 basename | sort)
OLDRES=$(cd "$SPEC" && git ls-files fixtures/responses/android-chrome-capture | xargs -n1 basename | sort)
rm -rf "$REQ" "$RES"; mkdir -p "$REQ" "$RES"
ORIGIN=$(jq -r .origin "$RUN/metadata.json")
# Request side: the inspector's decoding first, then the wallet's own files (they win).
(cd "$SPEC" && bun tools/wire/inspect-mdoc-request.ts "$RUN" --origin "$ORIGIN" --out "$REQ" >/dev/null)
for f in credential-manager-request.json navigator-credentials-get.arg.json request.json device-request.b64u encryption-info.b64u \
         smart-request.json smart-request.expected.json smart-request.hydrated.json; do cp "$RUN/$f" "$REQ/$f"; done
for s in device-request encryption-info session-transcript items-request-tag24 reader-auth reader-auth-detached-payload; do
  cp "$RUN/$s.cbor" "$RUN/$s.cbor.hex" "$REQ/"; done
cp "$WORK/artifacts.json" "$REQ/request-artifacts.json"
jq '.recipientPrivateJwk' "$WORK/artifacts.json" > "$REQ/recipient-private.jwk.json"
jq '.recipientPublicJwk' "$WORK/artifacts.json" > "$REQ/recipient-public.jwk.json"
# Response side: the wallet's files, then the inspectors'.
for f in credential.json wallet-response.digital-credential.json smart-response.expected.json submit.json; do cp "$RUN/$f" "$RES/$f"; done
cp "$RUN/smart-response.expected.json" "$RES/smart-response.json"
for s in device-response.cbor dcapi-response.cbor hpke-enc.bin hpke-ciphertext.bin issuer-signed-item-tag24.cbor value-digest.bin mso.cbor issuer-auth.cbor device-authentication.cbor session-transcript.cbor; do
  cp "$RUN/$s" "$RUN/$s.hex" "$RUN/$s.b64u" "$RES/"; done
T=$(mktemp -d)
(cd "$SPEC" && bun tools/wire/inspect-mdoc-response.ts "$RUN/device-response.cbor" --out "$T/dev" >/dev/null \
  && bun tools/wire/inspect-mdoc-response.ts "$RUN/wallet-response.digital-credential.json" --out "$T/dcapi" >/dev/null)
cp "$T/dev/response-inspection.json" "$T/dev/smart-response.raw.json" "$RES/"
cp "$T/dcapi/response-inspection.json" "$RES/dcapi-response-inspection.json"
bun "$HERE/metadata.ts" "$RUN" "$REQ" "$RES" "$WORK"
(cd "$SPEC" && bun tools/wire/validate-android-mdoc-response.ts "$RES" "$REQ" --out "$T/open")
cp "$T/open/opened-response-inspection.json" "$RES/opened-response-inspection.json"
cp "$T/open/opened-response-inspection.json" "$RES/hpke-opened-response-inspection.json"
(cd "$SPEC/tools/fixtures-tool" && uv run python bin/check-android-response.py "$RES" --out "$RES/pymdoc-byte-check.json")
bun "$HERE/metadata.ts" "$RUN" "$REQ" "$RES" "$WORK"   # again, now that every hashed file exists
diff <(echo "$OLDREQ") <(ls "$REQ" | sort) && diff <(echo "$OLDRES") <(ls "$RES" | sort) && echo "file sets unchanged"
