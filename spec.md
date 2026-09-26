# SMART Health Check-in 1.0

A clinic app asks a patient's wallet for check-in information and gets back the FHIR data and form answers the patient chose to share. This specification defines that request and response, and how they travel through the W3C Digital Credentials API as an ISO mdoc presentation.

Short title: **SMART Health Check-in 1.0**. Suggested citation label: **SHC-Checkin-1.0**. Suggested document identifier: `smart-health-checkin-1.0`.

---

## 0. Status

Editor's draft 1.0, for implementer review. Editors, license, and publication details are still to be settled; the text is intended for CC BY 4.0, and its TypeScript, CDDL, and examples for use in implementations and tests. Identifiers, URLs, keys, and clinical data in examples are illustrative unless this document marks them as fixed values.

> **Start here**
>
> - A clinic web page, kiosk, or patient portal is the **Verifier**. It builds the request (§5), calls the browser (§8.2), and checks the response before using it (§6.4, §8.5).
> - A patient's wallet app is the **Wallet**. It reads the request (§8.4), lets the patient choose what to share (§5.7), and returns the response (§6).
> - The minimum to implement: the two selector kinds, the two media types, the six statuses, ES256 signatures, SHA-256 digests, and one HPKE suite (§8.1). Reader authentication is optional.
> - Every requirement has an ID such as [XV-2]. Conformance cases in the spec repository cite these IDs, and `requirements.json` lists them all.
> - Appendix A walks one real capture byte by byte. The [explainers](#companion-material) teach the model and the wire format with examples.

---

## 1. Introduction

SMART Health Check-in 1.0 has two layers:

- **The clinical model (§§5–6):** a JSON request listing the items a Verifier would like, and a JSON response carrying the records the Holder shared and one outcome per item. This layer does not depend on the transport.
- **The same-device flow (§8):** the request and response travel through the W3C Digital Credentials API as a direct `org-iso-mdoc` presentation. The response is one mdoc element whose value is the whole response JSON.

A request says what the Verifier is looking for; it does not limit what the Holder may share. The Holder can share less, more, or different content, and the response accounts for it with Artifacts, `fulfills[]`, and a status per item.

### 1.1 What the mdoc layer is for

The mdoc layer is an envelope. It carries the response encrypted to the Verifier, bound to the calling origin, and signed so that it is intact and well formed. Every signature and digest is real and conforms to ISO/IEC 18013-5, so strict mdoc software accepts it. The signatures do not identify a trusted issuer: the Wallet signs its own response. §7 states exactly what each signal proves.

### 1.2 Design in brief

- The Digital Credentials API with `org-iso-mdoc` is what browsers and phone platforms support today, so it is the interoperability surface.
- Disclosure choices live in the JSON (items, statuses, `fulfills[]`), not in mdoc element names, so FHIR stays in FHIR-aware software.
- The design history and the alternatives considered are in [docs/rationale.md](https://github.com/smart-health-checkin/spec/blob/main/docs/rationale.md).

### 1.3 Handoffs as on-ramps

A handoff gets the Holder to a web page that calls the Digital Credentials API: a text-message link, a QR code at the front desk, a portal button, or a kiosk that passes the session to a phone. Handoffs are product and workflow design, not part of this protocol. Everything before the API call can vary by deployment without changing the request, the response, or the validation rules.

### 1.4 Out of scope

Version 1.0 does not define:

- handoff URLs, relays, or cross-device flows;
- credential issuance, data-source synchronization, or Wallet storage;
- EHR write-back, payment, claims, patient matching, identity proofing, or proxy authority;
- a general FHIR query language or a replacement for SMART App Launch;
- a trust framework, or algorithm negotiation.

Products can build these around the protocol. **[CONF-1]** A product that does so SHALL NOT change the meaning of anything §§5–8 define.

### 1.5 Companion material

Explainers, captures, tools, and reference code are listed under [References and companion material](#references-and-companion-material). They are non-normative. Where they disagree with this document, this document is right.

---

## 2. Terminology and conventions

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, NOT RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in BCP 14 (RFC 2119, RFC 8174) when, and only when, they appear in all capitals. This document uses SHALL, SHOULD, and MAY.

Every requirement starts with a bold ID in brackets, such as [XV-2]. IDs are stable across edits; a removed requirement's ID is not reused. The ID's prefix names its topic, not its section.

**Roles**

- **Verifier:** the software that builds a request, invokes the Wallet, and validates and uses the response. A clinic web page, kiosk, or patient portal.
- **Wallet:** the software that receives a request, shows it to the Holder, and builds and returns the response.
- **Holder:** the patient, or a person acting for them, who decides what to share.
- **Deployment profile:** a document that constrains this specification for one deployment, for example by requiring reader authentication or naming trusted certificates.
- **Extension author:** the author of an extension selector kind or media type (§9.3).

**Terms**

- **SMART request** and **SMART response:** the JSON objects of §5 and §6.
- **Item:** one entry in `items[]`. It is one thing the Holder decides about and one row in `requestStatus[]`.
- **Artifact:** one entry in `artifacts[]`: shared content with an `id`, a `mediaType`, and the item ids it answers in `fulfills[]`.
- **Fulfillment:** an Artifact listing an item in `fulfills[]`. One Artifact can fulfill several items, and one item can be fulfilled by several Artifacts.
- **Selector:** an item's `content`, identified by `content.kind`.
- **Canonical:** a FHIR canonical URL, optionally followed by `|version`.
- **Origin:** the calling web page's origin, or for a native app the equivalent string its platform reports (§8.3).

**Notation**

- JSON is RFC 8259. CBOR is RFC 8949 and CDDL is RFC 8610. COSE is RFC 9052 and 9053. HPKE is RFC 9180.
- **base64url** means RFC 4648 base64url without padding.
- `CBOR(x)` is the CBOR encoding of `x`. `tag24(b)` is CBOR tag 24 wrapping the byte string `b` (`#6.24(bstr)`). A name ending in `Bytes`, such as `ItemsRequestBytes`, is `tag24(CBOR(x))` of the structure named without the suffix, following ISO/IEC 18013-5.
- `SessionTranscript` is a CBOR array (§8.3). Where its encoding is used as bytes, this document writes `CBOR(SessionTranscript)`.
- In TypeScript, `NonEmptyString` is a string with at least one character, and `NonEmptyArray<T>` is an array with at least one element.

**Producers and receivers**

For the transport and crypto layer (§8), this specification is strict for whoever builds a message and permissive for whoever receives one. **[RCV-0]** A producer SHALL build exactly what §8 describes. A receiver checks what it receives and classifies each problem as one of:

- **Fail:** the receiver stops. A Wallet does not respond; a Verifier rejects the response.
- **Warning:** the receiver continues.

**[RCV-1]** A receiver that finds a warning SHALL continue processing, and SHOULD report the finding, for example in logs, its user interface, or test output.

**[RCV-2]** A receiver SHALL fail only where §8 marks a step or condition as a failure. Every other problem §8 describes is a warning.

The clinical rules in §§5–6 are unaffected: they already say which problems reject a whole message and which affect one item or Artifact.

---

## 3. Architecture overview

### 3.1 What this profile standardizes

| Layer | Defined here | Left to deployments |
| --- | --- | --- |
| Request (§5) | Items, selectors, accepted media types, canonical handling | Which items to ask for, UI text, stricter limits |
| Response (§6) | Artifacts, media types, `fulfills[]`, statuses, validation | Ingestion, reconciliation, retention, clinical review |
| Trust (§7) | What each signal proves, and what it doesn't | Trusted certificates, allow-lists, patient matching |
| Same-device flow (§8) | Identifiers, byte structures, transcript, encryption, signatures, processing steps | Browser and wallet UX, platform registration |

Selectors use FHIR's own terms: exact profile canonicals in `profiles[]`, profile families in `profilesFrom[]`, FHIR resource type names in `resourceTypes[]`, and Questionnaires through `form.fhir`.

### 3.2 mdoc primer for this profile

An mdoc is the CBOR document format from ISO/IEC 18013-5, built for mobile driver's licenses. In a usual mdoc, an issuer such as a licensing agency signs a Mobile Security Object (MSO) that holds digests of the data elements. The presenting device then proves it holds a key named in the MSO by signing the session.

This profile uses that structure differently. The Wallet puts the whole SMART response JSON into one element, `smart_health_checkin_response`. At presentation time, the Wallet builds the MSO for that element and signs it itself, as the mdoc issuer, with keys it controls. It also signs the session as the device. The result is a complete, verifiable mdoc presentation. Its signatures show that the bytes are intact and well formed. They do not show who issued the content. Evidence about where clinical content came from lives inside Artifacts, for example a SMART Health Card's signature (§7).

---

## 4. Conformance

**[CONF-2]** A conformance claim SHALL name the targets it covers (Verifier, Wallet, or both), the optional features it implements, this specification's version, and any deployment profile it follows.

**[CONF-3]** A product that claims a target or an optional feature SHALL meet every requirement this document places on that target or feature.

| Target | Must implement |
| --- | --- |
| Verifier | Build requests (§5), send them (§8.2), process responses (§8.5), and validate them against the request (§6.4) |
| Wallet | Validate requests (§§5, 8.4), give the Holder the choice (§5.7), and build, sign, and encrypt responses (§§6, 8.4, 8.5) |

Optional features:

- **Reader authentication:** a Verifier signing requests with `readerAuth`, and a Wallet verifying it (§§7, 8.2, 8.4).
- **Extension selector kinds** and **extension media types** (§9.3).

The fixed identifiers are listed in §8.1.

---

## 5. Clinical Request Model

A SMART request is a JSON object that asks for a list of items. §8 defines how it travels; transports add origin, signatures, and encryption around it but never change its fields.

### 5.1 Encoding rules

These rules apply to both the SMART request and the SMART response.

**[JSON-1]** A producer (the Verifier for a request, the Wallet for a response) SHALL produce an RFC 8259 JSON object, encoded as UTF-8, with no duplicate member names at any level. Every field has the type §5.2 or §6.1 gives it; the model has no numeric fields.

**[JSON-2]** A receiver (the Wallet for a request, the Verifier for a response) SHALL reject a SMART request or response that is not a JSON object, cannot be parsed, or has duplicate member names at any level.

**[JSON-3]** A receiver SHALL ignore members this specification does not define, wherever they appear. Values of `content.kind` are not members; §5.4.3 covers unknown kinds.

**[JSON-4]** A producer SHALL NOT use undefined members to change the meaning of defined ones, or to carry identity or trust claims (§5.7).

**[JSON-5]** A Wallet MAY reject a request larger than it can safely display or process.

Member order carries no meaning. `fhirVersions[]` and `accept[]` are in order of preference, and `items[]` is in display order.

### 5.2 Normative TypeScript model

The TypeScript below defines the request's shape: which members exist, their types, and which are optional. The rules for processing it are in §§5.3–5.7.

```typescript
type NonEmptyString = string;
type NonEmptyArray<T> = [T, ...T[]];
type FhirCanonical = NonEmptyString;   // canonical URL, optionally with |version
type FhirRelease = NonEmptyString;     // FHIR release version, e.g. "4.0.1"
type MediaType = NonEmptyString;       // e.g. "application/fhir+json"

interface SmartHealthCheckinRequest {
  type: "smart-health-checkin-request";
  version: "1";
  id: NonEmptyString;             // chosen by the Verifier; echoed as requestId
  purpose?: string;               // why the Verifier is asking, shown to the Holder
  fhirVersions?: FhirRelease[];   // FHIR releases the Verifier can read, preferred first
  items: SmartHealthCheckinRequestItem[];
}

interface SmartHealthCheckinRequestItem {
  id: NonEmptyString;             // unique within the request
  title: NonEmptyString;          // shown to the Holder
  summary?: string;               // one more line for the Holder
  required?: boolean;             // advice to the Holder; default false
  content: Selector;
  accept: NonEmptyArray<MediaType>;   // media types the Verifier can read, preferred first
}

type Selector = SelectionFhirSelector | FormFhirSelector | ExtensionSelector;

interface SelectionFhirSelector {       // share existing FHIR resources
  kind: "selection.fhir";
  profiles?: NonEmptyArray<FhirCanonical>;       // exact StructureDefinitions
  profilesFrom?: NonEmptyArray<FhirCanonical>;   // profile families, e.g. an IG
  resourceTypes?: NonEmptyArray<NonEmptyString>; // FHIR resourceType names
}

interface FormFhirSelector {            // fill in a Questionnaire
  kind: "form.fhir";
  questionnaireCanonical?: FhirCanonical;
  questionnaire?: { resourceType: "Questionnaire"; url?: string; version?: string; [member: string]: unknown };
  // at least one of questionnaireCanonical and questionnaire is present
}

interface ExtensionSelector {           // defined by an extension (§9.3)
  kind: NonEmptyString;                 // any value other than the two above
  [member: string]: unknown;
}
```

An example request, which the build validates:

```json check=request id=example-request
{
  "type": "smart-health-checkin-request",
  "version": "1",
  "id": "checkin-7f3a",
  "purpose": "Clinic check-in",
  "fhirVersions": ["4.0.1"],
  "items": [
    {
      "id": "patient",
      "title": "Patient demographics",
      "required": true,
      "content": {
        "kind": "selection.fhir",
        "profiles": ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"]
      },
      "accept": ["application/fhir+json"]
    },
    {
      "id": "immunizations",
      "title": "Immunizations",
      "content": {
        "kind": "selection.fhir",
        "profilesFrom": ["http://hl7.org/fhir/us/core"],
        "resourceTypes": ["Immunization"]
      },
      "accept": ["application/smart-health-card", "application/fhir+json"]
    },
    {
      "id": "intake",
      "title": "Depression screening (PHQ-2)",
      "content": {
        "kind": "form.fhir",
        "questionnaireCanonical": "https://smart-health-checkin.org/connectathon/Questionnaire/phq-2.json|1"
      },
      "accept": ["application/fhir+json"]
    }
  ]
}
```

### 5.3 Request item constraints

**[REQ-1]** The Verifier SHALL set `type` to `smart-health-checkin-request` and `version` to `"1"`.

**[REQ-2]** The Wallet SHALL reject a request whose `type` or `version` differs, or whose members outside `content` do not have the types §5.2 gives them. An item whose `content` is not an object with a string `kind` makes the whole request invalid; other problems inside `content` affect only that item (§5.4).

**[REQ-3]** The Verifier SHOULD include at least one item.

**[REQ-4]** The Verifier SHOULD keep requests no larger than it needs.

**[REQ-5]** A Verifier that accepts `application/fhir+json` for any item SHOULD list the FHIR releases it can read in `fhirVersions[]`, unless it can read any release.

**[ITEM-1]** The Verifier SHALL give every item an `id` that is unique within the request.

**[ITEM-2]** The Wallet SHALL reject a request with a missing, empty, or duplicate item `id`. Item ids are compared as exact strings.

**[ITEM-3]** The Verifier SHOULD use `summary` to explain broad requests, such as a whole profile family or a request with no filters.

### 5.4 Content selectors

A selector says what the Verifier is looking for. It is not a query language, an authorization rule, or a limit on what the Holder may share.

**[SEL-1]** The Verifier SHALL use `selection.fhir`, `form.fhir`, or a kind defined by a published extension (§9.3).

**[SEL-2]** The Wallet SHALL evaluate each item's selector on its own. §6.3 covers Artifacts that answer several items.

**[SEL-10]** The Wallet SHALL report `unsupported` for an item whose selector members do not have the types §5.2 gives them, for example a `profilesFrom` that is a string, and process the other items.

#### 5.4.1 `selection.fhir`

**[SEL-3]** The Wallet SHALL treat `profiles[]` and `profilesFrom[]` as alternatives: when either is present, a resource matches if it matches any listed profile or belongs to any listed family. `resourceTypes[]` narrows the match to those resource types; on its own, it matches any resource of those types.

**[SEL-4]** The Verifier SHALL list only FHIR `resourceType` names in `resourceTypes[]`.

**[SEL-5]** A profile belongs to a family when its canonical URL, without any `|version`, starts with the family URL followed by `/`. The Wallet MAY also use other evidence of membership, such as an implementation guide's package.

**[SEL-6]** The Wallet MAY match a resource by its `meta.profile` or by other evidence it holds; it need not validate the resource against the profile.

**[SEL-7]** When an item has none of `profiles[]`, `profilesFrom[]`, and `resourceTypes[]`, the Wallet and Holder decide what is relevant to the check-in. The Wallet MAY answer such an item in part.

**[SEL-8]** The Wallet SHALL report `unsupported` for a `selection.fhir` item that also has `questionnaireCanonical` or `questionnaire`.

#### 5.4.2 `form.fhir`

**[FORM-1]** The Wallet SHALL report `unsupported` for a `form.fhir` item that has neither `questionnaireCanonical` nor `questionnaire`, whose `questionnaire` is not a Questionnaire, or that also has `profiles`, `profilesFrom`, or `resourceTypes`.

**[FORM-2]** When both are present, `questionnaireCanonical` names the form and `questionnaire` is the body to show. The Verifier SHOULD make the inline Questionnaire's `url` and `version` match the canonical.

**[FORM-3]** The Wallet SHALL NOT rewrite `questionnaireCanonical`, or merge two conflicting Questionnaire definitions. If the inline Questionnaire and the canonical disagree about which form this is, the Wallet SHOULD report `unsupported` rather than collect answers.

**[FORM-4]** When there is no inline Questionnaire, the Wallet SHALL resolve `questionnaireCanonical` as §5.5 describes. If it cannot resolve, show, or use the form, it SHALL report `unsupported` or `error` (§6.2) and SHALL NOT invent a form.

**[FORM-5]** The Wallet SHALL answer a form with a FHIR `QuestionnaireResponse` in an `application/fhir+json` Artifact. Its `questionnaire` SHALL be `questionnaireCanonical` exactly when the item has one. Otherwise it SHALL be the inline Questionnaire's `url`, followed by `|` and its `version` when it has one; if the inline Questionnaire has no `url`, the Wallet omits `questionnaire`.

#### 5.4.3 Extension selectors

**[SEL-9]** A Wallet that does not support an item's `content.kind` SHALL report `unsupported` for that item and process the other items. It SHALL NOT guess the item's meaning from its title, summary, or other members.

### 5.5 Canonical `|version` handling

**[CAN-1]** Anyone parsing a canonical SHALL split it at the first `|`: the text before is the `url`, the text after is the `version`, and any later `|` is part of the version.

**[CAN-2]** Implementations SHALL keep canonical strings exactly as written wherever they are echoed or stored: in `meta.profile`, in `QuestionnaireResponse.questionnaire`, in logs, and in test data.

**[CAN-3]** The Verifier SHOULD NOT add `|version` to a `profilesFrom[]` entry unless it means a specific version of the family.

**[CAN-4]** To resolve a canonical, a Wallet MAY use a configured resolver, a cache, a FHIR search (`GET [base]/{ResourceType}?url={url}&version={version}`), or an HTTP(S) request to the `url`. Whatever it uses, it SHALL then check that the resource has the expected `resourceType`, that its `url` equals the parsed `url`, and, for a versioned canonical, that its `version` equals the parsed `version`. A resource that fails these checks does not resolve the canonical.

**[CAN-5]** For an item whose `profiles[]` includes a versioned canonical, the Wallet SHALL NOT report `fulfilled` unless a returned resource's `meta.profile` includes that exact versioned canonical. An unversioned canonical matches any version of the profile.

**[CAN-6]** Software MAY ignore `|version` when grouping, routing, or displaying, but SHALL NOT remove it from any value it returns, stores as evidence, or validates.

### 5.6 Accepted media types

**[ACC-1]** The Verifier SHALL list in each item's `accept[]` only media types it can parse, validate, and use, most preferred first.

**[ACC-2]** The Wallet SHALL NOT return an Artifact whose `mediaType` is missing from the `accept[]` of any item the Artifact fulfills.

**[ACC-3]** The Wallet SHOULD use the earliest type in `accept[]` that it can produce.

**[ACC-4]** Verifiers and Wallets SHALL compare media types as exact, case-sensitive strings, without parameters.

| Media type | Artifact carries |
| --- | --- |
| `application/fhir+json` | A FHIR resource or Bundle in `value`, and `fhirVersion`. For `form.fhir` items, a `QuestionnaireResponse`. |
| `application/smart-health-card` | A SMART Health Card file's JSON in `value`, with `verifiableCredential[]`; no `fhirVersion`. |

### 5.7 Identity, trust, and Holder control

**[ID-1]** The Verifier SHALL NOT put claims about its own identity or trustworthiness in the request (organization names, logos, URLs, certificates, keys, accreditation data, or consent terms), nor handoff or transport data such as callback URLs, relay pointers, or nonces.

**[ID-2]** The Wallet SHALL NOT treat anything in the request, including `purpose`, `title`, and `summary`, as evidence of who is asking. That comes from the origin and, if present, reader authentication (§7).

**[HOLD-1]** Before sharing anything, the Wallet SHALL let the Holder decide item by item, unless a deployment profile defines an equivalent Holder control.

**[HOLD-2]** The Wallet MAY group, reorder, or summarize items on screen, but SHALL keep each item's `id` in the response.

**[HOLD-3]** The Wallet SHALL NOT treat `required: true` as consent or as a reason to skip the Holder's choice. A required item may still be declined, unavailable, unsupported, or answered in part.

**[HOLD-4]** When the Holder reviews the request and declines every item, the Wallet SHALL return a response in which every item has status `declined`. When the Holder dismisses the Wallet without reviewing, the Wallet returns nothing, and the platform ends the call with its cancellation error.

---

## 6. Clinical Response Model

A SMART response carries the Artifacts the Holder chose to share and one status for every requested item.

### 6.1 Normative TypeScript model

```typescript
interface SmartHealthCheckinResponse {
  type: "smart-health-checkin-response";
  version: "1";
  requestId: NonEmptyString;         // the request's id, exactly
  artifacts: Artifact[];             // may be empty
  requestStatus: RequestItemStatus[];// one per request item
}

type Artifact = FhirJsonArtifact | SmartHealthCardArtifact | ExtensionArtifact;

interface ArtifactBase {
  id: NonEmptyString;                        // unique within the response
  mediaType: MediaType;
  fulfills: NonEmptyArray<NonEmptyString>;   // request item ids
}

interface FhirJsonArtifact extends ArtifactBase {
  mediaType: "application/fhir+json";
  fhirVersion: FhirRelease;                  // e.g. "4.0.1"
  value: { resourceType: NonEmptyString; [member: string]: unknown };  // a resource or a Bundle
}

interface SmartHealthCardArtifact extends ArtifactBase {
  mediaType: "application/smart-health-card";
  value: { verifiableCredential: NonEmptyArray<NonEmptyString>; [member: string]: unknown };
}

interface ExtensionArtifact extends ArtifactBase {
  mediaType: MediaType;                      // defined by an extension (§9.3)
  [member: string]: unknown;
}

type RequestItemStatusCode =
  "fulfilled" | "partial" | "unavailable" | "declined" | "unsupported" | "error";

interface RequestItemStatus {
  item: NonEmptyString;                      // a request item id
  status: RequestItemStatusCode;
  message?: string;                          // short explanation for people
}
```

An example response to the request in §5.2, which the build validates against it:

```json check=response request=example-request
{
  "type": "smart-health-checkin-response",
  "version": "1",
  "requestId": "checkin-7f3a",
  "artifacts": [
    {
      "id": "a1",
      "mediaType": "application/fhir+json",
      "fhirVersion": "4.0.1",
      "fulfills": ["patient"],
      "value": {
        "resourceType": "Patient",
        "meta": { "profile": ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"] },
        "name": [{ "family": "Okafor", "given": ["Sam"] }],
        "birthDate": "1986-04-12"
      }
    },
    {
      "id": "a2",
      "mediaType": "application/smart-health-card",
      "fulfills": ["immunizations"],
      "value": { "verifiableCredential": ["eyJ6aXAiOiJERUYiLCJhbGciOiJFUzI1NiJ9.example.signature"] }
    },
    {
      "id": "a3",
      "mediaType": "application/fhir+json",
      "fhirVersion": "4.0.1",
      "fulfills": ["intake"],
      "value": {
        "resourceType": "QuestionnaireResponse",
        "questionnaire": "https://smart-health-checkin.org/connectathon/Questionnaire/phq-2.json|1",
        "status": "completed",
        "item": [
          { "linkId": "phq2-1", "answer": [{ "valueCoding": { "system": "http://loinc.org", "code": "LA6568-5", "display": "Not at all" } }] },
          { "linkId": "phq2-2", "answer": [{ "valueCoding": { "system": "http://loinc.org", "code": "LA6569-3", "display": "Several days" } }] }
        ]
      }
    }
  ],
  "requestStatus": [
    { "item": "patient", "status": "fulfilled" },
    { "item": "immunizations", "status": "partial", "message": "One vaccine record was not shared" },
    { "item": "intake", "status": "fulfilled" }
  ]
}
```

### 6.2 Artifact and status semantics

**[RSP-1]** The Wallet SHALL set `type` to `smart-health-checkin-response`, `version` to `"1"`, and `requestId` to the request's `id`, exactly.

**[RSP-2]** The Wallet SHALL include exactly one `requestStatus[]` entry for each request item, and no entry for anything else.

**[RSP-3]** The Wallet SHALL use only the six status codes in the table below.

**[ART-1]** The Wallet SHALL give each Artifact an `id` unique within the response, and list in `fulfills[]` only ids of items in the request.

**[ART-2]** In an `application/fhir+json` Artifact, the Wallet SHALL set `fhirVersion` to the FHIR release version of every resource in `value`, such as `4.0.1`, and SHALL NOT mix releases in one Artifact.

**[ART-3]** The Wallet SHOULD choose a FHIR release from the request's `fhirVersions[]`, when present.

**[ART-4]** The Wallet SHOULD put several resources in one Artifact as a Bundle of type `collection`.

**[ART-5]** The Wallet SHALL keep every returned `meta.profile` string exactly as the source had it (§5.5).

**[ART-6]** In an `application/smart-health-card` Artifact, the Wallet SHALL put the card's JWS strings in `value.verifiableCredential[]` and SHALL NOT include `fhirVersion`; the FHIR release is inside the signed card.

**[ART-7]** An item with status `fulfilled` or `partial` SHOULD be listed in the `fulfills[]` of at least one Artifact.

| Status | Meaning |
| --- | --- |
| `fulfilled` | The Wallet believes it shared what the item asked for. |
| `partial` | The Wallet shared some responsive content, but not everything. |
| `unavailable` | The Wallet understood the item but has nothing matching to share. |
| `declined` | The Holder chose not to share this item. |
| `unsupported` | The Wallet cannot process this item: its selector kind, media types, form, or FHIR release. |
| `error` | The Wallet understood the item but failed while processing it. |

**[STAT-1]** The Wallet SHALL NOT put secrets, access tokens, stack traces, or patient details beyond what the Holder shared in `message`.

**[STAT-2]** A Verifier SHALL NOT derive a status's meaning from `message`.

### 6.3 Many-to-many fulfillment

**[MM-1]** The Wallet MAY return one Artifact for several items, or several Artifacts for one item. Each fulfillment still has to meet §5.6 and §6.4.

**[MM-2]** The Verifier SHALL consider every valid Artifact that lists an item. More than one Artifact for an item is not an error; the Verifier chooses which to use.

### 6.4 Verifier cross-validation

A Verifier checks a response against the request it sent before using anything in it. Only [XV-1] and [XV-2] fail the whole response; every other check affects one item or one Artifact.

**[XV-1]** The Verifier SHALL reject the whole response if it fails §5.1, if `type` or `version` differs from §6.2, or if `artifacts` or `requestStatus` is not an array.

**[XV-2]** The Verifier SHALL reject the whole response if `requestId` differs from the request's `id`.

**[XV-3]** The Verifier SHALL treat an item as having no valid status when `requestStatus[]` has no entry for it, more than one entry for it, or an entry for it with a code other than the six in §6.2. It SHALL ignore entries naming ids that are not in the request. Neither case rejects the response.

**[XV-4]** The Verifier SHALL disregard an Artifact that fails any of the checks below. It SHALL keep processing the other Artifacts, and SHALL NOT count a disregarded Artifact toward the items it lists.

**[XV-5]** An Artifact needs an `id` no other Artifact in the response has, a `mediaType`, and a non-empty `fulfills[]` naming only request items. When two Artifacts share an `id`, the Verifier SHALL disregard both.

**[XV-6]** The Artifact's `mediaType` needs to be one of the two core types, or an extension type the Verifier supports.

**[XV-7]** The Artifact's `mediaType` needs to be in the `accept[]` of every item it lists.

**[XV-8]** An `application/fhir+json` Artifact needs a non-empty string `fhirVersion`, and a `value` that is an object with a string `resourceType`. The Verifier SHOULD also disregard it when the request listed `fhirVersions[]` and this release is not among them.

**[XV-9]** An `application/smart-health-card` Artifact needs a non-empty `value.verifiableCredential[]` of strings and no `fhirVersion`.

**[XV-10]** A `QuestionnaireResponse` fulfilling a `form.fhir` item that has `questionnaireCanonical` needs its `questionnaire` to equal that canonical exactly.

**[XV-11]** For an item whose `profiles[]` includes a versioned canonical, the Verifier SHALL NOT treat a `fulfilled` status as met unless an Artifact listing the item contains a resource whose `meta.profile` includes that exact versioned canonical.

**[XV-12]** The Verifier SHOULD flag an item with status `fulfilled` or `partial` that no valid Artifact lists.

**[XV-13]** Before relying on a SMART Health Card, the Verifier SHALL verify each JWS as the SMART Health Cards specification describes, and apply its own trust policy to the issuer.

**[XV-14]** The Verifier SHALL interpret an Artifact's members only as its media type defines them. A member's name alone implies nothing, such as that a value is a URL to fetch.

Passing these checks means the response is well formed and consistent with the request. Whether to accept the content into a chart is a separate, local decision.

---

## 7. Trust Framework

SMART Health Check-in lets two parties exchange data when the Holder chooses to, without first joining a shared trust framework. Each signal in the exchange proves something specific and nothing more. Deployments can add trust requirements on top (§9.3).

| Signal | Proves | Does not prove |
| --- | --- | --- |
| Origin, reported by the browser or platform | Which web origin or app called the Digital Credentials API | That the caller is an organization you trust |
| HPKE encryption bound to `SessionTranscript` | Only the holder of the Verifier's private key, for this origin and this `encryptionInfo`, can read the response | Who sent it: anyone can encrypt to the Verifier's public key |
| `readerAuth`, when present | The request was signed, for this session, by the key in its certificate | Who holds that key, unless a deployment trusts the certificate |
| `issuerAuth` and value digests | The response element is intact, and the mdoc is well formed and verifiable | Who issued the content. The Wallet signs its own MSO with its own key. |
| Device signature | The key named in the MSO signed this session | That the key belongs to the patient's device. Wallets may make new keys for every response. |
| SMART Health Card signature | The card's issuer signed the clinical content | That the card is about this patient |
| Raw `application/fhir+json` | Nothing about its source. It is what the Holder chose to share. | Provenance, unless the content carries its own evidence |
| Request content | Nothing about who is asking | Identity, authority, or consent |

**[TRUST-1]** Verifiers and Wallets SHALL NOT treat a signal as proving anything the table says it does not, unless a deployment profile defines that relationship.

**[TRUST-2]** A Wallet that verifies `readerAuth` SHALL classify it as exactly one of: absent; malformed; invalid (the signature or binding fails); valid but untrusted (it verifies, but no trusted certificate or key is recognized); or trusted. It SHALL NOT show the Holder a verifier identity unless the result is trusted.

Certificates at this layer may be self-signed. Valid but untrusted is the normal result when no deployment trust list exists.

Receivers check these signals and report what they find ([RCV-1]). A failed signature or digest check is a warning: it never blocks the exchange by itself. Integrity in transit comes from the HPKE encryption, which fails if the ciphertext is altered.

**Threats**

| Threat | Protection | Not protected |
| --- | --- | --- |
| A malicious page relays a real Verifier's request | The Wallet binds the transcript to the malicious page's origin, so the real Verifier cannot open the response, and the relaying page never had the Verifier's key | The Holder can still be tricked into sharing with the malicious page itself |
| Altering a response in transit | HPKE authenticated encryption: altered ciphertext does not decrypt, and the Verifier fails | — |
| Replaying a captured response to a Verifier | Each session has a fresh key and nonce, so an old ciphertext does not open | — |
| Forging content | SMART Health Card signatures, where present | Raw FHIR content and form answers. Anyone holding a SMART response can wrap it in a new, fully valid mdoc for any session. |
| Third-party scripts on the Verifier's page | None at the protocol layer | Scripts on the calling page can read the private key and the decrypted response |
| A malicious or faulty Wallet | §6.4 validation catches malformed responses | Content the Wallet makes up |

---

## 8. Same-device Presentation Flow

The Verifier sends a §5 request through the W3C Digital Credentials API using the `org-iso-mdoc` protocol. The Wallet returns a §6 response inside an mdoc `DeviceResponse`, encrypted to the Verifier. This is the only presentation flow in version 1.0. §8.7 defines every structure named in the steps below.

```mermaid
sequenceDiagram
    participant V as Verifier
    participant B as Browser / platform
    participant W as Wallet

    V->>V: Build SMART request, ItemsRequest, HPKE key, encryptionInfo
    V->>B: navigator.credentials.get (org-iso-mdoc)
    B->>W: Request, with the caller's origin
    W->>W: Validate request, compute SessionTranscript
    W->>W: Holder chooses; build SMART response
    W->>W: Sign MSO and session; build DeviceResponse
    W->>W: HPKE-encrypt to the Verifier's key
    W-->>B: dcapiResponse
    B-->>V: DigitalCredential
    V->>V: Decrypt, verify signatures and digests, validate (§6.4)
```

### 8.1 Identifiers and constants

| Name | Value |
| --- | --- |
| Request `type` | `smart-health-checkin-request` |
| Response `type` | `smart-health-checkin-response` |
| Request and response `version` | `1` |
| Core selector kinds | `selection.fhir`, `form.fhir` |
| Core media types | `application/fhir+json`, `application/smart-health-card` |
| Status codes | `fulfilled`, `partial`, `unavailable`, `declined`, `unsupported`, `error` |
| Digital Credentials API protocol | `org-iso-mdoc` |
| mdoc `docType` | `org.smarthealthit.checkin.1` |
| mdoc namespace | `org.smarthealthit.checkin` |
| Response element identifier | `smart_health_checkin_response` |
| Request carrier | `ItemsRequest.requestInfo["org.smarthealthit.checkin.request"]` |
| `DeviceRequest` and `DeviceResponse` version | `1.0` |
| Signatures (`readerAuth`, `issuerAuth`, device signature) | ES256: COSE `alg` `-7`, ECDSA P-256 with SHA-256 |
| MSO `digestAlgorithm` | `SHA-256` |
| HPKE | Base mode; KEM DHKEM(P-256, HKDF-SHA256) `0x0010`; KDF HKDF-SHA256 `0x0001`; AEAD AES-128-GCM `0x0001` |

**[MD-1]** Verifiers and Wallets SHALL use the values in this table exactly.

**[ALG-1]** Producers SHALL use exactly these algorithms. Nothing on the wire names or negotiates another one.

**[ALG-2]** A receiver that finds an unknown or unsupported value of `alg`, `kty`, `crv`, or `digestAlgorithm` SHALL treat it as a warning and report the affected check as not verified. The one exception is the recipient key in `encryptionInfo`, which the Wallet needs to respond ([WRQ-7]). A receiver SHALL ignore other map keys it does not know.

### 8.2 Verifier request construction

**[VRQ-0]** The Verifier SHALL build and send a request in these steps, in this order.

1. **[VRQ-1]** Serialize the SMART request (§5) as UTF-8 JSON text.
2. **[VRQ-2]** Build an `ItemsRequest` with `docType` `org.smarthealthit.checkin.1`; `nameSpaces` requesting only the element `smart_health_checkin_response` in namespace `org.smarthealthit.checkin`; and `requestInfo` holding the JSON text, as a CBOR text string, under `org.smarthealthit.checkin.request`. The element's value is `intentToRetain`: set it to `true` if the Verifier may keep the response after the session ends, otherwise `false`.
3. **[VRQ-3]** Compute `ItemsRequestBytes = tag24(CBOR(ItemsRequest))`.
4. **[VRQ-4]** Generate a P-256 HPKE key pair and a nonce of unpredictable random bytes for this request. The nonce SHOULD be at least 16 bytes. The Verifier SHOULD NOT reuse a key pair across requests.
5. **[VRQ-5]** Build `EncryptionInfo = ["dcapi", {"nonce": nonce, "recipientPublicKey": COSE_Key}]`, where the COSE_Key has `1: 2` (EC2), `-1: 1` (P-256), and 32-byte `-2` (x) and `-3` (y). Encode it with CBOR and then base64url, and keep that exact string.
6. **[VRQ-6]** If it uses reader authentication, compute `SessionTranscript` (§8.3) with its own origin, and sign `ReaderAuthenticationBytes` as §8.6 describes.
7. **[VRQ-7]** Build a `DeviceRequest` with `version` `"1.0"` and exactly one `DocRequest`, holding `ItemsRequestBytes` and, if used, `readerAuth`.
8. **[VRQ-8]** Call the Digital Credentials API with `protocol` `org-iso-mdoc` and `data` `{deviceRequest, encryptionInfo}`, both base64url:

   ```js
   navigator.credentials.get({
     mediation: "required",
     digital: { requests: [{ protocol: "org-iso-mdoc", data: { deviceRequest, encryptionInfo } }] }
   })
   ```

9. **[VRQ-9]** Keep the private key and the exact `encryptionInfo` string until the response is processed or the session is abandoned.
10. **[VRQ-10]** The Verifier SHOULD apply its own timeout to the call. On some platforms, a response that is too large never arrives, and the call never settles.

### 8.3 `SessionTranscript`

Both sides compute the same transcript:

```text
dcapiInfo         = CBOR([encryptionInfoBase64url, origin])
Handover          = ["dcapi", SHA-256(dcapiInfo)]
SessionTranscript = [null, null, Handover]
```

**[TR-1]** `encryptionInfoBase64url` SHALL be the exact `encryptionInfo` string the Verifier sent, not a re-encoding of its decoded bytes.

**[TR-2]** For a web page, `origin` SHALL be the ASCII serialization of the calling page's origin: scheme, `://`, host, and `:port` only for a non-default port, with no trailing slash (for example `https://clinic.example`). A Wallet SHALL use this serialization even when its platform delivers the origin in another form, such as a URL with a trailing slash. For a native app, it SHALL be the origin string its platform reports to the Wallet. Where the platform reports none, as Android does for app callers, it SHALL be `android:apk-key-hash:` followed by the base64url SHA-256 of the DER-encoded signing certificate the platform reports for the calling app (its current certificate, if it has a rotation history). Companion platform notes cover each platform.

**[TR-3]** The Wallet SHALL take the origin only from the browser or platform, never from anything in the request.

**[TR-4]** If the platform provides no origin, the Wallet SHALL NOT respond.

**[TR-5]** Both sides SHALL use the same `SessionTranscript` for `readerAuth`, for the HPKE `info`, and for device authentication.

### 8.4 Wallet request handling and response construction

**[WRQ-0]** The Wallet SHALL handle a request in these steps, in this order. **[WRQ-1]** The Wallet SHALL fail (not respond, so that the platform ends the call with an error) only where a step says **fail**. Every other problem is a warning ([RCV-1]).

1. **[WRQ-2]** Decode `deviceRequest` from base64url and CBOR. **Fail** if it cannot be decoded. Warn if the protocol is not `org-iso-mdoc` or the base64url has padding.
2. **[WRQ-3]** Warn if `version` is not `"1.0"` or a later ISO version the Wallet supports.
3. **[WRQ-4]** Find the `DocRequest` whose `ItemsRequest` has `docType` `org.smarthealthit.checkin.1`, ignoring other `docType`s. **Fail** if there is none. If there is more than one, use the first and warn.
4. **[WRQ-5]** Decode `itemsRequest` (`tag24` of an `ItemsRequest`) and take the text string under `requestInfo["org.smarthealthit.checkin.request"]`. **Fail** if it cannot be decoded or has no such text. Warn if `nameSpaces` does not request `smart_health_checkin_response` in namespace `org.smarthealthit.checkin`, or `intentToRetain` is not a boolean.
5. **[WRQ-6]** Parse and validate that text as a SMART request (§§5.1–5.3). **Fail** where §5 says to reject the request. The request is read only from this location, never from element names or other members.
6. **[WRQ-7]** Decode `encryptionInfo` and take its `recipientPublicKey`. **Fail** if it cannot be decoded or has no usable P-256 public key. Warn about any other problem with its shape (§8.7), such as a missing `nonce`.
7. **[WRQ-8]** Compute `SessionTranscript` (§8.3). **Fail** if the platform provides no origin ([TR-4]).
8. **[WRQ-9]** If `readerAuth` is present and the Wallet verifies it, verify it (§8.6) and classify it (§7). The result never makes the Wallet fail.
9. **[WRQ-10]** Let the Holder choose (§5.7), then build the SMART response (§6).

**[WRS-0]** The Wallet SHALL then build the `DeviceResponse` in these steps, in this order.

1. **[WRS-1]** Build an `IssuerSignedItem` with a `digestID`, a `random` of at least 16 random bytes, `elementIdentifier` `smart_health_checkin_response`, and `elementValue` set to the SMART response as UTF-8 JSON text. Compute `IssuerSignedItemBytes = tag24(CBOR(IssuerSignedItem))`.
2. **[WRS-2]** Build the MSO (§8.7) with `version` `"1.0"`, `digestAlgorithm` `"SHA-256"`, and `docType` `org.smarthealthit.checkin.1`. Its `valueDigests` maps namespace `org.smarthealthit.checkin` to `{digestID: SHA-256(IssuerSignedItemBytes)}`. Its `deviceKeyInfo.deviceKey` is the P-256 public key the Wallet will sign the session with.
3. **[WRS-3]** Set the MSO's `validityInfo`: `signed` and `validFrom` to the signing time, and `validUntil` to a later time. Each is a CBOR tag 0 date-time string in UTC, without fractional seconds.
4. **[WRS-4]** Sign `issuerAuth`: a `COSE_Sign1` with protected header `{1: -7}`, `x5chain` (label 33) in the unprotected header with the certificate for the signing key, and payload `MobileSecurityObjectBytes = tag24(CBOR(MSO))`. The certificate may be self-signed.
5. **[WRS-5]** Set `DeviceNameSpacesBytes = tag24(CBOR({}))`, an empty map, unless a deployment profile defines device-signed elements. The SMART response is always the issuer-signed element, never a device-signed one.
6. **[WRS-6]** Sign the session: a `COSE_Sign1` with protected header `{1: -7}` and payload `null`, signed with the private key for `deviceKeyInfo.deviceKey` over the detached payload `DeviceAuthenticationBytes` (§8.6).
7. **[WRS-7]** Build a `DeviceResponse` with `version` `"1.0"`, `status` `0`, and exactly one document holding the issuer-signed item, `issuerAuth`, `DeviceNameSpacesBytes`, and the device signature (§8.7).

### 8.5 HPKE encryption and Verifier processing

**[HPKE-1]** The Wallet SHALL encrypt `CBOR(DeviceResponse)` with HPKE base mode, using the suite in §8.1, to `recipientPublicKey`, with `info = CBOR(SessionTranscript)` and an empty `aad`. `enc` is the 65-byte uncompressed P-256 public key.

**[HPKE-2]** The Wallet SHALL return `dcapiResponse = ["dcapi", {"enc": enc, "cipherText": ciphertext}]`, encoded with CBOR and then base64url, as `data.response` of a result whose `protocol` is `org-iso-mdoc`. It SHALL NOT return the `DeviceResponse` or the SMART response unencrypted.

**[VRS-0]** The Verifier SHALL process the result in these steps, in this order. **[VRS-1]** The Verifier SHALL reject the whole response only where a step says **fail**. Every other problem is a warning ([RCV-1]).

1. **[VRS-2]** Decode `data.response` from base64url and CBOR as `["dcapi", {enc, cipherText}]`. **Fail** if it cannot be decoded or lacks `enc` or `cipherText`. Warn if `protocol` is not `org-iso-mdoc` or the base64url has padding.
2. **[VRS-3]** Compute `SessionTranscript` from its own origin and the exact `encryptionInfo` string it sent, and open the ciphertext with its retained private key. **Fail** if it does not open.
3. **[VRS-4]** Decode the `DeviceResponse` and find the document with `docType` `org.smarthealthit.checkin.1`. **Fail** if it cannot be decoded or has no such document. Warn if `version` is not `"1.0"`, `status` is not `0`, or there is more than one document; use the first matching one.
4. **[VRS-5]** Verify `issuerAuth` with the public key of the first certificate in its `x5chain`, check the MSO fields (§8.7), and check that the MSO's `docType` matches the document's. Warn on any failure. Applying a trust policy to the certificate is optional (§7).
5. **[VRS-6]** Check that SHA-256 of the issuer-signed item's `IssuerSignedItemBytes`, as received, equals the MSO's `valueDigests` entry for its `digestID`. Warn if not.
6. **[VRS-7]** Rebuild `DeviceAuthenticationBytes` and verify the device signature over them with `deviceKeyInfo.deviceKey`. Warn if it does not verify, or if the signature carries a payload that differs from the rebuilt bytes.
7. **[VRS-8]** Find the issuer-signed item whose `elementIdentifier` is `smart_health_checkin_response`. **Fail** if there is none or its `elementValue` is not a text string.
8. **[VRS-9]** Parse the text as a SMART response and validate it (§6.4). **Fail** where §6.4 rejects the whole response ([XV-1], [XV-2]).

**[VRS-10]** The Verifier SHALL warn if the MSO `validityInfo` does not include the current time, allowing for a few minutes of clock difference.

### 8.6 Encoding rules and signed bytes

Both sides produce identical bytes for everything that is hashed or signed by following these rules.

**[ENC-1]** Structures that both sides build independently (`dcapiInfo`, `SessionTranscript`, `ReaderAuthentication`, `DeviceAuthentication`, and each COSE `Sig_structure`) SHALL be encoded with RFC 8949 preferred serialization and definite lengths.

**[ENC-2]** Transmitted bytes that are signed or hashed (`ItemsRequestBytes`, `IssuerSignedItemBytes`, `MobileSecurityObjectBytes`, `DeviceNameSpacesBytes`, and COSE protected headers) SHALL be hashed and verified exactly as received, never decoded and re-encoded.

**[ENC-3]** Senders SHALL put `x5chain` (label 33) in the COSE unprotected header. Receivers SHALL accept it either as one certificate byte string or as an array of certificate byte strings, leaf first.

**[ENC-4]** Every COSE signature in this profile SHALL use an empty external AAD.

**[ENC-5]** Producers SHALL NOT produce a CBOR map with a duplicate key. A receiver whose decoder cannot process such a map fails at the step that decodes it; otherwise it SHALL warn.

| Output | Algorithm | Covers these bytes |
| --- | --- | --- |
| `Handover[1]` | SHA-256 | `dcapiInfo` |
| HPKE ciphertext | HPKE, §8.1 suite | `CBOR(DeviceResponse)`, with `info = CBOR(SessionTranscript)` |
| `readerAuth` | ES256, detached | `ReaderAuthenticationBytes = tag24(CBOR(["ReaderAuthentication", SessionTranscript, ItemsRequestBytes]))` |
| MSO value digest | SHA-256 | `IssuerSignedItemBytes`, including the tag |
| `issuerAuth` | ES256, attached | `MobileSecurityObjectBytes` |
| Device signature | ES256, detached | `DeviceAuthenticationBytes = tag24(CBOR(["DeviceAuthentication", SessionTranscript, docType, DeviceNameSpacesBytes]))` |

`SessionTranscript` appears inside `ReaderAuthentication` and `DeviceAuthentication` as the array itself, not as a byte string. The detached signatures use `payload = null` in the `COSE_Sign1` and the bytes shown as the payload of the `Sig_structure`.

**[RA-1]** A Verifier that sends `readerAuth` SHALL sign it with protected header `{1: -7}`, payload `null`, and `x5chain` holding at least the signing certificate, over a `ReaderAuthenticationBytes` computed for this session and these exact `ItemsRequestBytes`. It SHALL NOT reuse a `readerAuth` in another request.

**[RA-2]** A Wallet that verifies `readerAuth` SHALL check the algorithm, rebuild `ReaderAuthenticationBytes` from its own `SessionTranscript` and the received `ItemsRequestBytes`, and verify the signature with the first certificate's key.

### 8.7 Message structures

This CDDL is normative. It uses ISO/IEC 18013-5 names and adds this profile's fixed values. It describes what producers build. A receiver that finds a structure not matching it follows §§8.4–8.5: it fails only where a step says so, and otherwise warns. `* key => any` marks where unknown keys may appear and are ignored ([ALG-2]).

The Digital Credentials API request and result, in JSON:

```json
{ "protocol": "org-iso-mdoc", "data": { "deviceRequest": "<base64url>", "encryptionInfo": "<base64url>" } }
{ "protocol": "org-iso-mdoc", "data": { "response": "<base64url>" } }
```

```cddl
DeviceRequest = {
  "version" => "1.0",
  "docRequests" => [ + DocRequest ],   ; exactly one with this profile's docType
  * tstr => any
}

DocRequest = {
  "itemsRequest" => ItemsRequestBytes,
  ? "readerAuth" => DetachedSign1,
  * tstr => any
}

ItemsRequestBytes = #6.24(bstr .cbor ItemsRequest)

ItemsRequest = {
  "docType" => "org.smarthealthit.checkin.1",
  "nameSpaces" => {
    "org.smarthealthit.checkin" => { "smart_health_checkin_response" => bool }  ; intentToRetain
  },
  "requestInfo" => {
    "org.smarthealthit.checkin.request" => tstr,   ; SMART request, UTF-8 JSON text
    * tstr => any
  },
  * tstr => any
}
```

```cddl
EncryptionInfo = [
  "dcapi",
  {
    "nonce" => bstr,
    "recipientPublicKey" => P256PublicKey,
    * tstr => any
  }
]

P256PublicKey = {        ; COSE_Key
  1 => 2,                ; kty: EC2
  -1 => 1,               ; crv: P-256
  -2 => bstr .size 32,   ; x
  -3 => bstr .size 32,   ; y
  * int => any
}

SessionTranscript = [ null, null, Handover ]
Handover = [ "dcapi", bstr .size 32 ]   ; SHA-256(dcapiInfo)

ReaderAuthentication = [ "ReaderAuthentication", SessionTranscript, ItemsRequestBytes ]
ReaderAuthenticationBytes = #6.24(bstr .cbor ReaderAuthentication)
```

```cddl
DcapiResponse = [
  "dcapi",
  {
    "enc" => bstr .size 65,   ; uncompressed P-256 point
    "cipherText" => bstr,     ; AES-128-GCM ciphertext with tag
    * tstr => any
  }
]

DeviceResponse = {
  "version" => "1.0",
  "documents" => [ Document ],   ; exactly one
  "status" => 0,
  * tstr => any
}

Document = {
  "docType" => "org.smarthealthit.checkin.1",
  "issuerSigned" => {
    "nameSpaces" => { "org.smarthealthit.checkin" => [ IssuerSignedItemBytes ] },
    "issuerAuth" => AttachedSign1,   ; payload: MobileSecurityObjectBytes
    * tstr => any
  },
  "deviceSigned" => {
    "nameSpaces" => DeviceNameSpacesBytes,
    "deviceAuth" => { "deviceSignature" => DetachedSign1 },
    * tstr => any
  },
  * tstr => any
}

IssuerSignedItemBytes = #6.24(bstr .cbor IssuerSignedItem)
IssuerSignedItem = {
  "digestID" => uint,
  "random" => bstr,              ; at least 16 bytes
  "elementIdentifier" => "smart_health_checkin_response",
  "elementValue" => tstr,        ; SMART response, UTF-8 JSON text
}

MobileSecurityObjectBytes = #6.24(bstr .cbor MobileSecurityObject)
MobileSecurityObject = {
  "version" => "1.0",
  "digestAlgorithm" => "SHA-256",
  "valueDigests" => { "org.smarthealthit.checkin" => { uint => bstr .size 32 } },
  "deviceKeyInfo" => { "deviceKey" => P256PublicKey, * tstr => any },
  "docType" => "org.smarthealthit.checkin.1",
  "validityInfo" => {
    "signed" => tdate,
    "validFrom" => tdate,
    "validUntil" => tdate,
    * tstr => any
  },
  * tstr => any
}

DeviceNameSpacesBytes = #6.24(bstr .cbor DeviceNameSpaces)
DeviceNameSpaces = { * tstr => any }   ; empty unless a deployment profile defines elements

DeviceAuthentication = [
  "DeviceAuthentication",
  SessionTranscript,
  "org.smarthealthit.checkin.1",
  DeviceNameSpacesBytes
]
DeviceAuthenticationBytes = #6.24(bstr .cbor DeviceAuthentication)
```

`tdate` is CBOR tag 0 over an RFC 3339 date-time string. The two signature forms are `COSE_Sign1` (RFC 9052) with the payload present or `null`:

```cddl
AttachedSign1 = [ protected: bstr, unprotected: { * int => any }, payload: bstr, signature: bstr ]
DetachedSign1 = [ protected: bstr, unprotected: { * int => any }, payload: null, signature: bstr ]
```

---

## 9. Security, Privacy, Extension Points, and Internationalization

### 9.1 Security considerations

§7 lists what each signal proves and the threats the protocol does and does not address. In addition:

- A response can be opened only with the private key of the session that asked, so a Verifier's private key is as sensitive as the response itself. Anything able to run script on the Verifier's page can read both.
- Nothing in the protocol stops a party that holds an old SMART response from presenting it again in a new, valid session. Where that matters, rely on signed content such as SMART Health Cards, or on deployment controls.
- Request ids, item ids, and Artifact ids correlate messages; they are not secrets and give no freshness.

**[SEC-1]** The Verifier SHOULD NOT act on a response for a session it has already completed or abandoned.

### 9.2 Privacy considerations

Many workflows should ask for narrow items; some legitimately need broad ones. Statuses other than `fulfilled` are normal outcomes, and a Verifier cannot infer clinical facts from them.

**[PRIV-1]** Verifiers and Wallets SHOULD NOT put patient identifiers, account numbers, secrets, predictable sequences, or clinical facts in request ids, item ids, or Artifact ids, since these appear in logs.

**[PRIV-2]** Routine telemetry SHOULD record counts and categories, not request or response content, keys, tokens, full URLs, or Holder decisions. Full payloads belong only in controlled diagnostic or incident-response records.

### 9.3 Identifiers and extension points

Extensions can add selector kinds and Artifact media types. A profile identifier is never a request field; a request always says what it wants with selectors.

**[EXT-1]** An extension that defines a selector kind SHALL define its `kind` string, its members and their meaning, how it interacts with `accept[]` and `fhirVersions[]`, which statuses it uses and when, its security and privacy considerations, and at least one example.

**[EXT-2]** An extension that defines an Artifact media type SHALL define its media type string, its Artifact members, how to validate it, how it handles FHIR versions (if at all), and its security and privacy considerations.

**[EXT-3]** An extension SHALL NOT change the meaning of core members, core selector kinds, status codes, Holder control, or the validation in §6.4, and SHALL NOT define a catch-all Artifact type with generic payload members.

**[PROF-1]** A deployment profile that adds trust requirements SHALL state which targets it constrains; which trust signals become mandatory; the certificates, keys, allow-lists, or provenance mechanisms it accepts; its freshness and revocation expectations; how Wallets show trusted and untrusted verifiers to the Holder; and what happens when a presentation is valid but fails its trust policy.

A future change to the mdoc carrier that older software cannot process will use a new `docType`.

### 9.4 Internationalization

Display text includes `purpose`, `title`, `summary`, `message`, Questionnaire text, and FHIR displays. Identifiers, status codes, selector kinds, media types, canonicals, and mdoc names are protocol values and are never localized. This version defines no language negotiation.

**[I18N-1]** Translating, reordering, or normalizing display text SHALL NOT change any protocol value, or any bytes that are signed, hashed, or encrypted.

**[I18N-2]** Language tags attached to display text SHOULD be well-formed BCP 47 tags.

**[I18N-3]** Wallet and Verifier user interfaces SHALL NOT let display text from the other party imitate or hide origins, identities, identifiers, statuses, trust indicators, or controls, including through Unicode bidirectional characters.

**[I18N-4]** They SHOULD keep such text visually separate from those elements.

---

## Appendix A. Worked example

This appendix follows one real capture, `fixtures/*/android-chrome-capture`: Chrome on Android, with the reference Android wallet 0.3.6. `scripts/worked-example.ts` computes every value below from the fixture files and checks each step; the build fails if this text and the fixture disagree. The capture's HPKE private key is published with it so anyone can repeat each step.

<!-- BEGIN worked-example (generated by scripts/worked-example.ts; do not edit by hand) -->

**1. The request.** The Verifier at `http://127.0.0.1:3010` sent this `encryptionInfo` (base64url, 190 characters):

```text
gmVkY2FwaaJlbm9uY2VYIPYWYWk-rPkMTfljh2ux1_P-Q1kpwcDtsBKCkBS0IHWZcnJlY2lwaWVudFB1YmxpY0tleaQBAiABIVgg8CaGEhavZJEXKE3i8NCRJi_EZvjca6GG2s486h_Pp4wiWCAB_jZsoAWB1obhVPxvg67w1eAJq9laeKTIc6EGF8yDvA
```

Decoded, it is:

```text
["dcapi", {"nonce": h'f61661693eacf90c4df963876bb1d7f3fe435929c1c0edb012829014b4207599', "recipientPublicKey": {1: 2, -1: 1, -2: h'f026861216af649117284de2f0d091262fc466f8dc6ba186dace3cea1fcfa78c', -3: h'01fe366ca00581d686e154fc6f83aef0d5e009abd95a78a4c873a10617cc83bc'}}]
```

**2. `dcapiInfo` and the handover** (§8.3). `dcapiInfo = CBOR([encryptionInfoBase64url, origin])` is 215 bytes, and its SHA-256 is the handover's second element:

```text
dcapiInfo          8278be676d566b5932467761614a6c626d39755932565949… (215 bytes)
SHA-256(dcapiInfo) 5d373e34bbc5306ff28c944c2a1af663af3d503e179ed3ce9df0aa610a7ffe72
```

**3. `SessionTranscript`.** `CBOR([null, null, ["dcapi", hash]])` is 44 bytes. It is the HPKE `info`, and it appears as an array inside `ReaderAuthentication` and `DeviceAuthentication`:

```text
83f6f68265646361706958205d373e34bbc5306ff28c944c2a1af663af3d503e179ed3ce9df0aa610a7ffe72
```

**4. Reader authentication** (§8.6). `ItemsRequestBytes` is 2127 bytes (`d81859084aa3…`: tag 24, then a byte string). `ReaderAuthenticationBytes` is 2198 bytes, and `readerAuth` has payload `null` with `x5chain` in its unprotected header as an array holding one certificate. Its ES256 signature over those bytes verifies.

**5. Encryption** (§8.5). The Wallet's `dcapiResponse` holds a 65-byte `enc` and a 23252-byte `cipherText`:

```text
enc 040c650525c0970c0f4780dd7c40ebd13044bb36963a1f5b05488845cdabf8a75b84984a5eda47dd9730ebbb3459adc3234afd35ed4ad2fc577210cdd579d05ad2
```

Opening it with the capture's private key and `info = CBOR(SessionTranscript)` yields the 23236-byte `DeviceResponse`.

**6. The issuer-signed item and its digest** (§8.4). `IssuerSignedItemBytes` is 22208 bytes, with `digestID` 0, a 16-byte `random`, and a 22103-character `elementValue`. SHA-256 over all of it, tag included, equals the MSO's `valueDigests` entry for digestID 0:

```text
SHA-256(IssuerSignedItemBytes) 635c38c6b0909ef9ac74210fe95e58b7ef40692e9b88cc30a9dcb68fe45aa207
```

**7. The MSO and `issuerAuth`.** `issuerAuth` has protected header `a10126` (`{1: -7}`), `x5chain` in its unprotected header as an array holding one certificate, and an attached 364-byte `MobileSecurityObjectBytes` payload. The MSO holds:

```text
version          "1.0"
digestAlgorithm  "SHA-256"
docType          "org.smarthealthit.checkin.1"
validityInfo     signed 0("2026-09-26T13:14:53Z")
                 validFrom 0("2026-09-26T13:14:53Z")
                 validUntil 0("2026-09-27T13:14:53Z")
deviceKey        kty 2, crv 1, x 2e7d50152089600b…
```

**8. Device authentication.** `DeviceNameSpacesBytes` is `d81841a0` (tag 24 around an empty map). `DeviceAuthenticationBytes` is 103 bytes; the device signature has payload `null` and verifies over them with the MSO's `deviceKey`. Rebuilt with a different origin, the same signature fails.

**9. The SMART response.** The `elementValue` parses as a SMART response with `requestId` `demo-us-core-checkin`, 4 Artifacts, and 4 status entries.

<!-- END worked-example -->

---

## References and companion material

### Normative references

- **[RFC2119]** Bradner, S. *Key words for use in RFCs to Indicate Requirement Levels*. BCP 14, RFC 2119.
- **[RFC8174]** Leiba, B. *Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words*. BCP 14, RFC 8174.
- **[RFC3339]** Klyne, G. and C. Newman. *Date and Time on the Internet: Timestamps*. RFC 3339.
- **[RFC4648]** Josefsson, S. *The Base16, Base32, and Base64 Data Encodings*. RFC 4648.
- **[RFC7515]** Jones, M., Bradley, J., and N. Sakimura. *JSON Web Signature (JWS)*. RFC 7515.
- **[RFC8259]** Bray, T. *The JavaScript Object Notation (JSON) Data Interchange Format*. RFC 8259.
- **[RFC8610]** Birkholz, H., Vigano, C., and C. Bormann. *Concise Data Definition Language (CDDL)*. RFC 8610.
- **[RFC8949]** Bormann, C. and P. Hoffman. *Concise Binary Object Representation (CBOR)*. RFC 8949.
- **[RFC9052]** Schaad, J. *CBOR Object Signing and Encryption (COSE): Structures and Process*. RFC 9052.
- **[RFC9053]** Schaad, J. *CBOR Object Signing and Encryption (COSE): Initial Algorithms*. RFC 9053.
- **[RFC9180]** Barnes, R., Bhargavan, K., Lipp, B., and C. Wood. *Hybrid Public Key Encryption*. RFC 9180.
- **[RFC9360]** Schaad, J. *CBOR Object Signing and Encryption (COSE): Header Parameters for Carrying and Referencing X.509 Certificates*. RFC 9360.
- **[ISO18013-5]** ISO/IEC 18013-5. *Personal identification — ISO-compliant driving licence — Part 5: Mobile driving licence application*.
- **[ISO18013-7]** ISO/IEC TS 18013-7. *Mobile driving licence add-on functions*, Annex C (Digital Credentials API).
- **[W3C-DC-API]** W3C. *Digital Credentials API*.
- **[HTML-ORIGIN]** WHATWG. *HTML Standard*, "ASCII serialization of an origin".
- **[FHIR-R4]** HL7. *FHIR Release 4, Version 4.0.1*.
- **[SMART-HEALTH-CARDS]** SMART Health IT. *SMART Health Cards Framework*.

### Informative references

- **[OpenID4VP]** OpenID Foundation. *OpenID for Verifiable Presentations*.
- **[US-CORE]** HL7. *US Core Implementation Guide*.
- **[CARIN-BB]** HL7. *CARIN Consumer Directed Payer Data Exchange Implementation Guide*.
- **[SMART-APP-LAUNCH]** SMART Health IT. *SMART App Launch Framework*.

### Companion material

Companion material is non-normative. It is maintained at:

- [Model explainer](https://smart-health-checkin.org/spec/smart-model-explainer.html): the request and response JSON, with one worked example.
- [Wire protocol explainer](https://smart-health-checkin.org/spec/wire-protocol-explainer.html) and [capture inspector](https://smart-health-checkin.org/spec/wire-protocol-inspector.html): how the same-device flow builds, seals, and verifies each structure, over real captured bytes.
- [Kiosk flow](https://smart-health-checkin.org/spec/kiosk-flow-explainer.html): the front-desk hand-off to a patient's phone.
- [Trust and limits](https://smart-health-checkin.org/spec/trust-and-limits.html): what the signatures prove, receiver warnings, reader authentication, response size, cancel, and timeouts.
- [Platform notes](https://smart-health-checkin.org/spec/platform-notes.html): Android, iOS, and desktop browsers, native-app origins ([TR-2]), and what has been tested.
- [Fixtures](https://github.com/smart-health-checkin/spec/tree/main/fixtures), [conformance cases](https://github.com/smart-health-checkin/spec/tree/main/conformance), and [developer tools](https://github.com/smart-health-checkin/spec/tree/main/tools): captured and generated bytes (tagged `fixtures-vN`), test cases citing the requirement IDs above, and scripts that inspect them.
- [`requirements.json`](https://github.com/smart-health-checkin/spec/blob/main/requirements.json): every requirement ID with its section, actor, and summary.
- [Design rationale](https://github.com/smart-health-checkin/spec/blob/main/docs/rationale.md): why the protocol looks the way it does.
- [JavaScript client library and developer docs](https://smart-health-checkin.org/client/) ([source](https://github.com/smart-health-checkin/client)), the [Android wallet](https://github.com/smart-health-checkin/android-wallet), and the [Swift package](https://github.com/smart-health-checkin/swift).
- [Connectathon](https://smart-health-checkin.org/connectathon/): test scenarios, the Testing EHR, and the SMART Testing Wallet.
