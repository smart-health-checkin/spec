// Generates conformance/: small, single-capability test cases that every
// implementation runs (see conformance/README.md for the case format).
//
//   bun tools/conformance/generate.ts
//
// Positive cases come from the real Chrome/Android capture (-v2) and from
// synthetic requests and mdocs built here with keys we control. Every negative
// case is ONE deliberate mutation of a positive one, made by code below, never
// by hand-editing bytes. Expected results follow the decisions in the
// alignment plan (D1–D13), not what any implementation currently does.
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
const CAPTURE_REQ = join(ROOT, "fixtures/dcapi-requests/real-chrome-android-smart-checkin-v2");
const CAPTURE_RESP = join(ROOT, "fixtures/responses/real-chrome-android-smart-checkin-v2");
const CAPTURE_V1_REQ = join(ROOT, "fixtures/dcapi-requests/real-chrome-android-smart-checkin");
const CAPTURE_V1_RESP = join(ROOT, "fixtures/responses/real-chrome-android-smart-checkin");

type Expected = {
  valid: boolean;
  /** Short code naming why a case is invalid. Documentation; runners need not match it. */
  reason?: string;
  /** cross-validation: per-Artifact outcome when only some Artifacts are unusable (D6). */
  artifacts?: Record<string, "accepted" | "rejected">;
  /** Output files an implementation must reproduce byte for byte (transcript, hpke-open, request-cbor). */
  outputs?: Record<string, string>;
};
type Case = {
  id: string;
  capability: string;
  description: string;
  inputs: Record<string, string>;
  expected: Expected;
  /** Where the rule comes from today: a spec section or a plan decision. */
  rule: string;
  /** Filled in when the rewritten spec assigns requirement ids. */
  requirement: string | null;
  /** "pending" = the expected result waits on a spec decision; runners skip it. */
  status: "active" | "pending";
  pendingOn?: string;
};

// Start clean, keeping hand-written files (README.md) at the top level.
mkdirSync(OUT, { recursive: true });
for (const e of readdirSync(OUT, { withFileTypes: true })) if (e.isDirectory()) rmSync(join(OUT, e.name), { recursive: true });

const cases: Case[] = [];
const enc = new TextEncoder();

function write(path: string, content: string | Uint8Array) {
  const full = join(OUT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return path;
}
const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

function add(c: Omit<Case, "id" | "requirement" | "status"> & { slug: string; status?: Case["status"]; pendingOn?: string }) {
  const { slug, ...rest } = c;
  cases.push({ id: `${c.capability}/${slug}`, requirement: null, status: c.status ?? "active", ...rest });
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
  const ok = (slug: string, description: string, req: unknown, rule: string, text?: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { request: text ?? json(req) }), expected: { valid: true } });
  const bad = (slug: string, description: string, req: unknown, reason: string, rule: string, text?: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { request: text ?? json(req) }), expected: { valid: false, reason } });

  ok("capture-v2", "The request from the real Chrome/Android capture.", null, "§5.2", captureRequestText);
  ok("minimal", "One selection.fhir item with an exact profile.", request([item()]), "§5.2");
  ok("no-filters", "selection.fhir with no filter arrays: the wallet decides.", request([item({ content: { kind: "selection.fhir" } })]), "§5.4.1");
  ok("empty-items", "An empty items array is valid (items SHOULD be non-empty).", request([]), "§5.2 items");
  ok("no-fhir-versions", "fhirVersions is optional.", request([item()], { fhirVersions: undefined }), "§5.2 fhirVersions");
  ok("empty-fhir-versions", "fhirVersions may be an empty array.", request([item()], { fhirVersions: [] }), "§5.2 fhirVersions");
  ok("form-canonical", "form.fhir by questionnaireCanonical.", request([formItem({ questionnaireCanonical: PHQ2 })]), "§5.4.2");
  ok("form-versioned-canonical", "form.fhir by a versioned canonical (url|version).", request([formItem({ questionnaireCanonical: `${PHQ2}|1` })]), "§5.4.2, §5.5");
  ok("form-inline", "form.fhir with an inline Questionnaire.", request([formItem({ questionnaire: { resourceType: "Questionnaire", status: "active", item: [{ linkId: "q", text: "Why?", type: "string" }] } })]), "§5.4.2");
  ok("profiles-from", "selection.fhir by profile family narrowed by resourceTypes.", request([item({ content: { kind: "selection.fhir", profilesFrom: ["http://hl7.org/fhir/us/core"], resourceTypes: ["Condition"] } })]), "§5.4.1");
  ok("unknown-kind", "An unknown content.kind is a valid request; the wallet answers unsupported for that item (D5).", request([item({ id: "x", content: { kind: "example.extension", anything: 1 } }), item()]), "D5, §5.4.3");
  ok("legacy-members-ignored", "Old selector members canonical and resource are ignored like any unknown member (D13).", request([item({ content: { kind: "selection.fhir", profiles: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"], canonical: "x", resource: "Patient" } })]), "D13, §5.2 unknown members");
  ok("unknown-top-member", "Unknown top-level members may be ignored.", request([item()], { futureThing: { a: 1 } }), "§5.2 unknown members");

  bad("wrong-type", "type is not smart-health-checkin-request.", request([item()], { type: "something-else" }), "request-type", "§5.2 type");
  bad("version-number", "version is the number 1, not the string \"1\".", request([item()], { version: 1 }), "request-version", "§5.1, §5.2 version");
  bad("missing-id", "No request id.", request([item()], { id: undefined }), "request-id", "§5.2 id");
  bad("duplicate-item-ids", "Two items share an id.", request([item(), item()]), "item-id-duplicate", "§5.3");
  bad("missing-title", "An item without a title.", request([item({ title: undefined })]), "item-title", "§5.3");
  bad("empty-accept", "An item with an empty accept list.", request([item({ accept: [] })]), "item-accept", "§5.3, §5.6");
  bad("mixed-form-with-profiles", "form.fhir that also carries profiles.", request([formItem({ questionnaireCanonical: PHQ2, profiles: ["http://example.org/p"] })]), "selector-mixed", "§5.4.2");
  bad("mixed-selection-with-questionnaire", "selection.fhir that also carries questionnaireCanonical.", request([item({ content: { kind: "selection.fhir", questionnaireCanonical: PHQ2 } })]), "selector-mixed", "§5.2 SelectionFhirSelector");
  bad("form-no-source", "form.fhir with neither questionnaire nor questionnaireCanonical.", request([formItem({})]), "form-source", "§5.4.2");
  bad("blank-canonical", "questionnaireCanonical is an empty string.", request([formItem({ questionnaireCanonical: "" })]), "form-canonical-blank", "§5.4.2");
  bad("canonical-not-string", "questionnaireCanonical is a number.", request([formItem({ questionnaireCanonical: 7 })]), "form-canonical-type", "§5.4.2");
  bad("questionnaire-wrong-type", "The inline questionnaire is a Patient.", request([formItem({ questionnaire: { resourceType: "Patient" } })]), "form-questionnaire-type", "§5.4.2");
  bad("profiles-from-string", "profilesFrom is a string, not an array.", request([item({ content: { kind: "selection.fhir", profilesFrom: "http://hl7.org/fhir/us/core" } })]), "selector-profiles-from", "§5.2 profilesFrom");
  bad("empty-profiles", "profiles is an empty array (NonEmptyArray).", request([item({ content: { kind: "selection.fhir", profiles: [] } })]), "selector-profiles-empty", "§5.2 profiles");
  bad("empty-resource-types", "resourceTypes is an empty array (NonEmptyArray).", request([item({ content: { kind: "selection.fhir", resourceTypes: [] } })]), "selector-resource-types-empty", "§5.2 resourceTypes");
  {
    const text = `{\n  "type": "smart-health-checkin-request",\n  "version": "1",\n  "id": "first",\n  "id": "second",\n  "items": ${JSON.stringify([item()])}\n}\n`;
    bad("duplicate-member", "The JSON text has the member id twice.", null, "json-duplicate-member", "§5.1", text);
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
  const ok = (slug: string, description: string, resp: unknown, rule: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { response: json(resp) }), expected: { valid: true } });
  const bad = (slug: string, description: string, resp: unknown, reason: string, rule: string) =>
    add({ capability: cap, slug, description, rule, inputs: files(cap, slug, { response: json(resp) }), expected: { valid: false, reason } });

  ok("capture-v2", "The response from the real capture.", captureResponse, "§6.1");
  ok("minimal", "One FHIR Patient Artifact.", response([artifactFhir()], [fulfilled()]), "§6.1");
  ok("declined-no-artifacts", "Everything declined, no Artifacts (D10).", response([], [{ item: "patient", status: "declined" }]), "§6.1, D10");
  ok("health-card", "A SMART Health Card Artifact.", response([{ id: "c1", mediaType: "application/smart-health-card", fulfills: ["patient"], value: SHC }], [fulfilled()]), "§6.1 SmartHealthCardArtifact");
  ok("all-statuses", "Each of the six status codes once.", response([], ["fulfilled", "partial", "unavailable", "declined", "unsupported", "error"].map((s, i) => ({ item: `i${i}`, status: s }))), "§6.1 RequestItemStatusCode");

  bad("wrong-type", "type is not smart-health-checkin-response.", response([artifactFhir()], [fulfilled()], { type: "x" }), "response-type", "§6.1 type");
  bad("missing-request-status", "No requestStatus array.", response([artifactFhir()], [fulfilled()], { requestStatus: undefined }), "response-status-missing", "§6.1");
  bad("empty-fulfills", "An Artifact with an empty fulfills list.", response([artifactFhir({ fulfills: [] })], [fulfilled()]), "artifact-fulfills", "§6.1 fulfills");
  bad("fhir-missing-fhir-version", "FHIR JSON Artifact without fhirVersion.", response([artifactFhir({ fhirVersion: undefined })], [fulfilled()]), "artifact-fhir-version", "§6.1 RawFhirJsonArtifact");
  bad("health-card-with-fhir-version", "A SMART Health Card Artifact with an outer fhirVersion.", response([{ id: "c1", mediaType: "application/smart-health-card", fhirVersion: "4.0.1", fulfills: ["patient"], value: SHC }], [fulfilled()]), "artifact-shc-fhir-version", "§6.1, §6.4");
  bad("fhir-value-not-resource", "FHIR JSON Artifact whose value has no resourceType.", response([artifactFhir({ value: { name: "x" } })], [fulfilled()]), "artifact-value", "§6.1 FhirResource");
  bad("unknown-status-code", "A status code outside the six.", response([artifactFhir()], [{ item: "patient", status: "maybe" }]), "status-code", "§6.1");
  bad("duplicate-artifact-ids", "Two Artifacts share an id.", response([artifactFhir(), artifactFhir()], [fulfilled()]), "artifact-id-duplicate", "§6.1 id");
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
    capability: cap, slug: "capture-v2", description: "The real capture's request and response.", rule: "§6.4",
    inputs: files(cap, "capture-v2", { request: captureRequestText, response: json(captureResponse) }), expected: { valid: true },
  });
  pair("baseline", "Three items, three Artifacts, three fulfilled.", req, good(), { valid: true }, "§6.4");
  pair("one-artifact-two-items", "One Bundle fulfills two items.", req, response([artifactFhir({ fulfills: ["patient", "insurance"], value: { resourceType: "Bundle", type: "collection", entry: [] } }), qr(PHQ2)], statusAll()), { valid: true }, "§6.3");
  pair("two-artifacts-one-item", "Two Artifacts fulfill the same item.", req, response([artifactFhir(), artifactFhir({ id: "a1b" }), cov, qr(PHQ2)], statusAll()), { valid: true }, "§6.3");
  pair("declined-no-artifact", "A declined item has no Artifact.", req, response([artifactFhir(), qr(PHQ2)], statusAll({ insurance: "declined" })), { valid: true }, "§6.2");
  pair("all-declined", "The patient declined everything: all declined, no Artifacts (D10).", req, response([], statusAll({ patient: "declined", insurance: "declined", intake: "declined" })), { valid: true }, "D10");
  pair("fulfilled-without-artifact", "A fulfilled item with no Artifact is a SHOULD, not a failure.", req, response([artifactFhir(), qr(PHQ2)], statusAll()), { valid: true }, "§6.2 SHOULD");
  pair("versioned-canonical-echo", "A versioned questionnaireCanonical is echoed exactly in QuestionnaireResponse.questionnaire.", request([formItem({ questionnaireCanonical: `${PHQ2}|1` })]), response([qr(`${PHQ2}|1`)], [fulfilled("intake")]), { valid: true }, "§5.5, D9");

  pair("request-id-mismatch", "requestId differs from the request id.", req, { ...good(), requestId: "other" }, { valid: false, reason: "request-id" }, "§6.4 requestId");
  pair("missing-status-row", "An item has no status row.", req, response([artifactFhir(), cov, qr(PHQ2)], statusAll().slice(0, 2)), { valid: false, reason: "status-missing" }, "§6.4 status coverage");
  pair("duplicate-status-row", "An item has two status rows.", req, response([artifactFhir(), cov, qr(PHQ2)], [...statusAll(), fulfilled()]), { valid: false, reason: "status-duplicate" }, "§6.4 status coverage");
  pair("unknown-status-row", "A status row names an item the request doesn't have.", req, response([artifactFhir(), cov, qr(PHQ2)], [...statusAll(), fulfilled("nope")]), { valid: false, reason: "status-unknown-item" }, "§6.4 status coverage");
  pair("fulfills-unknown-item", "An Artifact fulfills an item the request doesn't have.", req, response([artifactFhir({ fulfills: ["patient", "nope"] }), cov, qr(PHQ2)], statusAll()), { valid: false, reason: "fulfills-unknown-item" }, "§6.4 fulfills");
  pair("unaccepted-media-type", "A SMART Health Card for an item that accepts only FHIR JSON.", req, response([{ id: "c1", mediaType: "application/smart-health-card", fulfills: ["patient"], value: SHC }, cov, qr(PHQ2)], statusAll()), { valid: false, reason: "media-type-not-accepted" }, "§5.6, §6.4");
  pair("unknown-media-type", "An Artifact with a media type that is neither core nor a supported extension.", request([item({ accept: ["application/fhir+json", "application/x-unknown"] })]), response([{ id: "u1", mediaType: "application/x-unknown", fulfills: ["patient"], value: {} }], [fulfilled()]), { valid: false, reason: "media-type-unknown" }, "§6.4");
  pair("questionnaire-echo-mismatch", "QuestionnaireResponse.questionnaire differs from the requested canonical.", req, response([artifactFhir(), cov, qr(`${PHQ2}|2`)], statusAll()), { valid: false, reason: "questionnaire-echo" }, "§5.5");
  pair("fhir-version-not-requested", "One Artifact uses a FHIR release the request didn't list: only that Artifact is unusable (D6).", req,
    response([artifactFhir({ fhirVersion: "3.0.2" }), cov, qr(PHQ2)], statusAll()),
    { valid: true, artifacts: { a1: "rejected", a2: "accepted", a3: "accepted" } }, "D6, §6.1 fhirVersion");
  pair("fhir-version-bad-format", "One Artifact's fhirVersion is \"R4\", not a release version: only that Artifact is unusable (D6).", req,
    response([artifactFhir({ fhirVersion: "R4" }), cov, qr(PHQ2)], statusAll()),
    { valid: true, artifacts: { a1: "rejected", a2: "accepted", a3: "accepted" } }, "D6");
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
};

async function sign(privateKey: CryptoKey, protectedBytes: Uint8Array, payload: Uint8Array) {
  const sigStructure = cborEncode(["Signature1", protectedBytes, new Uint8Array(), payload]);
  return new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, arrayBufferCopy(sigStructure)));
}
const flip = (b: Uint8Array) => { const c = b.slice(); c[c.length - 1] ^= 1; return c; };

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
  const issuerUnprotected = new Map<unknown, unknown>([[33, [issuer.certificateDer]]]);
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
    digital: { requests: [{ protocol, data: { deviceRequest: base64UrlEncodeBytes(deviceRequest) + (pad ? "=" : ""), encryptionInfo: base64UrlEncodeBytes(encryptionInfo) } }] },
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

  ok("capture-v2", "The navigator argument from the real capture.", captureNavigatorArgument, "§8.2, A.3", captureRequestText.trimEnd() + "\n");
  ok("synthetic-reader-auth", "A request built by the reference builder, with readerAuth.", synth.navigatorArgument, "§8.2");
  ok("no-reader-auth", "No readerAuth in the DocRequest.", arg(deviceRequest()), "§8.2 readerAuth optional");
  ok("unknown-docrequest-key", "An unknown key in the DocRequest is ignored (D11).", arg(deviceRequest(itemsRequest(), "1.0", true)), "D11");
  ok("unknown-itemsrequest-key", "An unknown key in the ItemsRequest is ignored (D11).", arg(deviceRequest(itemsRequest({ extra: true }))), "D11");
  bad("wrong-protocol", "The request's protocol is org.iso.mdoc, not org-iso-mdoc.", arg(deviceRequest(), undefined, "org.iso.mdoc"), "protocol", "§8.1");
  bad("padded-base64url", "deviceRequest is padded base64url.", arg(deviceRequest(), undefined, "org-iso-mdoc", true), "base64url-padding", "§2, §8.2");
  bad("wrong-doc-type", "The ItemsRequest asks for another docType.", arg(deviceRequest(itemsRequest({ docType: "org.iso.18013.5.1.mDL" }))), "doc-type", "§8.1, §8.4");
  bad("intent-not-bool", "intentToRetain is a string.", arg(deviceRequest(itemsRequest({ intent: "yes" }))), "intent-to-retain", "§8.4");
  bad("missing-request-info", "No requestInfo carrier (the request travels only there, D7).", arg(deviceRequest(itemsRequest({ requestInfo: null }))), "request-info-missing", "D7, §8.2");
  bad("request-info-invalid", "requestInfo holds JSON that isn't a valid SMART request.", arg(deviceRequest(itemsRequest({ requestInfo: new Map([[SMART_REQUEST_INFO_KEY, JSON.stringify({ type: "nope" })]]) }))), "smart-request-invalid", "§8.4, §5");
  bad("unknown-version", "DeviceRequest version 9.0.", arg(deviceRequest(itemsRequest(), "9.0")), "device-request-version", "§8.4");
  {
    const badKey = cborEncode(["dcapi", new Map<unknown, unknown>([["nonce", crypto.getRandomValues(new Uint8Array(16))], ["recipientPublicKey", new Map<number, unknown>([[1, 2], [-1, 7], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]])]])]);
    bad("encryption-key-wrong-curve", "encryptionInfo's recipient key has an unsupported crv (D11: security label).", arg(deviceRequest(), badKey), "encryption-key", "D11, §8.1");
    const wrongTag = cborEncode(["other", new Map<unknown, unknown>([["nonce", crypto.getRandomValues(new Uint8Array(16))], ["recipientPublicKey", publicJwkToCoseKey(synthPublicJwk)]])]);
    bad("encryption-info-wrong-tag", "encryptionInfo's first entry is not \"dcapi\".", arg(deviceRequest(), wrongTag), "encryption-info", "A.5");
  }
  add({
    capability: cap, slug: "companion-element-present", status: "pending", pendingOn: "D7 follow-up: must a wallet ignore, or reject, a request that still requests a smart_request_b64u.* element?",
    description: "The ItemsRequest also requests the removed companion element (D7).", rule: "D7",
    inputs: files(cap, "companion-element-present", { navigatorArgument: json(arg(deviceRequest(itemsRequest({ companion: true })))) }),
    expected: { valid: true, outputs: { smartRequest: write(`${cap}/companion-element-present/expected-smart-request.json`, expectedSmart) } },
  });
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
  await tcase("capture-v2", "The real capture's origin (http, non-default port) and encryptionInfo.", read(join(CAPTURE_REQ, "metadata.json")) && JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin, capEnc, "§8.3");
  await tcase("https-default-port", "An https origin with no port.", ORIGIN, synthEncInfoB64u, "§8.3");
  await tcase("https-explicit-port", "An https origin with a non-default port.", "https://clinic.example:8443", synthEncInfoB64u, "§8.3");
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
    capability: cap, slug: "capture-v2", description: "Open the real capture's response.", rule: "§8.5, A.5",
    inputs: inputs("capture-v2", JSON.parse(read(join(CAPTURE_RESP, "credential.json"))), read(join(CAPTURE_REQ, "recipient-private.jwk.json")), capOrigin, capEnc),
    expected: { valid: true, outputs: { deviceResponse: write(`${cap}/capture-v2/expected-device-response.cbor`, readBytes(join(CAPTURE_RESP, "device-response.cbor"))) } },
  });
  const dr = await buildMdoc(synthResponseJson, synthTranscript, synthOtherTranscript);
  const good = await seal(dr, synthTranscript, synthPublicJwk);
  const jwk = json(synthPrivateJwk);
  add({
    capability: cap, slug: "synthetic", description: "Open a response sealed by the reference code.", rule: "§8.5",
    inputs: inputs("synthetic", good, jwk, ORIGIN, synthEncInfoB64u),
    expected: { valid: true, outputs: { deviceResponse: write(`${cap}/synthetic/expected-device-response.cbor`, dr) } },
  });
  const bad = (slug: string, description: string, credential: unknown, reason: string, rule: string) =>
    add({ capability: cap, slug, description, rule, inputs: inputs(slug, credential, jwk, ORIGIN, synthEncInfoB64u), expected: { valid: false, reason } });
  bad("wrong-origin", "Sealed with the transcript for another origin: must not open.", await seal(dr, synthOtherTranscript, synthPublicJwk), "hpke-open", "§8.3, §8.5");
  {
    const decoded = cborDecode(base64UrlDecodeBytes(good.data.response)) as [string, Map<string, Uint8Array>];
    const fields = new Map(decoded[1]);
    fields.set("cipherText", flip(fields.get("cipherText")!));
    bad("tampered-ciphertext", "One ciphertext bit flipped.", { protocol: "org-iso-mdoc", data: { response: base64UrlEncodeBytes(cborEncode(["dcapi", fields])) } }, "hpke-open", "§8.5");
    bad("wrong-response-tag", "The response's first entry is not \"dcapi\".", { protocol: "org-iso-mdoc", data: { response: base64UrlEncodeBytes(cborEncode(["other", decoded[1]])) } }, "dcapi-response", "A.6");
  }
  bad("padded-base64url", "data.response is padded base64url.", { protocol: "org-iso-mdoc", data: { response: good.data.response + "=".repeat((4 - (good.data.response.length % 4)) % 4 || 4) } }, "base64url-padding", "§8.5");
  bad("wrong-protocol", "The credential's protocol is not org-iso-mdoc.", { protocol: "openid4vp", data: good.data }, "protocol", "§8.5");
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
  add1("capture-v2", "The real capture's DeviceResponse (detached device signature).", readBytes(join(CAPTURE_RESP, "device-response.cbor")), JSON.parse(read(join(CAPTURE_RESP, "credential.json"))), { valid: true }, "§8.4, §8.5, D2", {
    origin: capOrigin, encB64u: read(join(CAPTURE_REQ, "encryption-info.b64u")).trim(), transcript: readBytes(join(CAPTURE_REQ, "session-transcript.cbor")),
    // Just after the MSO was signed (the capture's capturedAt is 28 s earlier: host and emulator clocks differ).
    now: "2026-09-26T13:15:30Z", jwk: read(join(CAPTURE_REQ, "recipient-private.jwk.json")),
  });
  {
    const v1Meta = JSON.parse(read(join(CAPTURE_V1_REQ, "metadata.json")));
    add1("capture-v1-attached-equal", "The pre-fix capture: device signature payload attached but equal to the rebuilt DeviceAuthentication. Accepted (D2).", readBytes(join(CAPTURE_V1_RESP, "device-response.cbor")), JSON.parse(read(join(CAPTURE_V1_RESP, "credential.json"))), { valid: true }, "D2", {
      origin: v1Meta.origin, encB64u: read(join(CAPTURE_V1_REQ, "encryption-info.b64u")).trim(), transcript: readBytes(join(CAPTURE_V1_REQ, "session-transcript.cbor")),
      now: "2026-05-03T03:33:00Z", jwk: read(join(CAPTURE_V1_REQ, "recipient-private.jwk.json")),
    });
  }
  const one = async (slug: string, description: string, knobs: MdocKnobs, expected: Expected, rule: string, status?: Case["status"], pendingOn?: string, now?: string) => {
    const dr = await buildMdoc(synthResponseJson, synthTranscript, synthOtherTranscript, knobs);
    add1(slug, description, dr, await seal(dr, synthTranscript, synthPublicJwk), expected, rule, { status, pendingOn, now });
  };
  await one("synthetic", "A reference-built DeviceResponse with a detached device signature.", {}, { valid: true }, "§8.4, D2");
  await one("unknown-top-level-key", "An unknown top-level DeviceResponse key is ignored (D11).", { extraTopLevelKey: true }, { valid: true }, "D11");
  await one("unknown-unprotected-header", "An unknown unprotected header label in issuerAuth is ignored (D11).", { extraUnprotectedHeader: true }, { valid: true }, "D11");
  await one("attached-payload-other-session", "Device signature carries an attached payload built for another origin's transcript.", { attachDevicePayload: "other-session" }, { valid: false, reason: "device-signature" }, "D2, §8.5");
  await one("tampered-device-signature", "One bit of the device signature flipped.", { tamperDeviceSignature: true }, { valid: false, reason: "device-signature" }, "§8.5");
  await one("tampered-issuer-signature", "One bit of the issuer signature flipped.", { tamperIssuerSignature: true }, { valid: false, reason: "issuer-signature" }, "§8.5, D1");
  await one("missing-validity-info", "The MSO has no validityInfo.", { omitValidityInfo: true }, { valid: false, reason: "mso-validity-info" }, "D2, ISO 18013-5 MSO");
  await one("digest-mismatch", "The issuer-signed item changed after the MSO was signed.", { tamperItemAfterSigning: true }, { valid: false, reason: "digest" }, "§8.5");
  await one("digest-missing", "The MSO has no digest for the item's digestID.", { omitDigest: true }, { valid: false, reason: "digest" }, "§8.5");
  await one("document-doc-type", "The document's docType isn't org.smarthealthit.checkin.1.", { documentDocType: "org.iso.18013.5.1.mDL", msoDocType: "org.iso.18013.5.1.mDL" }, { valid: false, reason: "doc-type" }, "§8.1, §8.5");
  await one("mso-doc-type-mismatch", "The MSO's docType differs from the document's.", { msoDocType: "org.example.other" }, { valid: false, reason: "doc-type" }, "ISO 18013-5, §8.5");
  await one("status-not-ok", "DeviceResponse status is 10.", { status: 10 }, { valid: false, reason: "device-response-status" }, "§8.5");
  await one("version-unknown", "DeviceResponse version is 9.0.", { version: "9.0" }, { valid: false, reason: "device-response-version" }, "§8.5");
  await one("unknown-alg", "issuerAuth's protected alg is an unknown value (D11: security label).", { issuerAlg: -65535 }, { valid: false, reason: "alg" }, "D11, §8.1");
  await one("unsupported-digest-algorithm", "The MSO's digestAlgorithm is SHA-512 (D11: security label; 1.0 uses SHA-256).", { digestAlgorithm: "SHA-512" }, { valid: false, reason: "digest-algorithm" }, "D11, §8.1");
  await one("missing-response-element", "The document carries another element instead of smart_health_checkin_response.", { elementIdentifier: "something_else" }, { valid: false, reason: "response-element" }, "§8.1, §8.5");
  await one("two-documents", "Two documents in the DeviceResponse.", { secondDocument: true }, { valid: false, reason: "documents" }, "A.7", "pending", "Exactly one document: the rewritten §8 has to say so.");
  await one("expired", "Checked after the MSO's validUntil.", {}, { valid: false, reason: "mso-expired" }, "ISO 18013-5 validityInfo", "pending", "Whether verifiers check the validity window.", "2026-10-05T00:00:00Z");
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
  w("capture-v2-request", "Answer the real capture's request; the reference verifier must accept the result.",
    captureNavigatorArgument, captureResponse,
    read(join(CAPTURE_REQ, "recipient-private.jwk.json")), JSON.parse(read(join(CAPTURE_REQ, "metadata.json"))).origin,
    read(join(CAPTURE_REQ, "encryption-info.b64u")).trim(), "§8.4");
  w("synthetic-request", "Answer a reference-built request.", synth.navigatorArgument, JSON.parse(synthResponseJson), json(synthPrivateJwk), ORIGIN, synthEncInfoB64u, "§8.4");
}

// ---------------------------------------------------------------- manifest

const capabilities: Record<string, string> = {
  "request-json": "Validate a SMART request (JSON text). Valid or not.",
  "response-json": "Validate a SMART response's shape on its own. Valid or not.",
  "cross-validation": "Validate a SMART response against the request it answers (§6.4). Valid or not; some cases also give a per-Artifact outcome.",
  "request-cbor": "Wallet side: read a navigator.credentials.get argument; recover the SMART request, or reject.",
  transcript: "Build SessionTranscript bytes from an origin and the encryptionInfo base64url string.",
  "hpke-open": "Verifier side: open a credential with the recipient private key and the transcript; recover the DeviceResponse bytes, or reject.",
  "mdoc-verify": "Verifier side: check a DeviceResponse against the session transcript: version, status, docType, issuer signature, digests, validityInfo, device signature, the response element. Valid or not.",
  "wallet-response": "Wallet side: answer a request with a given SMART response. The reference verifier opens and checks the result.",
};
const order = Object.keys(capabilities);
cases.sort((a, b) => order.indexOf(a.capability) - order.indexOf(b.capability));
writeFileSync(join(OUT, "manifest.json"), json({ formatVersion: 1, capabilities, cases }));
const count = (f: (c: Case) => boolean) => cases.filter(f).length;
console.log(`${cases.length} cases (${count((c) => c.expected.valid)} positive, ${count((c) => !c.expected.valid)} negative, ${count((c) => c.status === "pending")} pending)`);
for (const cap of order) console.log(`  ${cap}: ${count((c) => c.capability === cap)}`);

export {};
