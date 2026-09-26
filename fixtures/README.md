# Fixtures

Checked-in fixtures and normalized captures live here.

Rules:

- Do not promote captures containing PHI.
- Every binary CBOR artifact should have a `.hex` or `.diag` sibling.
- Every fixture directory should have a `manifest.json` or `metadata.json`.
- Test private keys may be checked in only when they are intentionally public,
  one-run fixture material, explicitly marked in metadata, and unlock no PHI.
- Generated debug summaries should be stable JSON so they can become unit-test
  inputs.

Fixture roots:

- `dcapi-requests/` - DeviceRequest and ItemsRequest fixtures.
- `responses/` - DeviceResponse or response-side mdoc fixtures.
- `captures/` - normalized browser/Android capture bundles.

Notable fixtures:

- `dcapi-requests/android-chrome-capture/` and `responses/android-chrome-capture/` -
  a real Chrome/Android capture: Chrome 145 on an Android 17 emulator, answered by
  the reference Android wallet 0.3.6, with the detached `deviceSignature` and MSO
  `validityInfo`. Includes an intentionally public test-only HPKE private JWK so
  anyone can reopen the response. `pymdoc-byte-check.json` checks it independently
  with pyMDOC/cryptography. Spec Appendix A walks it byte by byte.
- `dcapi-requests/synthetic-basic/` - a deterministic synthetic request.
- `dcapi-requests/synthetic-reader-auth/` - a synthetic request with
  per-`DocRequest.readerAuth`, the exact tag-24 `ItemsRequest`,
  `SessionTranscript`, detached readerAuth COSE_Sign1, and test-only reader
  certificate artifacts.

Current fixture coverage should stay aligned with the spec source of truth:

- request fixtures use `selection.fhir` and `form.fhir`, with exact
  `ItemsRequest.requestInfo["org.smarthealthit.checkin.request"]` carriage;
- response fixtures use raw FHIR or SMART Health Card payload shapes, with no
  generic Artifact catch-all;
- mdoc fixtures use `org-iso-mdoc`, `org.smarthealthit.checkin.1`,
  `org.smarthealthit.checkin`, and `smart_health_checkin_response` exactly;
- future negative fixtures should cover canonical `|version` preservation,
  many-to-many `fulfills[]`, §6.4 cross-validation failures, SMART Health Cards
  without outer `fhirVersion`, raw FHIR with required `fhirVersion`, and Appendix
  A byte-boundary checks.
