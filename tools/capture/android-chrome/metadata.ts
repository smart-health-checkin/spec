// Writes metadata.json for both capture fixtures, and checks that the verifier
// page and the wallet saw the same request and response.
import { createHash } from "node:crypto";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [RUN, REQ, RES, WORK] = process.argv.slice(2) as [string, string, string, string];

const j = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const t = (p: string) => readFileSync(p, "utf8").trim();
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const must = (c: unknown, m: string) => { if (!c) { console.error("metadata: " + m); process.exit(1); } };
const run = j(join(RUN, "metadata.json"));
const page = j(join(WORK, "artifacts.json"));
const pageCred = j(join(WORK, "credential.json"));
const env = j(join(WORK, "capture-env.json"));
must(page.origin === run.origin, "origin differs");
must(page.deviceRequest.base64url === t(join(REQ, "device-request.b64u")), "wallet saw a different DeviceRequest");
must(page.encryptionInfo.base64url === t(join(REQ, "encryption-info.b64u")), "wallet saw a different encryptionInfo");
must(page.sessionTranscript.hex === t(join(REQ, "session-transcript.cbor.hex")), "SessionTranscripts differ");
must(JSON.stringify(pageCred) === JSON.stringify(j(join(RES, "credential.json"))), "page received a different credential");
const hashes = (dir: string, names: string[]) => Object.fromEntries(names.filter((n) => existsSync(join(dir, n))).map((n) => [n, sha(join(dir, n))]));
const note = `Real Chrome/Android Credential Manager SMART Health Check-in request using demo wallet data only. Captured with reference Android wallet ${env.wallet.release} (detached device signature) on an Android ${env.android} emulator (Chrome ${env.chrome.split(".")[0]}). Verifier side built with the request builder in client library ${env.client}.`;
const reqMeta = {
  id: "android-chrome-capture",
  kind: "positive-smart-health-checkin-real-platform-request",
  source: `android handler run-${run.runId.replace(/^run-/, "")}; verifier page on ${run.origin}`,
  capturedAt: run.at,
  origin: run.origin,
  originSource: run.originSource,
  originIsPopulated: run.originIsPopulated,
  packageName: run.packageName,
  protocol: run.protocol,
  containsPhi: false,
  note,
  wallet: env.wallet,
  client: { release: env.client },
  chrome: env.chrome,
  readerAuth: { present: run.readerAuthPresent, signatureValid: run.readerAuthSignatureValid, certificateSubject: run.readerAuthCertificateSubject },
  hpkeRecipientPrivateJwk: {
    included: true,
    intentionallyPublicTestFixture: true,
    purpose: "Allows offline HPKE open of the matching checked-in encrypted dcapi-response.cbor. Never reuse this key outside this fixture.",
  },
  sizes: {
    deviceRequestB64u: run.deviceRequestB64uSize,
    deviceRequestBytes: run.deviceRequestByteSize,
    encryptionInfoB64u: run.encryptionInfoB64uSize,
    encryptionInfoBytes: run.encryptionInfoByteSize,
    sessionTranscriptBytes: run.sessionTranscriptByteSize,
  },
  sha256: hashes(REQ, ["request.json", "navigator-credentials-get.arg.json", "device-request.b64u", "device-request.cbor", "items-request.cbor", "items-request-tag24.cbor", "encryption-info.b64u", "encryption-info.cbor", "session-transcript.cbor", "smart-request.expected.json", "reader-auth.cbor", "recipient-private.jwk.json"]),
};
const resMeta = {
  id: "android-chrome-capture",
  kind: "positive-smart-health-checkin-real-platform-response",
  source: run.runId.replace(/^run-/, "android handler run-"),
  capturedAt: run.at,
  origin: run.origin,
  protocol: run.protocol,
  packageName: "org.smarthealthit.checkin.wallet",
  containsPhi: false,
  note: "Matching real Android wallet response captured alongside dcapi-requests/android-chrome-capture/. Demo data only. deviceSignature has a detached (null) payload per ISO 18013-5; the MSO carries validityInfo.",
  wallet: env.wallet,
  deviceResponse: { version: "1.0", status: 0 },
  deviceSignaturePayload: "detached",
  sourceRequestFixture: "fixtures/dcapi-requests/android-chrome-capture",
  sha256: hashes(RES, ["credential.json", "dcapi-response.cbor", "device-response.cbor", "wallet-response.digital-credential.json", "smart-response.expected.json", "session-transcript.cbor"]),
};
writeFileSync(join(REQ, "metadata.json"), JSON.stringify(reqMeta, null, 2) + "\n");
writeFileSync(join(RES, "metadata.json"), JSON.stringify(resMeta, null, 2) + "\n");
console.log("metadata written; page and wallet agree");
