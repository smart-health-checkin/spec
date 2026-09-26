// Generates conformance/: small, single-capability test cases that every
// implementation runs (see conformance/README.md for the case format).
//
//   bun tools/conformance/generate.ts
//
// Positive cases come from the real Chrome/Android capture and from
// synthetic requests and mdocs built here with keys we control. Every negative
// case is ONE deliberate mutation of a positive one, made by code below, never
// by hand-editing bytes. Expected results follow the decisions in the
// spec's requirements (requirements.json), not what any
// implementation currently does. `rule` cites both.
//
// Signatures use fresh random keys, so re-running changes bytes but not
// meaning. Commit the output; re-run only when adding or changing cases.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CborTag,
  MDOC_DOC_TYPE,
  MDOC_NAMESPACE,
  SMART_REQUEST_INFO_KEY,
  SMART_RESPONSE_ELEMENT_ID,
  arrayBufferCopy,
  base64UrlDecodeBytes,
  base64UrlEncodeBytes,
  buildDcapiSessionTranscript,
  buildDeviceAuthenticationBytes,
  buildEncryptionInfoBytes,
  buildOrgIsoMdocRequest,
  cborDecode,
  cborEncode,
  createEphemeralReaderIdentity,
  hex,
  hpkeSealDirectMdoc,
  publicJwkToCoseKey,
  sha256,
} from "@smart-health-checkin/client/wire";

const ROOT = join(import.meta.dir, "../..");
const OUT = join(ROOT, "conformance");
const CAPTURE_REQ = join(ROOT, "fixtures/dcapi-requests/android-chrome-capture");
const CAPTURE_RESP = join(ROOT, "fixtures/responses/android-chrome-capture");

type Outcome = "accept" | "warn" | "reject" | "warn-or-reject";
type Expected = {
  /** Input shorthand: accept (true) or reject (false). The manifest carries `outcome` instead. */
  valid: boolean;
  /** accept; warn = accept and ideally report `warnings`; reject; warn-or-reject = either is conformant (ENC-5). */
  outcome?: Outcome;
  /** Warning codes a receiver should report (advisory, RCV-1). */
  warnings?: string[];
  /** Short code naming why a case is invalid. Documentation; runners need not match it. */
  reason?: string;
  /** Per-Artifact outcome when some Artifacts are disregarded but the response stands (XV-4). */
  artifacts?: Record<string, "accepted" | "rejected">;
  /** Per-item outcome when an item is affected but the request or response stands:
   *  "unsupported" (request side: SEL-8, SEL-9, SEL-10, FORM-1) or "unknown" (response side: XV-3). */
  items?: Record<string, "unsupported" | "unknown">;
  /** Output files an implementation must reproduce byte for byte (transcript, hpke-open, request-cbor). */
  outputs?: Record<string, string>;
};
type Case = {
  id: string;
  capability: string;
  description: string;
  inputs: Record<string, string>;
  expected: Expected;
  /** The requirement ids (spec-rewrite requirements.json) and plan decisions the expectation follows. */
  rule: string;
  /** Just the requirement ids from `rule`. */
  requirements: string[];
  /** "pending" = the expected result waits on a spec decision; runners skip it. */
  status: "active" | "pending";
  pendingOn?: string;
};

// Start clean: remove the generated case folders, keeping hand-written files
// (README.md, reference/).
const CASE_FOLDERS = ["request-json", "response-json", "cross-validation", "request-cbor", "transcript", "hpke-open", "mdoc-verify", "wallet-response"];
mkdirSync(OUT, { recursive: true });
for (const e of readdirSync(OUT, { withFileTypes: true })) if (e.isDirectory() && CASE_FOLDERS.includes(e.name)) rmSync(join(OUT, e.name), { recursive: true });

const cases: Case[] = [];
/** §8 receivers accept these and warn (RCV-0..2). */
const WARN = (code: string): Expected => ({ valid: true, outcome: "warn", warnings: [code] });
const enc = new TextEncoder();

function write(path: string, content: string | Uint8Array) {
  const full = join(OUT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return path;
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function add(c: Omit<Case, "id" | "requirements" | "status"> & { slug: string; status?: Case["status"]; pendingOn?: string }) {
  const { slug, status, pendingOn, ...rest } = c;
  const requirements = c.rule.split(/[\s,;]+/).filter((t) => /^[A-Z0-9]+-\d+$/.test(t));
  const { valid, outcome, ...expectedRest } = c.expected;
  const expected = { outcome: outcome ?? (valid ? "accept" : "reject"), ...expectedRest } as unknown as Expected;
  cases.push({ id: `${c.capability}/${slug}`, ...rest, expected, requirements, status: status ?? "active", ...(pendingOn ? { pendingOn } : {}) });
}

/** Write each input under the case's folder; strings ending .json are written as given. */
function files(capability: string, slug: string, entries: Record<string, string | Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, [name, content]] of Object.entries(entries).map(([k, v]) => [k, [fileName(k, v), v]] as const)) {
    out[key] = write(`${capability}/${slug}/${name}`, content as string | Uint8Array);
  }
  return out;
}
function fileName(key: string, v: string | Uint8Array): string {
  const known: Record<string, string> = {
    request: "request.json", response: "response.json", navigatorArgument: "navigator-argument.json",
    credential: "credential.json", recipientPrivateJwk: "recipient-private.jwk.json",
    deviceResponse: "device-response.cbor", sessionTranscript: "session-transcript.cbor",
    origin: "origin.txt", encryptionInfo: "encryption-info.b64u.txt", now: "now.txt",
    smartRequest: "smart-request.json", smartResponse: "smart-response.json",
  };
  return known[key] ?? `${key}${typeof v === "string" ? ".txt" : ".bin"}`;
}

const read = (p: string) => readFileSync(p, "utf8");
/** Standard "=" padding for a base64url string whose length needs it. */
function padded(b64u: string): string {
  if (b64u.length % 4 === 0) throw new Error("no padding possible at this length");
  return b64u + "=".repeat(4 - (b64u.length % 4));
}
const readBytes = (p: string) => new Uint8Array(readFileSync(p));

// ---------------------------------------------------------------- base JSON

const captureRequestText = read(join(CAPTURE_REQ, "smart-request.json"));
const captureRequest = JSON.parse(captureRequestText);
const captureResponse = JSON.parse(read(join(CAPTURE_RESP, "smart-response.json")));
// The capture stores the platform's `digital` member; cases carry the whole navigator.credentials.get argument.
const captureNavigatorArgument = (() => {
  const a = JSON.parse(read(join(CAPTURE_REQ, "navigator-credentials-get.arg.json")));
  return a.digital ? a : { mediation: "required", digital: a };
})();

const item = (over: Record<string, unknown> = {}) => ({
  id: "patient",
  title: "Patient demographics",
  content: { kind: "selection.fhir", profiles: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"] },
  accept: ["application/fhir+json"],
  ...over,
});
const request = (items: unknown[], over: Record<string, unknown> = {}) => ({
  type: "smart-health-checkin-request",
  version: "1",
  id: "conformance-request",
  purpose: "Clinic check-in",
  fhirVersions: ["4.0.1"],
  items,
  ...over,
});
const PHQ2 = "https://smart-health-checkin.org/connectathon/Questionnaire/phq-2.json";
const formItem = (content: Record<string, unknown>) =>
  item({ id: "intake", title: "Intake form", content: { kind: "form.fhir", ...content } });

// ---------------------------------------------------------------- request-json

{
  const cap = "request-json";
  const ok = (slug: string, description: string, req: unknown, rule: string, items?: Expected["items"], text?: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { request: text ?? json(req) }), expected: { valid: true, ...(items ? { items } : {}) } });
  const bad = (slug: string, description: string, req: unknown, reason: string, rule: string, text?: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { request: text ?? json(req) }), expected: { valid: false, reason } });
  const both = (extra: unknown) => request([extra, item({ id: "patient2" })]);

  ok("capture", "The request from the real Chrome/Android capture.", null, "REQ-1, REQ-2", undefined, captureRequestText);
  ok("minimal", "One selection.fhir item with an exact profile.", request([item()]), "REQ-2");
  ok("no-filters", "selection.fhir with no filter arrays: the wallet decides.", request([item({ content: { kind: "selection.fhir" } })]), "SEL-7");
  ok("empty-items", "An empty items array is valid (items SHOULD be non-empty).", request([]), "REQ-3");
  ok("no-fhir-versions", "fhirVersions is optional.", request([item()], { fhirVersions: undefined }), "REQ-5");
  ok("empty-fhir-versions", "fhirVersions may be an empty array.", request([item()], { fhirVersions: [] }), "REQ-2, REQ-5");
  ok("form-canonical", "form.fhir by questionnaireCanonical.", request([formItem({ questionnaireCanonical: PHQ2 })]), "FORM-4");
  ok("form-versioned-canonical", "form.fhir by a versioned canonical (url|version).", request([formItem({ questionnaireCanonical: `${PHQ2}|1` })]), "CAN-1, CAN-4");
  ok("form-inline", "form.fhir with an inline Questionnaire.", request([formItem({ questionnaire: { resourceType: "Questionnaire", status: "active", item: [{ linkId: "q", text: "Why?", type: "string" }] } })]), "FORM-2");
  ok("profiles-from", "selection.fhir by profile family narrowed by resourceTypes.", request([item({ content: { kind: "selection.fhir", profilesFrom: ["http://hl7.org/fhir/us/core"], resourceTypes: ["Condition"] } })]), "SEL-3");
  ok("unknown-kind", "An unknown content.kind: the request stands; that item is unsupported.", both(item({ id: "x", content: { kind: "example.extension", anything: 1 } })), "SEL-9", { x: "unsupported" });
  ok("unknown-selector-members-ignored", "Unknown selector members (here canonical and resource) are ignored.", request([item({ content: { kind: "selection.fhir", profiles: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"], canonical: "x", resource: "Patient" } })]), "JSON-3");
  ok("unknown-top-member", "Unknown top-level members are ignored.", request([item()], { futureThing: { a: 1 } }), "JSON-3");
  // Problems inside content affect only that item (REQ-2): the request stands, the item is unsupported.
  ok("mixed-form-with-profiles", "form.fhir that also carries profiles: that item is unsupported.", both(formItem({ questionnaireCanonical: PHQ2, profiles: ["http://example.org/p"] })), "FORM-1, REQ-2", { intake: "unsupported" });
  ok("mixed-selection-with-questionnaire", "selection.fhir that also carries questionnaireCanonical: that item is unsupported.", both(item({ content: { kind: "selection.fhir", questionnaireCanonical: PHQ2 } })), "SEL-8, REQ-2", { patient: "unsupported" });
  ok("form-no-source", "form.fhir with neither questionnaire nor questionnaireCanonical: that item is unsupported.", both(formItem({})), "FORM-1, REQ-2", { intake: "unsupported" });
  ok("questionnaire-wrong-type", "The inline questionnaire is a Patient: that item is unsupported.", both(formItem({ questionnaire: { resourceType: "Patient" } })), "FORM-1, REQ-2", { intake: "unsupported" });
  ok("canonical-not-string", "questionnaireCanonical is a number: that item is unsupported.", both(formItem({ questionnaireCanonical: 7 })), "SEL-10, REQ-2", { intake: "unsupported" });
  ok("blank-canonical", "questionnaireCanonical is an empty string (NonEmptyString): that item is unsupported.", both(formItem({ questionnaireCanonical: "" })), "SEL-10, REQ-2", { intake: "unsupported" });
  ok("profiles-from-string", "profilesFrom is a string, not an array: that item is unsupported.", both(item({ content: { kind: "selection.fhir", profilesFrom: "http://hl7.org/fhir/us/core" } })), "SEL-10, REQ-2", { patient: "unsupported" });
  ok("empty-profiles", "profiles is an empty array (NonEmptyArray): that item is unsupported.", both(item({ content: { kind: "selection.fhir", profiles: [] } })), "SEL-10, REQ-2", { patient: "unsupported" });
  ok("empty-resource-types", "resourceTypes is an empty array (NonEmptyArray): that item is unsupported.", both(item({ content: { kind: "selection.fhir", resourceTypes: [] } })), "SEL-10, REQ-2", { patient: "unsupported" });

  bad("wrong-type", "type is not smart-health-checkin-request.", request([item()], { type: "something-else" }), "request-type", "REQ-2");
  bad("version-number", "version is the number 1, not the string \"1\".", request([item()], { version: 1 }), "request-version", "REQ-2, JSON-1");
  bad("missing-id", "No request id.", request([item()], { id: undefined }), "request-id", "REQ-2");
  bad("missing-item-id", "An item without an id.", request([item({ id: undefined })]), "item-id", "ITEM-2");
  bad("duplicate-item-ids", "Two items share an id.", request([item(), item()]), "item-id-duplicate", "ITEM-2");
  bad("missing-title", "An item without a title.", request([item({ title: undefined })]), "item-title", "REQ-2");
  bad("empty-accept", "An item with an empty accept list.", request([item({ accept: [] })]), "item-accept", "REQ-2");
  bad("content-not-object", "An item whose content is a string.", request([item({ content: "selection.fhir" })]), "content", "REQ-2");
  bad("content-kind-not-string", "An item whose content.kind is a number.", request([item({ content: { kind: 1 } })]), "content", "REQ-2");
  {
    const text = `{\n  "type": "smart-health-checkin-request",\n  "version": "1",\n  "id": "first",\n  "id": "second",\n  "items": ${JSON.stringify([item()])}\n}\n`;
    bad("duplicate-member", "The JSON text has the member id twice.", null, "json-duplicate-member", "JSON-2", text);
  }
}

// ---------------------------------------------------------------- response-json

const artifactFhir = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  mediaType: "application/fhir+json",
  fhirVersion: "4.0.1",
  fulfills: ["patient"],
  value: { resourceType: "Patient", meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"] }, name: [{ family: "Okafor" }] },
  ...over,
});
const response = (artifacts: unknown[], status: unknown[], over: Record<string, unknown> = {}) => ({
  type: "smart-health-checkin-response",
  version: "1",
  requestId: "conformance-request",
  artifacts,
  requestStatus: status,
  ...over,
});
const fulfilled = (id = "patient") => ({ item: id, status: "fulfilled" });
const SHC = { verifiableCredential: ["eyJ6aXAiOiJERUYiLCJhbGciOiJFUzI1NiIsImtpZCI6ImsifQ.eyJ4IjoxfQ.c2ln"] };

{
  const cap = "response-json";
  const ok = (slug: string, description: string, resp: unknown, rule: string, extra: Partial<Expected> = {}, text?: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { response: text ?? json(resp) }), expected: { valid: true, ...extra } });
  const bad = (slug: string, description: string, resp: unknown, reason: string, rule: string, text?: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { response: text ?? json(resp) }), expected: { valid: false, reason } });

  ok("capture", "The response from the real capture.", captureResponse, "RSP-1");
  ok("minimal", "One FHIR Patient Artifact.", response([artifactFhir()], [fulfilled()]), "RSP-1");
  ok("declined-no-artifacts", "Everything declined, no Artifacts.", response([], [{ item: "patient", status: "declined" }]), "RSP-2, HOLD-4");
  ok("health-card", "A SMART Health Card Artifact.", response([{ id: "c1", mediaType: "application/smart-health-card", fulfills: ["patient"], value: SHC }], [fulfilled()]), "ART-6");
  ok("all-statuses", "Each of the six status codes once.", response([], ["fulfilled", "partial", "unavailable", "declined", "unsupported", "error"].map((s, i) => ({ item: `i${i}`, status: s }))), "RSP-3");
  // An Artifact that fails a check is disregarded; the response stands (XV-4).
  ok("empty-fulfills", "An Artifact with an empty fulfills list is disregarded.", response([artifactFhir({ fulfills: [] })], [fulfilled()]), "XV-5", { artifacts: { a1: "rejected" } });
  ok("fhir-missing-fhir-version", "A FHIR JSON Artifact without fhirVersion is disregarded.", response([artifactFhir({ fhirVersion: undefined })], [fulfilled()]), "XV-8", { artifacts: { a1: "rejected" } });
  ok("health-card-with-fhir-version", "A SMART Health Card Artifact with an outer fhirVersion is disregarded.", response([{ id: "c1", mediaType: "application/smart-health-card", fhirVersion: "4.0.1", fulfills: ["patient"], value: SHC }], [fulfilled()]), "XV-9, ART-6", { artifacts: { c1: "rejected" } });
  ok("fhir-value-not-resource", "A FHIR JSON Artifact whose value has no resourceType is disregarded.", response([artifactFhir({ value: { name: "x" } })], [fulfilled()]), "XV-8", { artifacts: { a1: "rejected" } });
  ok("duplicate-artifact-ids", "Two Artifacts share an id: both are disregarded.", response([artifactFhir(), artifactFhir()], [fulfilled()]), "XV-5", { artifacts: { a1: "rejected" } });
  // A bad status row affects only that item (XV-3).
  ok("unknown-status-code", "A status code outside the six: that item's outcome is unknown.", response([artifactFhir()], [{ item: "patient", status: "maybe" }]), "XV-3, RSP-3", { items: { patient: "unknown" } });

  bad("wrong-type", "type is not smart-health-checkin-response.", response([artifactFhir()], [fulfilled()], { type: "x" }), "response-type", "XV-1");
  bad("wrong-version", "version is \"2\".", response([artifactFhir()], [fulfilled()], { version: "2" }), "response-version", "XV-1");
  bad("missing-request-status", "No requestStatus array.", response([artifactFhir()], [fulfilled()], { requestStatus: undefined }), "response-status-missing", "XV-1");
  bad("artifacts-not-array", "artifacts is an object.", response([], [fulfilled()], { artifacts: { a1: artifactFhir() } }), "response-artifacts", "XV-1");
  {
    const text = `{\n  "type": "smart-health-checkin-response",\n  "version": "1",\n  "requestId": "conformance-request",\n  "requestId": "other",\n  "artifacts": [],\n  "requestStatus": ${JSON.stringify([fulfilled()])}\n}\n`;
    bad("duplicate-member", "The JSON text has the member requestId twice.", null, "json-duplicate-member", "JSON-2, XV-1", text);
  }
}

// ---------------------------------------------------------------- cross-validation

{
  const cap = "cross-validation";
  const req = request([
    item(),
    item({ id: "insurance", title: "Insurance", content: { kind: "selection.fhir", profiles: ["http://hl7.org/fhir/us/insurance-card/StructureDefinition/C4DIC-Coverage"] } }),
    formItem({ questionnaireCanonical: PHQ2 }),
  ]);
  const qr = (questionnaire: string) => artifactFhir({ id: "a3", fulfills: ["intake"], value: { resourceType: "QuestionnaireResponse", questionnaire, status: "completed" } });
  const statusAll = (over: Record<string, string> = {}) =>
    ["patient", "insurance", "intake"].map((id) => ({ item: id, status: over[id] ?? "fulfilled" }));
  const cov = artifactFhir({ id: "a2", fulfills: ["insurance"], value: { resourceType: "Coverage", status: "active" } });
  const good = () => response([artifactFhir(), cov, qr(PHQ2)], statusAll());
  const pair = (slug: string, description: string, r: unknown, resp: unknown, expected: Expected, rule: string, status?: Case["status"], pendingOn?: string) =>
    add({ capability: cap, slug, description, rule, status, pendingOn, inputs: files(cap, slug, { request: json(r), response: json(resp) }), expected });

  add({
    capability: cap, slug: "capture", description: "The real capture's request and response.", rule: "XV-1, XV-2, XV-3",
    inputs: files(cap, "capture", { request: captureRequestText, response: json(captureResponse) }), expected: { valid: true },
  });
  pair("baseline", "Three items, three Artifacts, three fulfilled.", req, good(), { valid: true }, "XV-1, XV-2, XV-3");
  pair("one-artifact-two-items", "One Bundle fulfills two items.", req, response([artifactFhir({ fulfills: ["patient", "insurance"], value: { resourceType: "Bundle", type: "collection", entry: [] } }), qr(PHQ2)], statusAll()), { valid: true }, "MM-1");
  pair("two-artifacts-one-item", "Two Artifacts fulfill the same item.", req, response([artifactFhir(), artifactFhir({ id: "a1b" }), cov, qr(PHQ2)], statusAll()), { valid: true }, "MM-1, MM-2");
  pair("declined-no-artifact", "A declined item has no Artifact.", req, response([artifactFhir(), qr(PHQ2)], statusAll({ insurance: "declined" })), { valid: true }, "RSP-2");
  pair("all-declined", "The patient declined everything: all declined, no Artifacts (HOLD-4).", req, response([], statusAll({ patient: "declined", insurance: "declined", intake: "declined" })), { valid: true }, "RSP-2, HOLD-4");
  pair("fulfilled-without-artifact", "A fulfilled item with no Artifact is a SHOULD, not a failure.", req, response([artifactFhir(), qr(PHQ2)], statusAll()), { valid: true }, "ART-7, XV-12");
  pair("versioned-canonical-echo", "A versioned questionnaireCanonical is echoed exactly in QuestionnaireResponse.questionnaire.", request([formItem({ questionnaireCanonical: `${PHQ2}|1` })]), response([qr(`${PHQ2}|1`)], [fulfilled("intake")]), { valid: true }, "FORM-5, CAN-2, XV-10");

  pair("request-id-mismatch", "requestId differs from the request id.", req, { ...good(), requestId: "other" }, { valid: false, reason: "request-id" }, "XV-2");
  pair("missing-status-row", "An item has no status row: its outcome is unknown, the response stands.", req, response([artifactFhir(), cov, qr(PHQ2)], statusAll().slice(0, 2)), { valid: true, items: { intake: "unknown" } }, "XV-3, RSP-2");
  pair("duplicate-status-row", "An item has two status rows: its outcome is unknown, the response stands.", req, response([artifactFhir(), cov, qr(PHQ2)], [...statusAll(), fulfilled()]), { valid: true, items: { patient: "unknown" } }, "XV-3, RSP-2");
  pair("unknown-status-row", "A status row names an item the request doesn't have: it is ignored.", req, response([artifactFhir(), cov, qr(PHQ2)], [...statusAll(), fulfilled("nope")]), { valid: true }, "XV-3, RSP-2");
  pair("fulfills-unknown-item", "An Artifact fulfills an item the request doesn't have: that Artifact is disregarded.", req, response([artifactFhir({ fulfills: ["patient", "nope"] }), cov, qr(PHQ2)], statusAll()), { valid: true, artifacts: { a1: "rejected", a2: "accepted", a3: "accepted" } }, "XV-5, ART-1");
  pair("unaccepted-media-type", "A SMART Health Card for an item that accepts only FHIR JSON: that Artifact is disregarded.", req, response([{ id: "c1", mediaType: "application/smart-health-card", fulfills: ["patient"], value: SHC }, cov, qr(PHQ2)], statusAll()), { valid: true, artifacts: { c1: "rejected", a2: "accepted", a3: "accepted" } }, "XV-7, ACC-2");
  pair("unknown-media-type", "An Artifact whose media type is neither core nor a supported extension: that Artifact is disregarded.", request([item({ accept: ["application/fhir+json", "application/x-unknown"] })]), response([{ id: "u1", mediaType: "application/x-unknown", fulfills: ["patient"], value: {} }], [fulfilled()]), { valid: true, artifacts: { u1: "rejected" } }, "XV-6");
  pair("questionnaire-echo-mismatch", "QuestionnaireResponse.questionnaire differs from the requested canonical: that Artifact is disregarded.", req, response([artifactFhir(), cov, qr(`${PHQ2}|2`)], statusAll()), { valid: true, artifacts: { a1: "accepted", a2: "accepted", a3: "rejected" } }, "XV-10, FORM-5");
  pair("fhir-version-not-requested", "One Artifact uses a FHIR release the request didn't list: only that Artifact is unusable.", req,
    response([artifactFhir({ fhirVersion: "3.0.2" }), cov, qr(PHQ2)], statusAll()),
    { valid: true, artifacts: { a1: "rejected", a2: "accepted", a3: "accepted" } }, "XV-8");
  pair("fhir-version-bad-format", "One Artifact's fhirVersion is \"R4\", not a release version: only that Artifact is unusable.", req,
    response([artifactFhir({ fhirVersion: "R4" }), cov, qr(PHQ2)], statusAll()),
    { valid: true, artifacts: { a1: "rejected", a2: "accepted", a3: "accepted" } }, "ART-2, XV-8");
}

// ---------------------------------------------------------------- mdoc builder (synthetic)

const ORIGIN = "https://clinic.example";
const OTHER_ORIGIN = "https://attacker.example";
const SIGNED_AT = new Date("2026-09-26T00:00:00Z");
const NOW = "2026-09-26T12:00:00Z";

const issuer = await createEphemeralReaderIdentity("SMART Health Check-in Conformance Issuer");
const deviceKeys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const deviceJwk = await crypto.subtle.exportKey("jwk", deviceKeys.publicKey);

const tdate = (d: Date) => new CborTag(0, d.toISOString().replace(".000Z", "Z"));
type MdocKnobs = {
  attachDevicePayload?: "rebuilt" | "other-session";
  omitValidityInfo?: boolean;
  tamperItemAfterSigning?: boolean;
  omitDigest?: boolean;
  documentDocType?: string;
  msoDocType?: string;
  status?: number;
  version?: string;
  issuerAlg?: number;
  digestAlgorithm?: string;
  extraTopLevelKey?: boolean;
  extraUnprotectedHeader?: boolean;
  tamperIssuerSignature?: boolean;
  tamperDeviceSignature?: boolean;
  elementIdentifier?: string;
  validity?: { from: Date; until: Date };
  secondDocument?: boolean;
  /** x5chain as one certificate byte string instead of an array (ENC-3). */
  x5chainBstr?: boolean;
  /** ENC-5: encode the top-level map with the key "status" twice. */
  duplicateStatusKey?: boolean;
};

async function sign(privateKey: CryptoKey, protectedBytes: Uint8Array, payload: Uint8Array) {
  const sigStructure = cborEncode(["Signature1", protectedBytes, new Uint8Array(), payload]);
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, arrayBufferCopy(sigStructure)));
}
const flip = (b: Uint8Array) => { const c = b.slice(); c[c.length - 1] ^= 1; return c; };
/** CBOR map bytes with entries in the given order, duplicates allowed (for ENC-5 cases). */
function rawMap(entries: [unknown, unknown][]): Uint8Array {
  if (entries.length >= 24) throw new Error("rawMap supports fewer than 24 entries");
  const parts = [new Uint8Array([0xa0 + entries.length])];
  for (const [k, v] of entries) parts.push(cborEncode(k), cborEncode(v));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function buildMdoc(smartResponseJson: string, transcript: Uint8Array, otherTranscript: Uint8Array, k: MdocKnobs = {}): Promise<Uint8Array> {
  const item = new Map<string, unknown>([
    ["digestID", 0],
    ["random", crypto.getRandomValues(new Uint8Array(16))],
    ["elementIdentifier", k.elementIdentifier ?? SMART_RESPONSE_ELEMENT_ID],
    ["elementValue", smartResponseJson],
  ]);
  const itemTag = new CborTag(24, cborEncode(item));
  const digest = await sha256(cborEncode(itemTag));
  const validity = k.validity ?? { from: SIGNED_AT, until: new Date(SIGNED_AT.getTime() + 86_400_000) };
  const mso = new Map<string, unknown>([
    ["version", "1.0"],
    ["digestAlgorithm", k.digestAlgorithm ?? "SHA-256"],
    ["valueDigests", new Map([[MDOC_NAMESPACE, new Map(k.omitDigest ? [[7, digest]] : [[0, digest]])]])],
    ["deviceKeyInfo", new Map([["deviceKey", publicJwkToCoseKey(deviceJwk)]])],
    ["docType", k.msoDocType ?? MDOC_DOC_TYPE],
  ]);
  if (!k.omitValidityInfo) {
    mso.set("validityInfo", new Map([["signed", tdate(validity.from)], ["validFrom", tdate(validity.from)], ["validUntil", tdate(validity.until)]]));
  }
  const msoBytes = cborEncode(new CborTag(24, cborEncode(mso)));
  const issuerProtected = cborEncode(new Map([[1, k.issuerAlg ?? -7]]));
  let issuerSig = await sign(issuer.keyPair.privateKey, issuerProtected, msoBytes);
  if (k.tamperIssuerSignature) issuerSig = flip(issuerSig);
  const issuerUnprotected = new Map<unknown, unknown>([[33, k.x5chainBstr ? issuer.certificateDer : [issuer.certificateDer]]]);
  if (k.extraUnprotectedHeader) issuerUnprotected.set(-70000, "ignored");
  const issuerAuth = [issuerProtected, issuerUnprotected, msoBytes, issuerSig];

  const docType = k.documentDocType ?? MDOC_DOC_TYPE;
  const deviceNameSpaces = new CborTag(24, cborEncode(new Map()));
  const signedTranscript = k.attachDevicePayload === "other-session" ? otherTranscript : transcript;
  const deviceAuthBytes = buildDeviceAuthenticationBytes({ sessionTranscript: signedTranscript, docType, deviceNameSpaces });
  const deviceProtected = cborEncode(new Map([[1, -7]]));
  let deviceSig = await sign(deviceKeys.privateKey, deviceProtected, deviceAuthBytes);
  if (k.tamperDeviceSignature) deviceSig = flip(deviceSig);
  const deviceSignature = [deviceProtected, new Map(), k.attachDevicePayload ? deviceAuthBytes : null, deviceSig];

  const itemForDoc = k.tamperItemAfterSigning
    ? new CborTag(24, cborEncode(new Map([...item, ["elementValue", smartResponseJson.replace("conformance", "tampered")]])))
    : itemTag;
  const document = new Map<string, unknown>([
    ["docType", docType],
    ["issuerSigned", new Map<string, unknown>([["nameSpaces", new Map([[MDOC_NAMESPACE, [itemForDoc]]])], ["issuerAuth", issuerAuth]])],
    ["deviceSigned", new Map<string, unknown>([["nameSpaces", deviceNameSpaces], ["deviceAuth", new Map([["deviceSignature", deviceSignature]])]])],
  ]);
  const top = new Map<string, unknown>([
    ["version", k.version ?? "1.0"],
    ["documents", k.secondDocument ? [document, document] : [document]],
    ["status", k.status ?? 0],
  ]);
  if (k.extraTopLevelKey) top.set("futureField", "ignored");
  if (k.duplicateStatusKey) return rawMap([...top, ["status", k.status ?? 0]]);
  return cborEncode(top);
}

// A synthetic request with keys we keep: its encryptionInfo, transcript, and recipient private key.
const synthRequest = request([item()], { id: "conformance-request" });
const synth = await buildOrgIsoMdocRequest(synthRequest as never, { origin: ORIGIN, readerAuth: true });
const synthEncInfoB64u = base64UrlEncodeBytes(synth.encryptionInfoBytes);
const synthTranscript = await buildDcapiSessionTranscript({ origin: ORIGIN, encryptionInfo: synth.encryptionInfoBytes });
const synthOtherTranscript = await buildDcapiSessionTranscript({ origin: OTHER_ORIGIN, encryptionInfo: synth.encryptionInfoBytes });
const synthPrivateJwk = await crypto.subtle.exportKey("jwk", synth.verifierKeyPair.privateKey);
const synthPublicJwk = synth.verifierPublicJwk;
const synthResponseJson = JSON.stringify(response([artifactFhir()], [fulfilled()]));

async function seal(deviceResponse: Uint8Array, transcript: Uint8Array, publicJwk: JsonWebKey) {
  const sealed = await hpkeSealDirectMdoc({ plaintext: deviceResponse, recipientPublicJwk: publicJwk, info: transcript });
  return sealed.response as { protocol: string; data: { response: string } };
}

// ---------------------------------------------------------------- request-cbor

{
  const cap = "request-cbor";
  const arg = (deviceRequest: Uint8Array, encryptionInfo: Uint8Array = synth.encryptionInfoBytes, protocol = "org-iso-mdoc", pad = false) => ({
    mediation: "required",
    digital: { requests: [{ protocol, data: { deviceRequest: pad ? padded(base64UrlEncodeBytes(deviceRequest)) : base64UrlEncodeBytes(deviceRequest), encryptionInfo: base64UrlEncodeBytes(encryptionInfo) } }] },
  });
  const itemsRequest = (over: { docType?: string; intent?: unknown; requestInfo?: unknown; extra?: boolean; companion?: boolean } = {}) => {
    const elements = new Map<string, unknown>([[SMART_RESPONSE_ELEMENT_ID, over.intent ?? true]]);
    if (over.companion) elements.set(`smart_request_b64u.${base64UrlEncodeBytes(enc.encode(JSON.stringify(synthRequest)))}`, false);
    const m = new Map<string, unknown>([
      ["docType", over.docType ?? MDOC_DOC_TYPE],
      ["nameSpaces", new Map([[MDOC_NAMESPACE, elements]])],
    ]);
    if (over.requestInfo !== null) m.set("requestInfo", over.requestInfo ?? new Map([[SMART_REQUEST_INFO_KEY, JSON.stringify(synthRequest)]]));
    if (over.extra) m.set("futureField", "ignored");
    return new CborTag(24, cborEncode(m));
  };
  const deviceRequest = (ir = itemsRequest(), version = "1.0", extraDocRequestKey = false) => {
    const docRequest = new Map<string, unknown>([["itemsRequest", ir]]);
    if (extraDocRequestKey) docRequest.set("futureField", "ignored");
    return cborEncode(new Map<string, unknown>([["version", version], ["docRequests", [docRequest]]]));
  };
  const expectedSmart = json(synthRequest);
  const ok = (slug: string, description: string, a: unknown, rule: string, smart = expectedSmart) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { navigatorArgument: json(a) }), expected: { valid: true, outputs: { smartRequest: write(`${cap}/${slug}/expected-smart-request.json`, smart) } } });
  const bad = (slug: string, description: string, a: unknown, reason: string, rule: string, status?: Case["status"], pendingOn?: string) =>
    add({ capability: cap, slug, description, rule, status, pendingOn, inputs: files(cap, slug, { navigatorArgument: json(a) }), expected: { valid: false, reason } });
  // Accepted with a warning: the request is still recovered (WRQ-1).
  const warn = (slug: string, description: string, a: unknown, code: string, rule: string, outcome: Outcome = "warn", smart = expectedSmart) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { navigatorArgument: json(a) }), expected: { ...WARN(code), outcome, outputs: { smartRequest: write(`${cap}/${slug}/expected-smart-request.json`, smart) } } });

  ok("capture", "The navigator argument from the real capture.", captureNavigatorArgument, "WRQ-0, WRQ-6", captureRequestText.trimEnd() + "\n");
  ok("synthetic-reader-auth", "A request built by the reference builder, with readerAuth.", synth.navigatorArgument, "WRQ-0, WRQ-9");
  ok("no-reader-auth", "No readerAuth in the DocRequest.", arg(deviceRequest()), "WRQ-9, VRQ-7");
  ok("unknown-docrequest-key", "An unknown key in the DocRequest is ignored.", arg(deviceRequest(itemsRequest(), "1.0", true)), "ALG-2");
  ok("unknown-itemsrequest-key", "An unknown key in the ItemsRequest is ignored.", arg(deviceRequest(itemsRequest({ extra: true }))), "ALG-2");
  warn("wrong-protocol", "The request's protocol is org.iso.mdoc, not org-iso-mdoc: warn.", arg(deviceRequest(), undefined, "org.iso.mdoc"), "protocol", "WRQ-2");
  {
    // A request whose deviceRequest encoding needs padding, so the padded form is standard base64url.
    let k = 0;
    const withId = (n: number) => deviceRequest(itemsRequest({ requestInfo: new Map([[SMART_REQUEST_INFO_KEY, JSON.stringify({ ...synthRequest, id: "conformance-request" + "x".repeat(n) })]]) }));
    while (base64UrlEncodeBytes(withId(k)).length % 4 === 0) k++;
    warn("padded-base64url", "deviceRequest is standard padded base64url, not unpadded: warn.", arg(withId(k), undefined, "org-iso-mdoc", true), "base64url-padding", "WRQ-2", "warn",
      json({ ...synthRequest, id: "conformance-request" + "x".repeat(k) }));
  }
  bad("wrong-doc-type", "The ItemsRequest asks for another docType.", arg(deviceRequest(itemsRequest({ docType: "org.iso.18013.5.1.mDL" }))), "doc-type", "WRQ-4");
  warn("intent-not-bool", "intentToRetain is a string: warn.", arg(deviceRequest(itemsRequest({ intent: "yes" }))), "intent-to-retain", "WRQ-5");
  bad("missing-request-info", "No requestInfo carrier (the request travels only there).", arg(deviceRequest(itemsRequest({ requestInfo: null }))), "request-info-missing", "WRQ-5");
  bad("request-info-invalid", "requestInfo holds JSON that isn't a valid SMART request.", arg(deviceRequest(itemsRequest({ requestInfo: new Map([[SMART_REQUEST_INFO_KEY, JSON.stringify({ type: "nope" })]]) }))), "smart-request-invalid", "WRQ-6, REQ-2");
  warn("unknown-version", "DeviceRequest version 9.0: warn.", arg(deviceRequest(itemsRequest(), "9.0")), "device-request-version", "WRQ-3");
  {
    const badKey = cborEncode(["dcapi", new Map<unknown, unknown>([["nonce", crypto.getRandomValues(new Uint8Array(16))], ["recipientPublicKey", new Map<number, unknown>([[1, 2], [-1, 7], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]])]])]);
    bad("encryption-key-wrong-curve", "encryptionInfo's recipient key has an unsupported crv.", arg(deviceRequest(), badKey), "encryption-key", "WRQ-7, ALG-2");
    const wrongTag = cborEncode(["other", new Map<unknown, unknown>([["nonce", crypto.getRandomValues(new Uint8Array(16))], ["recipientPublicKey", publicJwkToCoseKey(synthPublicJwk)]])]);
    warn("encryption-info-wrong-tag", "encryptionInfo's first entry is not \"dcapi\", but its recipient key is usable: warn.", arg(deviceRequest(), wrongTag), "encryption-info", "WRQ-7");
  }
  ok("companion-element-present", "The ItemsRequest also requests an old smart_request_b64u.* element: the request is read only from requestInfo, the extra element is ignored.",
    arg(deviceRequest(itemsRequest({ companion: true }))), "WRQ-6");
  {
    // Another docType's DocRequest beside the SMART one is ignored; two SMART DocRequests are rejected.
    const withDocRequests = (...irs: CborTag[]) => cborEncode(new Map<string, unknown>([["version", "1.0"], ["docRequests", irs.map((ir) => new Map([["itemsRequest", ir]]))]]));
    ok("other-doc-request-ignored", "A DocRequest for another docType beside the SMART one is ignored.", arg(withDocRequests(itemsRequest({ docType: "org.iso.18013.5.1.mDL" }), itemsRequest())), "WRQ-4");
    warn("two-smart-doc-requests", "Two DocRequests for org.smarthealthit.checkin.1: use the first and warn.", arg(withDocRequests(itemsRequest(), itemsRequest())), "doc-requests", "WRQ-4");
    // ENC-5: a CBOR map with a duplicate key. ItemsRequest with docType twice.
    const dupItems = new CborTag(24, rawMap([
      ["docType", MDOC_DOC_TYPE], ["docType", MDOC_DOC_TYPE],
      ["nameSpaces", new Map([[MDOC_NAMESPACE, new Map([[SMART_RESPONSE_ELEMENT_ID, true]])]])],
      ["requestInfo", new Map([[SMART_REQUEST_INFO_KEY, JSON.stringify(synthRequest)]])],
    ]));
    warn("duplicate-key-items-request", "The ItemsRequest map has the key docType twice: warn, or fail if the decoder can't process it.", arg(deviceRequest(dupItems)), "cbor-duplicate-key", "ENC-5, WRQ-5", "warn-or-reject");
  }
}

// ---------------------------------------------------------------- transcript

{
  const cap = "transcript";
  const tcase = async (slug: string, description: string, origin: string, encB64u: string, rule: string) => {
    const t = await buildDcapiSessionTranscript({ origin, encryptionInfo: encB64u });
    add({
      capability: cap, slug, description, rule,
      inputs: files(cap, slug, { origin, encryptionInfo: encB64u }),
      expected: { valid: true, outputs: { sessionTranscript: write(`${cap}/${slug}/expected-session-transcript.cbor`, t) } },
    });
  };
  const capEnc = read(join(CAPTURE_REQ, "encryption-info.b64u")).trim();
  await tcase("capture", "The real capture's origin (http, non-default port) and encryptionInfo.", read(join(CAPTURE_REQ, "metadata.json")) && JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin, capEnc, "TR-1, TR-2");
  await tcase("https-default-port", "An https origin with no port.", ORIGIN, synthEncInfoB64u, "TR-2");
  await tcase("https-explicit-port", "An https origin with a non-default port.", "https://clinic.example:8443", synthEncInfoB64u, "TR-2");
  // Sanity: the capture's own transcript matches what we compute.
  const ours = await buildDcapiSessionTranscript({ origin: JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin, encryptionInfo: capEnc });
  if (hex(ours) !== hex(readBytes(join(CAPTURE_REQ, "session-transcript.cbor")))) throw new Error("capture transcript mismatch");
}

// ---------------------------------------------------------------- hpke-open

{
  const cap = "hpke-open";
  const capOrigin = JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin;
  const capEnc = read(join(CAPTURE_REQ, "encryption-info.b64u")).trim();
  const inputs = (slug: string, credential: unknown, jwk: string, origin: string, encB64u: string) =>
    files(cap, slug, { credential: json(credential), recipientPrivateJwk: jwk, origin, encryptionInfo: encB64u });

  add({
    capability: cap, slug: "capture", description: "Open the real capture's response.", rule: "VRS-2, VRS-3, HPKE-1",
    inputs: inputs("capture", JSON.parse(read(join(CAPTURE_RESP, "credential.json"))), read(join(CAPTURE_REQ, "recipient-private.jwk.json")), capOrigin, capEnc),
    expected: { valid: true, outputs: { deviceResponse: write(`${cap}/capture/expected-device-response.cbor`, readBytes(join(CAPTURE_RESP, "device-response.cbor"))) } },
  });
  const dr = await buildMdoc(synthResponseJson, synthTranscript, synthOtherTranscript);
  const good = await seal(dr, synthTranscript, synthPublicJwk);
  const jwk = json(synthPrivateJwk);
  add({
    capability: cap, slug: "synthetic", description: "Open a response sealed by the reference code.", rule: "VRS-3, HPKE-1",
    inputs: inputs("synthetic", good, jwk, ORIGIN, synthEncInfoB64u),
    expected: { valid: true, outputs: { deviceResponse: write(`${cap}/synthetic/expected-device-response.cbor`, dr) } },
  });
  const bad = (slug: string, description: string, credential: unknown, reason: string, rule: string) =>
    add({ capability: cap, slug, description, rule, inputs: inputs(slug, credential, jwk, ORIGIN, synthEncInfoB64u), expected: { valid: false, reason } });
  const warnc = (slug: string, description: string, credential: unknown, code: string, rule: string, plaintext: Uint8Array) =>
    add({ capability: cap, slug, description, rule, inputs: inputs(slug, credential, jwk, ORIGIN, synthEncInfoB64u),
      expected: { ...WARN(code), outputs: { deviceResponse: write(`${cap}/${slug}/expected-device-response.cbor`, plaintext) } } });
  bad("wrong-origin", "Sealed with the transcript for another origin: must not open.", await seal(dr, synthOtherTranscript, synthPublicJwk), "hpke-open", "VRS-3, TR-5");
  {
    const decoded = cborDecode(base64UrlDecodeBytes(good.data.response)) as [string, Map<string, Uint8Array>];
    const fields = new Map(decoded[1]);
    fields.set("cipherText", flip(fields.get("cipherText")!));
    bad("tampered-ciphertext", "One ciphertext bit flipped.", { protocol: "org-iso-mdoc", data: { response: base64UrlEncodeBytes(cborEncode(["dcapi", fields])) } }, "hpke-open", "VRS-3");
    warnc("wrong-response-tag", "The response's first entry is not \"dcapi\", but enc and cipherText are there: warn.", { protocol: "org-iso-mdoc", data: { response: base64UrlEncodeBytes(cborEncode(["other", decoded[1]])) } }, "dcapi-response", "VRS-2", dr);
    const noEnc = new Map(decoded[1]); noEnc.delete("enc");
    bad("missing-enc", "The response has no enc: fail.", { protocol: "org-iso-mdoc", data: { response: base64UrlEncodeBytes(cborEncode(["dcapi", noEnc])) } }, "dcapi-response", "VRS-2");
  }
  {
    // A response whose base64url needs padding, so the padded form is standard base64url.
    let k = 0, sealed = good, sealedDr = dr;
    while (sealed.data.response.length % 4 === 0) {
      k++;
      sealedDr = await buildMdoc(synthResponseJson + " ".repeat(k), synthTranscript, synthOtherTranscript);
      sealed = await seal(sealedDr, synthTranscript, synthPublicJwk);
    }
    warnc("padded-base64url", "data.response is standard padded base64url, not unpadded: warn.", { protocol: "org-iso-mdoc", data: { response: padded(sealed.data.response) } }, "base64url-padding", "VRS-2", sealedDr);
  }
  warnc("wrong-protocol", "The credential's protocol is not org-iso-mdoc: warn.", { protocol: "openid4vp", data: good.data }, "protocol", "VRS-2", dr);
}

// ---------------------------------------------------------------- mdoc-verify

{
  const cap = "mdoc-verify";
  const add1 = (slug: string, description: string, deviceResponse: Uint8Array, credential: unknown, expected: Expected, rule: string, extra: { origin?: string; encB64u?: string; transcript?: Uint8Array; now?: string; jwk?: string; status?: Case["status"]; pendingOn?: string } = {}) =>
    add({
      capability: cap, slug, description, rule, status: extra.status, pendingOn: extra.pendingOn,
      inputs: files(cap, slug, {
        deviceResponse,
        credential: json(credential),
        recipientPrivateJwk: extra.jwk ?? json(synthPrivateJwk),
        origin: extra.origin ?? ORIGIN,
        encryptionInfo: extra.encB64u ?? synthEncInfoB64u,
        sessionTranscript: extra.transcript ?? synthTranscript,
        now: extra.now ?? NOW,
      }),
      expected,
    });

  const capOrigin = JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin;
  add1("capture", "The real capture's DeviceResponse (detached device signature).", readBytes(join(CAPTURE_RESP, "device-response.cbor")), JSON.parse(read(join(CAPTURE_RESP, "credential.json"))), { valid: true }, "VRS-4, VRS-5, VRS-6, VRS-7, VRS-8", {
    origin: capOrigin, encB64u: read(join(CAPTURE_REQ, "encryption-info.b64u")).trim(), transcript: readBytes(join(CAPTURE_REQ, "session-transcript.cbor")),
    // Just after the MSO was signed (the capture's capturedAt is 28 s earlier: host and emulator clocks differ).
    now: "2026-09-26T13:15:30Z", jwk: read(join(CAPTURE_REQ, "recipient-private.jwk.json")),
  });
  const one = async (slug: string, description: string, knobs: MdocKnobs, expected: Expected, rule: string, status?: Case["status"], pendingOn?: string, now?: string) => {
    const dr = await buildMdoc(synthResponseJson, synthTranscript, synthOtherTranscript, knobs);
    add1(slug, description, dr, await seal(dr, synthTranscript, synthPublicJwk), expected, rule, { status, pendingOn, now });
  };
  await one("synthetic", "A reference-built DeviceResponse with a detached device signature.", {}, { valid: true }, "WRS-0, VRS-4, VRS-5, VRS-6, VRS-7, VRS-8");
  await one("unknown-top-level-key", "An unknown top-level DeviceResponse key is ignored.", { extraTopLevelKey: true }, { valid: true }, "ALG-2");
  await one("unknown-unprotected-header", "An unknown unprotected header label in issuerAuth is ignored.", { extraUnprotectedHeader: true }, { valid: true }, "ALG-2");
  await one("attached-payload-equal", "Device signature carries an attached payload equal to the rebuilt DeviceAuthentication: accepted.", { attachDevicePayload: "rebuilt" }, { valid: true }, "VRS-7");
  await one("attached-payload-other-session", "Device signature carries an attached payload built for another origin's transcript: warn.", { attachDevicePayload: "other-session" }, WARN("device-signature"), "VRS-7");
  await one("tampered-device-signature", "One bit of the device signature flipped: warn.", { tamperDeviceSignature: true }, WARN("device-signature"), "VRS-7");
  await one("tampered-issuer-signature", "One bit of the issuer signature flipped: warn.", { tamperIssuerSignature: true }, WARN("issuer-signature"), "VRS-5");
  await one("missing-validity-info", "The MSO has no validityInfo: warn.", { omitValidityInfo: true }, WARN("mso-validity-info"), "VRS-5, WRS-3");
  await one("digest-mismatch", "The issuer-signed item changed after the MSO was signed: warn.", { tamperItemAfterSigning: true }, WARN("digest"), "VRS-6");
  await one("digest-missing", "The MSO has no digest for the item's digestID: warn.", { omitDigest: true }, WARN("digest"), "VRS-6");
  await one("document-doc-type", "No document has docType org.smarthealthit.checkin.1: fail.", { documentDocType: "org.iso.18013.5.1.mDL", msoDocType: "org.iso.18013.5.1.mDL" }, { valid: false, reason: "doc-type" }, "VRS-4");
  await one("mso-doc-type-mismatch", "The MSO's docType differs from the document's: warn.", { msoDocType: "org.example.other" }, WARN("mso-doc-type"), "VRS-5");
  await one("status-not-ok", "DeviceResponse status is 10: warn.", { status: 10 }, WARN("device-response-status"), "VRS-4");
  await one("version-unknown", "DeviceResponse version is 9.0: warn.", { version: "9.0" }, WARN("device-response-version"), "VRS-4");
  await one("unknown-alg", "issuerAuth's protected alg is an unknown value: warn.", { issuerAlg: -65535 }, WARN("alg"), "ALG-2");
  await one("unsupported-digest-algorithm", "The MSO's digestAlgorithm is SHA-512 (1.0 uses SHA-256): warn.", { digestAlgorithm: "SHA-512" }, WARN("digest-algorithm"), "ALG-1, ALG-2");
  await one("missing-response-element", "No smart_health_checkin_response element: fail.", { elementIdentifier: "something_else" }, { valid: false, reason: "response-element" }, "VRS-8");
  await one("x5chain-single-certificate", "issuerAuth's x5chain is one certificate byte string, not an array.", { x5chainBstr: true }, { valid: true }, "ENC-3");
  await one("duplicate-key-device-response", "The DeviceResponse map has the key status twice: warn, or fail if the decoder can't process it.", { duplicateStatusKey: true }, { ...WARN("cbor-duplicate-key"), outcome: "warn-or-reject" }, "ENC-5, VRS-4");
  await one("two-documents", "Two documents in the DeviceResponse: warn.", { secondDocument: true }, WARN("documents"), "VRS-4");
  await one("expired", "Checked after the MSO's validUntil: warn.", {}, WARN("mso-validity"), "VRS-10", undefined, undefined, "2026-10-05T00:00:00Z");
}

// ---------------------------------------------------------------- wallet-response

{
  const cap = "wallet-response";
  const w = (slug: string, description: string, navigatorArgument: unknown, smartResponse: unknown, jwk: string, origin: string, encB64u: string, rule: string) =>
    add({
      capability: cap, slug, description, rule,
      inputs: files(cap, slug, { navigatorArgument: json(navigatorArgument), smartResponse: json(smartResponse), recipientPrivateJwk: jwk, origin, encryptionInfo: encB64u }),
      expected: { valid: true },
    });
  w("capture-request", "Answer the real capture's request; the reference verifier must accept the result.",
    captureNavigatorArgument, captureResponse,
    read(join(CAPTURE_REQ, "recipient-private.jwk.json")), JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin,
    read(join(CAPTURE_REQ, "encryption-info.b64u")).trim(), "WRS-0, HPKE-1, HPKE-2");
  w("synthetic-request", "Answer a reference-built request.", synth.navigatorArgument, JSON.parse(synthResponseJson), json(synthPrivateJwk), ORIGIN, synthEncInfoB64u, "WRS-0, HPKE-1, HPKE-2");
}

// ---------------------------------------------------------------- manifest

const capabilities: Record<string, string> = {
  "request-json": "Validate a SMART request (JSON text). Valid or not; some cases also give per-item outcomes (unsupported).",
  "response-json": "Validate a SMART response's shape on its own. Valid or not; some cases also give per-Artifact or per-item outcomes.",
  "cross-validation": "Validate a SMART response against the request it answers (§6.4). Valid or not; some cases also give per-Artifact or per-item outcomes.",
  "request-cbor": "Wallet side: read a navigator.credentials.get argument; recover the SMART request, or reject.",
  transcript: "Build SessionTranscript bytes from an origin and the encryptionInfo base64url string.",
  "hpke-open": "Verifier side: open a credential with the recipient private key and the transcript; recover the DeviceResponse bytes, or reject.",
  "mdoc-verify": "Verifier side: check a DeviceResponse against the session transcript: version, status, docType, issuer signature, digests, validityInfo, device signature, the response element. Valid or not.",
  "wallet-response": "Wallet side: answer a request with a given SMART response. The reference verifier opens and checks the result.",
};
const order = Object.keys(capabilities);
cases.sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability));
writeFileSync(join(OUT, "manifest.json"), json({ formatVersion: 2, capabilities, cases }));
const count = (f: (c: Case) => boolean) => cases.filter(f).length;
const oc = (o: string) => count((c) => c.expected.outcome === o);
console.log(`${cases.length} cases: ${oc("accept")} accept, ${oc("warn")} warn, ${oc("warn-or-reject")} warn-or-reject, ${oc("reject")} reject; ${count((c) => c.status === "pending")} pending`);
for (const cap of order) console.log(`  ${cap}: ${count((c) => c.capability === cap)}`);

export {};
