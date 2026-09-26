# Where the old spec's text went

A map from the pre-rewrite `spec.md` (1,061 lines, at commit `38f3c5a`) to the rewritten one, so no requirement disappears silently. "Old" cites the old section and line; "New" cites requirement IDs (see `requirements.json`) or a section. Decisions D1–D13 are from the alignment plan.

Rows marked **changed** alter what implementations must do; each cites the decision or reason. Rows marked **removed** give the reason.

## §0 Front matter, §1 Introduction

| Old | New |
| --- | --- |
| §0 L11 status, illustrative values | §0 |
| §0 L13 editorial approach | removed from the spec: meta-commentary. Kept in `docs/rationale.md` |
| §0 L15 license intent | §0 |
| §1 L21 two layers | §1. The wrong cross-reference "§§7-8" is fixed to §8 |
| §1 L23 why DC API and mdoc; "unconventional use of mdoc" | §1.2, `docs/rationale.md` |
| §1 L25 request model, not limit model | §1, §5.4 intro |
| §1.1 L29 Core Trust Rule | [TRUST-1] and the §7 table. The old anchor points to §7 |
| §1.2 L33–37 why this design | §1.2 (short), `docs/rationale.md`; the evidence summary is the §7 table |
| §1.3 L41–43 handoffs | §1.3 |
| §1.4 L47 out of scope | §1.4 as a list. "Beyond existing wire-format algorithm identifiers" is **changed** to "no algorithm negotiation" (D4) |
| §1.4 L47 "Products … SHALL NOT change §§5-6, §7, §8" | [CONF-1] |
| §1.5 L51 companion material MAY live anywhere; SHALL NOT redefine | §1.5. **Removed** as SHALL: it binds documents, not implementations. Now "where they disagree, this document is right" |

## §2 Terminology, §3 Architecture

| Old | New |
| --- | --- |
| §2 L57 BCP 14, RFC references, base64url without padding | §2 |
| §2 L57 "cryptographic operations use exact bytes named by the relevant section" | [ENC-1], [ENC-2], the §8.6 table |
| §2 L59 key terms (Requester, Verifier, Holder, Wallet/Responder, …) | §2. **Changed:** "Requester" and "Verifier" are merged into **Verifier**, and "Wallet/Responder" is now **Wallet**. Each role is defined once, and terms that were used but undefined are added |
| §2 L61 TypeScript JSDoc carries normative requirements | **changed:** TypeScript is shape only (§5.2). Processing rules are prose requirements with IDs |
| §3.1 table, FHIR-native selectors, additive profiles | §3.1, [SEL-3] |
| §3.2 mdoc primer; "issuer signature authenticates the wallet-side response carrier" | §3.2, **changed** per D1: the Wallet self-signs. The signatures show integrity and well-formedness, not issuer identity |
| §3.2 L84 byte ladders are companion material | Appendix A (generated, checked) |

## §4 Conformance

| Old | New |
| --- | --- |
| L88 claim identifies targets, features, version, profile | [CONF-2] |
| L88 one product, several targets: meet each | [CONF-3] |
| L92–96 targets: Requester, Verifier, Wallet/Responder, Deployment/profile author, Conformance/fixture author | §4 table: Verifier and Wallet. Deployment-profile duties are now [PROF-1], and extension duties [EXT-1]–[EXT-3]. The conformance/fixture author target is **removed**: test cases cite requirement IDs instead |
| L98 "core clinical support includes …" list | **removed:** it restated §§5–6 |
| L100 optional features: reader auth, extension selectors, extension media types | §4 list |
| L100 compatibility rules | **removed:** the term was never defined (6 uses) |
| L100 future status-code extensions | **removed:** [RSP-3] allows only the six codes in 1.0; [XV-3] treats any other code as no valid status |
| L100 stricter deployment profiles, fixture profiles | deployment profiles §2, [PROF-1]. "Fixture profiles" is **removed** |
| L100 future DeviceRequest versions, `readerAuthAll` | [WRQ-3] (a Wallet MAY accept a later ISO version). The Verifier sends 1.0 ([VRQ-7]) |
| L100 claiming a feature means implementing all of it | [CONF-3] |
| L100 readerAuth optional; Verifier constructs it per §8; Wallet verifies and classifies | §4, [RA-1], [RA-2], [TRUST-2] |
| L102–114 identifier table | §8.1 table, [MD-1] |
| L116 "no separate conformance checklist" | **replaced** by requirement IDs and `requirements.json` |

## §5 Request model

| Old | New |
| --- | --- |
| L122 transports don't change request fields | §5 intro |
| L126 RFC 8259 object, UTF-8; no comments, NaN, etc. | [JSON-1] (RFC 8259 conformance excludes the listed items) |
| L126 reject a non-object or unparsable request | [JSON-2] |
| L128 unique member names; duplicates rejected | [JSON-1], [JSON-2] |
| L128 member order; preference-ordered arrays | §5.1 note |
| L128 no numeric encodings | [JSON-1] (types per §5.2), [REQ-2] |
| L128 keep values small | [REQ-4] |
| L128 Wallet MAY reject oversized requests | [JSON-5] |
| L130 Wallet MAY ignore unknown members | [JSON-3], **changed** to SHALL ignore (D13). Legacy `canonical` and `resource` are no longer rejected |
| L130 no identity or override via unknown members | [JSON-4] |
| L130 unknown `content.kind` not ignorable | [JSON-3], [SEL-9] |
| L145–149 `type` exact; Wallet rejects others | [REQ-1], [REQ-2] |
| L151–157 `version` "1"; reject "unless future compatibility rule" | [REQ-1], [REQ-2]. The compatibility rule is removed |
| L159–165 `id` non-empty, echoed, compared exactly, correlation only | shape, [RSP-1], [XV-2], §9.1 |
| L167–174 `purpose` carries no identity, consent, or trust; Wallet doesn't treat it as identity | [ID-1], [ID-2] |
| L176–183 `fhirVersions`: Verifier SHOULD include; Wallet SHOULD use | [REQ-5], [ART-3] |
| L185–192 `items`: SHALL include array, SHOULD include at least one; review granularity; MAY regroup | shape, [REQ-3], [HOLD-1], [HOLD-2] |
| L194–199 unknown members | [JSON-3], [JSON-4] |
| L203–209 item `id` unique; Wallet rejects missing, empty, or duplicate | [ITEM-1], [ITEM-2] |
| L211–222 `title`, `summary`; not identity; summary explains broad requests | shape, [ID-2], [ITEM-3] |
| L224–231 `required` advisory | [HOLD-3] |
| L233–239 unknown selector semantics: "reject the request or report unsupported" | [SEL-9], **changed:** `unsupported` for that item only (D5) |
| L241–248 `accept` non-empty ordered; Verifier lists only readable types; Wallet returns only listed types | shape, [ACC-1], [ACC-2] |
| L265–271 `profiles` MAY include `|version`; match by `meta.profile`; no full validation | [SEL-6], [CAN-1] |
| L273–280 `profilesFrom` a non-empty array of URLs, not a string, object, or package | shape (TypeScript) and [SEL-10]. **Changed:** a wrong type now makes that item `unsupported`, not an undefined outcome |
| L282–288 `resourceTypes` official names; semantics with and without profiles | [SEL-4], [SEL-3]. The fix states the no-profile case explicitly |
| L290–294 no form fields on `selection.fhir` | [SEL-8]. **Changed:** `unsupported` for the item (was undefined) |
| L299–326 Questionnaire shape; no selection fields on `form.fhir` | shape, [FORM-1] |
| L328–343 `questionnaireCanonical` preserved; inline consistent with canonical | [CAN-2], [FORM-2], [FORM-5] |
| L345–359 inline Questionnaire required when no canonical | shape comment, [FORM-1] |
| L361–367 extension kind other than core, defined before use | [SEL-1] |
| L373 no self-asserted identity or transport metadata in the body; Wallet doesn't treat body as identity | [ID-1], [ID-2] (list shortened) |
| L377 item required members | shape, [REQ-2] |
| L381 selectors aren't limits, query language, or identity channel | §5.4 intro |
| L381 breadth is deployment policy; broad requests valid | [SEL-7], §9.2 |
| L381 every edge satisfies accept, status, validation | [MM-1] |
| L381 Verifier uses defined or supported selectors | [SEL-1] |
| L381 per-item evaluation, many-to-many allowed | [SEL-2], [MM-1] |
| L385 `profiles` + `profilesFrom` additive | [SEL-3] |
| L385 Verifier SHALL NOT rely on `profiles` to narrow | **removed:** redundant with [SEL-3], which defines the semantics |
| L387 no selector arrays: Wallet and Holder decide; partial allowed | [SEL-7] |
| L391 form validity: "reject or report unsupported" | [FORM-1], **changed:** `unsupported` for the item |
| L391 resolution mechanisms; direct dereference only for unversioned | [CAN-4], **changed** per D9: fetch the bare URL, then verify `url` and `version` exactly |
| L391 cannot resolve: report, don't fabricate | [FORM-4] |
| L391 both fields: canonical is identity, inline is body | [FORM-2] |
| L391 don't merge or rewrite; disagreement SHOULD be unsupported or error | [FORM-3] |
| L395 extension-author duties | [EXT-1], [EXT-3] |
| L395 no private extension selectors where interop is expected | [SEL-1] |
| L395 unsupported extension: don't guess; "reject or unsupported" | [SEL-9] (D5) |
| L399 MAY include `|version`; SHOULD NOT in `profilesFrom` | [CAN-3] |
| L399 parsing rule | [CAN-1] |
| L399 preserve original strings | [CAN-2], [ART-5] |
| L401 SHALL use resolver, cache, or FHIR search; no stripping | [CAN-4] (D9) |
| L403 verify `resourceType`, `url`, `version`; failure is unsupported or error | [CAN-4], [FORM-4] |
| L403 versioned `profiles[]` fulfilled only with exact evidence; Verifier too | [CAN-5], [XV-11] |
| L403 unversioned matches any version | [CAN-5] |
| L403 local routing may ignore version; don't rewrite | [CAN-6] |
| L407 `accept` rules; SHOULD choose earliest; Wallet and Verifier enforce | [ACC-1]–[ACC-3], [XV-7] |
| L409 core media types; forms normally a QuestionnaireResponse | §5.6 table, [FORM-5] |
| L409 extension media types; author duties | [XV-6], [EXT-2] |

## §6 Response model

| Old | New |
| --- | --- |
| L415 transports don't change response fields | §5 intro, §6 intro |
| L421–433 `type`, `version`; Verifier rejects | [RSP-1], [XV-1] |
| L435–440 `requestId` exact; Verifier rejects mismatch | [RSP-1], [XV-2] |
| L442–448 `artifacts` may be empty | shape comment, [RSP-2] |
| L450–455 `requestStatus` exactly one per item | [RSP-2]; [XV-3] **changed** per D14: a missing, duplicate, or unknown-code row affects only that item, and rows for unknown ids are ignored |
| L466–471 Artifact `id` unique; Verifier rejects | [ART-1], [XV-5]. **Changed** per D6: the Verifier disregards the Artifact, not the whole response |
| L473–479 `mediaType`; no `GenericArtifact` catch-all | [XV-6], [EXT-3]. The name `GenericArtifact` is removed (never defined) |
| L481–487 `fulfills` non-empty, real item ids, accepted by every item | [ART-1], [ACC-2], [XV-5], [XV-7] |
| L490–503 SMART Health Card `verifiableCredential[]`; Verifier verifies JWS | [ART-6], [XV-9], [XV-13] |
| L505–509 no `fhirVersion` on SMART Health Cards | [ART-6], [XV-9] |
| L512–524 FHIR resource and Bundle shapes | shape, [XV-8] |
| L530–537 `fhirVersion` non-empty; no mixing; Verifier rejects absent; SHOULD treat unaccepted as unsupported | [ART-2], [XV-8]. **Changed** per D6: per-Artifact. Format is the release version, e.g. `4.0.1` |
| L539–546 `value` a resource or Bundle; SHOULD use Bundle; `meta.profile` preserved | [ART-4] (now says Bundle type `collection`), [ART-5] |
| L549–562 extension Artifacts; "bounded media-type pattern" | [ACC-2], [EXT-2], [EXT-3]. The pattern form is **removed**: it contradicted exact equality |
| L565–592 status codes; only six "unless extension" | table, [RSP-3], [XV-3] (D14). Extensions are removed for 1.0 |
| L594–600 `message` hygiene; don't parse messages | [STAT-1], [STAT-2] |
| L608 don't infer semantics from field names | [XV-14] |
| L608 raw FHIR is patient-mediated | §7 table |
| L608 SHC FHIR version inside the signed payload | [ART-6] |
| L608 "wrapper-level profile summaries" | **removed:** refers to fields that no longer exist |
| L610 fulfilled or partial SHOULD have an Artifact; Verifier SHOULD flag | [ART-7], [XV-12] |
| L614 many-to-many; exactly one status; evaluate all; multiple isn't an error | [MM-1], [RSP-2], [MM-2] |
| L618–630 §6.4 checklist | [XV-1]–[XV-14], split into whole-response ([XV-1], [XV-2] only, per D14), per-Artifact (D6), and per-item checks. "Bundles do not mix releases" is **removed** as a Verifier check (a Verifier cannot detect it); [ART-2] keeps the Wallet rule. The `QuestionnaireResponse.questionnaire` echo is **added** as [XV-10] |

## §7 Trust

| Old | New |
| --- | --- |
| L636 presentation success proves no identity; §5.2 identity rule | §7 intro and table, [ID-1] |
| L638–667 Mermaid trust diagram | replaced by the "proves / does not prove" table |
| L671–674 signal list | §7 table |
| L672 readerAuth five states | [TRUST-2] |
| L676 self-signed certificates; no shared trust framework needed | §7 |
| L676 deployment profile trust duties | [PROF-1] |
| (new) threat table | §7, from the wire and crypto review |

## §8 Same-device flow

| Old | New |
| --- | --- |
| L682 only v1.0 flow; handoffs outside | §8 intro, §1.3 |
| L706–716 identifiers; carrier only in `requestInfo`; no other carriers; response element issuer-signed | §8.1, [MD-1], [VRQ-2], [WRQ-6], [WRS-1], [WRS-5] |
| L718 algorithm baseline; profiles MAY add algorithms | [ALG-1], **changed:** one fixed set (D4). No negotiation |
| L718 reject unilateral choices; no silent downgrade | [ALG-1] (producers), [ALG-2]. **Changed** per D16: receivers warn on unknown algorithm values, except the recipient key |
| L722 JSON text in `requestInfo`; ItemsRequest fields; `intentToRetain` default true; no FHIR as mdoc elements | [VRQ-1], [VRQ-2] (the `intentToRetain` rule is restated as a testable condition) |
| L724 companion element `smart_request_b64u.…` | **removed** (D7) |
| L726 tag-24 ItemsRequest; DeviceRequest 1.0; `readerAuthAll` profiles | [VRQ-3], [VRQ-7] (exactly one DocRequest), [WRQ-3] |
| L728 readerAuth construction; other algorithms | [RA-1], [ENC-3], [ENC-4], the §8.6 table. Other algorithms are **removed** (D4) |
| L730 HPKE key: fresh SHOULD; other suites; reuse-profile duties | [VRQ-4]. Other suites are **removed** (D4). The reuse-profile duty is **removed**: key reuse SHOULD NOT happen |
| L730 `encryptionInfo` shape, COSE_Key labels, nonce ≥16 bytes, retain key and string, base64url | [VRQ-4], [VRQ-5], [VRQ-8], [VRQ-9], §8.7 |
| L734–740 transcript | §8.3 |
| L742 exact `encryptionInfo` string | [TR-1] |
| L742 origin from platform, never request content | [TR-2] (adds the serialization, D12), [TR-3] |
| L742 same transcript everywhere | [TR-5] |
| L742 no origin: "treat origin trust as absent" | [TR-4], **changed:** the Wallet does not respond (without an origin, no response can be opened) |
| L746 Wallet validation list | [WRQ-2]–[WRQ-8], each marked **fail** or warn (D16) |
| L746 invalid request: "reject, report failure, or fail safely" | [WRQ-1], **changed:** the Wallet fails (no response) only at steps marked fail; everything else is a warning (D16) |
| L746 don't infer semantics from mdoc names | [WRQ-6] |
| L748 verify and classify readerAuth | [RA-2], [TRUST-2] |
| L748 Holder review; regroup; `required` not consent; request text isn't identity | [HOLD-1]–[HOLD-3], [ID-2] |
| (new) the Holder declines everything | [HOLD-4] (D10) |
| L750 response requestId; IssuerSignedItem; tag 24; digest; digestID; MSO; issuerAuth | [RSP-1], [WRS-1], [WRS-2], [WRS-4] |
| (new) MSO `version`, `validityInfo`, `x5chain` placement | [WRS-2], [WRS-3] (D2), [ENC-3] |
| L752 DeviceAuthentication; device signature | [WRS-6], **changed:** payload `null` (detached, D2) |
| L752 DeviceNameSpaces normally empty; response stays issuer-signed | [WRS-5] |
| L752 DeviceResponse 1.0, success status | [WRS-7] (exactly one document) |
| L756 HPKE encryption, `info`, empty `aad`, wrap and return; no plaintext | [HPKE-1], [HPKE-2] |
| L758 Verifier checks | [VRS-0]–[VRS-9]. **Changed** per D16: only decoding, decryption, finding the document and element, and the §6.4 whole-response checks fail; signatures, digests, and MSO checks are warnings. An attached device payload that differs from the rebuilt bytes is a warning ([VRS-7]) |
| L758 "reject or quarantine" | [VRS-1] (reject, only at steps marked fail) |
| L758 keep trust decisions distinct | [TRUST-1] |
| (new) validity window check | [VRS-10] (warning) |
| (new) call timeout | [VRQ-10] (SHOULD; from the Android size findings) |
| L762 §8.6 validation checklist | **removed:** duplicated §§8.4–8.5 and contradicted "no separate checklist". The old anchor now points to §8.5 |
| L762 deployment profiles SHOULD define origin, browser, size, … requirements | **removed** as a list; trust items are in [PROF-1] |

## §9 Security, privacy, extensions, i18n

| Old | New |
| --- | --- |
| L770 MUST NOT accept plaintext or unbound HPKE; baseline algorithms; unknown labels rejected | [VRS-3] (unbound HPKE fails to open), [ALG-1], [ALG-2]. The unknown-label rule is **changed** per D11 (only `alg`, `kty`, `crv`, `digestAlgorithm` matter) and D16 (receivers warn) |
| L772 freshness from session; fresh keys; "should reject stale, duplicate, superseded" | §9.1 notes, [VRQ-4], [SEC-1] (now SHOULD NOT act on completed or abandoned sessions) |
| L774 readerAuth states (duplicate) | [TRUST-2] |
| L776 validation doesn't prove accreditation, and so on | [TRUST-1], §7 table |
| L778 identity not in body (duplicate) | [ID-1] |
| L782 minimization; Holder review (duplicate); don't infer from statuses | §9.2 note, [HOLD-1] |
| L784 selective disclosure through items; identifiers scoped; avoid PHI in ids | §1.2, [PRIV-1] (lowercase "should" is now SHOULD NOT) |
| L786 telemetry SHOULD / SHOULD NOT | [PRIV-2] (list shortened) |
| L790 discriminators aren't media types | **removed:** self-evident |
| L790 exact case-sensitive media type comparison | [ACC-4] |
| L792–795 media type table | §5.6 table |
| L797 media type extension duties; no catch-all | [EXT-2], [EXT-3] |
| L799 identifiers exact; incompatible changes SHOULD use a new docType | [MD-1], §9.3 note (guidance to editors, not implementations) |
| L801 status codes and kinds; extensions don't redefine core | §8.1, [EXT-3] |
| L803 profile identifiers aren't request fields | §9.3 note. [JSON-3] makes any such member ignored |
| L807 display text vs protocol values | §9.4 |
| L809 no language negotiation; BCP 47 SHOULD; translation doesn't change protocol values | §9.4, [I18N-2], [I18N-1] |
| L811 isolate untrusted text (SHOULD); no spoofing via Unicode or BIDI (SHALL) | [I18N-4], [I18N-3] |

## Appendix A, References

| Old | New |
| --- | --- |
| A intro: non-normative bridge; ISO owns CDDL | **changed:** §8.7 CDDL is normative. Appendix A is now a worked example computed from a real capture |
| A.1 identifiers, incl. companion prefix | §8.1. The companion prefix is removed (D7) |
| A.2 DC API wrappers | §8.7, [VRQ-8] |
| A.3 DeviceRequest, DocRequest, ItemsRequest CDDL | §8.7 |
| A.4 readerAuth CDDL: undefined `session-transcript-bytes` | §8.7, §8.6. **Fixed:** the transcript is embedded as the array, stated explicitly |
| A.5 encryptionInfo, transcript, HPKE; "suite identifiers travel in …" | §8.7, §8.3, [HPKE-1]. The suite sentence is **removed** (D4) |
| A.6 dcapiResponse | §8.7 |
| A.7 DeviceResponse, IssuerSignedItem, DeviceAuthentication; not in DeviceNameSpaces | §8.7, [WRS-5] |
| A.8 extraction reminders; profiles should pin duplicates, multiple documents, ordering, digestID, nonce | [VRS-0]–[VRS-9]. Exactly one document ([WRS-7], [VRS-4]), encoding ([ENC-1], [ENC-2]), digestID ([WRS-2], [VRS-6]), nonce ([VRQ-4]). Duplicate CBOR map keys: rejected by the receiver, [ENC-5] (D15) |
| References | kept. Added RFC 3339, RFC 4648, RFC 9360, ISO/IEC TS 18013-7, the HTML origin serialization. DCQL is removed (unused) |
| Companion links; companion SHALL NOT redefine | kept, plus conformance cases, `requirements.json`, rationale. The SHALL is removed (binds documents) |

## Requirements with no counterpart in the old text

These are new. Each comes from a decision, from what every implementation already does, or from a gap the review found. They are the ones to read most carefully.

| New | Source |
| --- | --- |
| [SEL-5] profile-family membership (URL prefix plus `/`) | what all three matchers already do (client, Android, Testing EHR) |
| [SEL-10] malformed selector members make the item `unsupported` | the per-item principle of D5 and D6 |
| [FORM-5] second half: `QuestionnaireResponse.questionnaire` from the inline form's `url|version` | what the Android and testing wallets already do |
| [ART-4] Bundle type `collection` (SHOULD) | what implementations produce; the old text named no type |
| [XV-10] the Verifier checks the `QuestionnaireResponse.questionnaire` echo | the client and Testing EHR already check it; the review asked that the spec say so |
| [HOLD-4] all-declined response | D10 |
| [WRQ-4] exactly one DocRequest for this docType; others ignored | review gap (multiple DocRequests were undefined) |
| [WRS-3], [VRS-10] `validityInfo` and the window check | D2; the check is a warning (D16) |
| [WRS-6], [VRS-7] detached device signature | D2 for producers; D16 makes the receiver check a warning |
| [ENC-1]–[ENC-4] encoding and signed-bytes rules | review gap (wire and crypto reviewer) |
| [TR-2] origin serialization | D12 |
| [ENC-5] duplicate CBOR map keys | D15, relaxed by D16: producers SHALL NOT; receivers fail only if they cannot decode, else warn |
| [TR-4] no origin, no response | review finding: the old instruction could not be followed |
| [VRQ-10] call timeout (SHOULD) | Android response-size findings |
| [SEC-1] no acting on completed or abandoned sessions (SHOULD NOT) | the old lowercase "should reject stale, duplicate, superseded" |
| [RCV-0]–[RCV-2] producers strict; receivers fail only where marked, and warn otherwise | D16 |
| (new threat row) altering a response in transit | D16: integrity rests on HPKE, since signature failures are warnings |
