# Fixture and reference-check matrix

This project owns the checked-in fixtures. Upstream projects are used to
regenerate or validate those fixtures, not as runtime dependencies.

## Project-owned fixtures

| Fixture root | Generator/check | Purpose |
| ------------ | --------------- | ------- |
| `fixtures/responses/pymdoc-minimal/` | `tools/fixtures-tool/bin/issue-checkin.py` via pyMDOC-CBOR | Byte oracle for `IssuerSignedItem`, MSO, `valueDigests`, `issuerAuth`, and a minimal SMART response document. |
| `fixtures/dcapi-requests/synthetic-basic/` | `rp-web/scripts/generate-dcapi-request-fixtures.ts` | Deterministic positive direct `org-iso-mdoc` request fixture with SMART payload, `EncryptionInfo`, and test-only HPKE recipient keypair. |
| `fixtures/dcapi-requests/synthetic-reader-auth/` | `rp-web/scripts/generate-dcapi-request-fixtures.ts` | Positive direct `org-iso-mdoc` request fixture with per-`DocRequest.readerAuth`, exact tag-24 `ItemsRequest`, direct `dcapi` SessionTranscript, detached COSE_Sign1, and test-only reader certificate artifacts. |
| `fixtures/dcapi-requests/android-chrome-capture/` | Real Chrome/Android run with the reference Android wallet 0.3.6, request built by the client library | Real Chrome Android request: DeviceRequest, ItemsRequest, EncryptionInfo, SessionTranscript, and a public test-only HPKE key |
| `fixtures/dcapi-requests/negative-mattr-mdl/` | `rp-web/scripts/generate-dcapi-request-fixtures.ts` + captured Mattr fixture | Negative request metadata for unrelated mDL direct-mdoc captures. |
| `../android-wallet/app/build/generated/mdoc-validation/synthetic-basic/` | `AndroidMdocValidationFixtureTest` in the android-wallet repo | Deterministic Android-generated response artifacts, validated with the client library and pyMDOC. |
| `fixtures/responses/android-kotlin-generated/` | `vendor/scripts/validate-android-mdoc-response.sh` | Output inspection bundle from RP web HPKE-open + pyMDOC issuer-signed byte checks. |
| `fixtures/responses/android-chrome-capture/` | The same run: the wallet's encrypted response, opened with the capture's key | Encrypted `dcapi` wrapper, plaintext DeviceResponse, issuer and detached device COSE artifacts, pyMDOC byte check |
| `fixtures/captures/2026-04-30-mattr-safari-org-iso-mdoc/` | Captured browser verifier + `rp-web` inspectors | Real direct `org-iso-mdoc` request and `EncryptionInfo` shape. |
| `rp-web/src/protocol/index.test.ts` vectors | `bun test` | Request construction, SessionTranscript derivation, HPKE open/seal, and DeviceResponse inspection. |

Regenerate and check local fixtures:

```sh
bash vendor/scripts/regenerate-local-fixtures.sh
```

That script runs:

```sh
cd tools/fixtures-tool
uv run pytest
uv run python bin/issue-checkin.py --out ../../fixtures/responses/pymdoc-minimal --force
uv run python bin/parse-checkin.py \
  ../../fixtures/responses/pymdoc-minimal/document.cbor \
  --out ../../fixtures/responses/pymdoc-minimal/expected-walk.json

cd ../../rp-web
bun scripts/generate-dcapi-request-fixtures.ts
bun test
```

Validate the Android/Kotlin response builder against independent oracles:

```sh
bash vendor/scripts/validate-android-mdoc-response.sh
```

That script:

1. regenerates deterministic request fixtures,
2. runs `AndroidMdocValidationFixtureTest` to emit Android-built response bytes,
3. opens the Android response with RP web `openWalletResponse()`,
4. inspects the decrypted DeviceResponse with RP web
   `inspectDeviceResponseBytes()`,
5. checks issuer-signed byte invariants and COSE signatures with
    `tools/fixtures-tool/bin/check-android-response.py`.

Set `RUN_MULTIPAZ_REFERENCE=1` to also run the focused Multipaz reference tests
after the local Android/TS/pyMDOC checks. This is intentionally opt-in because
it requires fetched upstream sources and can be much slower than local fixture
validation.

## Upstream reference checks

Fetch pinned upstreams:

```sh
bash vendor/scripts/fetch.sh
```

Run focused upstream checks:

```sh
bash vendor/scripts/run-reference-checks.sh multipaz
bash vendor/scripts/run-reference-checks.sh pymdoc-cbor
bash vendor/scripts/run-reference-checks.sh auth0-mdl
```

### Multipaz checks

The Multipaz check runs JVM/common tests for the behaviors we mirror:

```sh
cd vendor/_src/multipaz
./gradlew -Pdisable.web.targets=true :multipaz:jvmTest \
  --tests 'org.multipaz.presentment.DigitalCredentialsPresentmentTest' \
  --tests 'org.multipaz.mdoc.response.DeviceResponseGeneratorTest' \
  --tests 'org.multipaz.crypto.HpkeTests'
```

Use this when changing our Kotlin response builder, SessionTranscript builder,
or HPKE wrapper.

Local code intentionally mirrors these Multipaz behaviors:

- direct `dcapi` SessionTranscript is `[null, null, ["dcapi", sha256(CBOR([encryptionInfoB64u, origin]))]]`;
- HPKE uses DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, empty AAD, and raw SessionTranscript as `info`;
- response wrapper is `CBOR(["dcapi", {"enc": ephemeralRawP256, "cipherText": ciphertext}])`;
- `DeviceAuthentication` is `["DeviceAuthentication", SessionTranscript, docType, tag24(DeviceNameSpacesBytes)]`;
- `DeviceResponse` document shape follows Multipaz `DeviceResponseGenerator` / `DocumentGenerator`.

### pyMDOC-CBOR checks

The pyMDOC-CBOR check installs the pinned upstream in a local virtualenv and
runs its tests. Use this when changing fixture generation, MSO byte handling,
or issuer-signed digest checks.

### Auth0 `@auth0/mdl` checks

The Auth0 check runs `npm ci` and `npm test`. Use this as a TypeScript-side mdoc
model sanity reference.

## Unit tests we should build locally

| Test | Oracle |
| ---- | ------ |
| Kotlin parses TS-generated `deviceRequest` and extracts `requestInfo.smart_health_checkin` | Local TS-generated request fixture |
| Kotlin preserves tag-24 `ItemsRequest` bytes and verifies detached `DocRequest.readerAuth` | `fixtures/dcapi-requests/synthetic-reader-auth/` |
| Kotlin rejects unrelated Mattr mDL direct-mdoc request | Mattr capture fixture |
| Kotlin direct `dcapi` SessionTranscript matches TS hex | `rp-web` `buildDcapiSessionTranscript()` |
| Kotlin `IssuerSignedItem` tag-24 bytes hash to MSO `valueDigests` | pyMDOC-CBOR fixture invariants |
| Kotlin `issuerAuth` payload unwraps to tag-24 MSO | pyMDOC-CBOR fixture invariants |
| Kotlin `DeviceAuthentication` bytes use exact tag-24 input | Multipaz `DocumentGenerator` behavior |
| Kotlin DeviceResponse shape parses in TS inspector | `rp-web` `inspectDeviceResponseBytes()` |
| Kotlin HPKE wrapper opens in TS | `rp-web` `openWalletResponse()` |
| Android-generated issuer-signed bytes pass pyMDOC-style checks | `tools/fixtures-tool/bin/check-android-response.py` |
| Android-generated issuerAuth and deviceSignature COSE_Sign1 signatures verify | `tools/fixtures-tool/bin/check-android-response.py` |
| Android DeviceAuthentication signs the direct `dcapi` SessionTranscript | `tools/fixtures-tool/bin/check-android-response.py` + request fixture inspection |
| Real Chrome/Android request fixture parses in Kotlin | `RequestFixtureParserTest` |
| Real Android `DeviceResponse` fixture inspects in TypeScript | `rp-web/src/protocol/index.test.ts` |
| Real Android encrypted `dcapi` response fixture opens with captured test HPKE private key | `rp-web/src/protocol/index.test.ts` |
| Real Android response fixture passes COSE/mdoc byte verification | `tools/fixtures-tool/tests/test_checkin_fixture.py` |
