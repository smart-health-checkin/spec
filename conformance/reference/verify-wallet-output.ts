// The reference verifier for wallet-response cases. A wallet implementation's
// runner builds a credential for each wallet-response case and writes it to
// <outDir>/<case id with "/" → "_">.json; this script checks each one with the
// JS client library (which must be installed where it runs):
//
//   bun spec-conformance/reference/verify-wallet-output.ts <outDir> <known-failures.json>
//
// A credential passes when it opens with the case's recipient key and
// transcript, its issuer signature, digests, and device signature verify, the
// device signature's payload is detached (null), the MSO has validityInfo, and
// the element carries the case's SMART response. Cases listed in the
// known-failures file must still fail; exit status is non-zero otherwise.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CborTag,
  buildDcapiSessionTranscript,
  cborDecode,
  mapGet,
  openWalletResponse,
  verifyDeviceResponseSignatures,
} from "@smart-health-checkin/client/wire";

const [outDir, knownPath] = process.argv.slice(2);
if (!outDir || !knownPath) {
  console.error("usage: verify-wallet-output.ts <outDir> <known-failures.json>");
  process.exit(2);
}
const ROOT = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const known: Record<string, string> = JSON.parse(readFileSync(knownPath, "utf8")).knownFailures ?? {};
const text = (p: string) => readFileSync(join(ROOT, p), "utf8");

async function verify(c: { inputs: Record<string, string> }, credential: unknown): Promise<string | null> {
  const i = c.inputs;
  const jwk = JSON.parse(text(i.recipientPrivateJwk!));
  const key = await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const sessionTranscript = await buildDcapiSessionTranscript({ origin: text(i.origin!).trim(), encryptionInfo: text(i.encryptionInfo!).trim() });
  const opened = await openWalletResponse({ response: credential as never, recipientPrivateKey: key, recipientPublicJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, sessionTranscript });
  const [v] = await verifyDeviceResponseSignatures({ deviceResponseBytes: opened.deviceResponseBytes, sessionTranscript });
  if (!v?.issuerAuth.signatureValid) return "issuer signature";
  if (!v.digests.allMatch) return "digests";
  if (!v.deviceSignature.signatureValid) return "device signature";
  const doc = (mapGet(cborDecode(opened.deviceResponseBytes), "documents") as unknown[])[0];
  const deviceSignature = mapGet(mapGet(mapGet(doc, "deviceSigned"), "deviceAuth"), "deviceSignature") as unknown[];
  if (deviceSignature[2] !== null) return "device signature payload is attached, not detached";
  const issuerAuth = mapGet(mapGet(doc, "issuerSigned"), "issuerAuth") as unknown[];
  const mso = cborDecode((cborDecode(issuerAuth[2] as Uint8Array) as CborTag).value as Uint8Array);
  if (!(mapGet(mso, "validityInfo") instanceof Map)) return "MSO has no validityInfo";
  const items = mapGet(mapGet(mapGet(doc, "issuerSigned"), "nameSpaces"), "org.smarthealthit.checkin") as CborTag[];
  const element = mapGet(cborDecode(items[0]!.value as Uint8Array), "elementValue");
  if (typeof element !== "string" || !Bun.deepEquals(JSON.parse(element), JSON.parse(text(i.smartResponse!)))) return "SMART response differs";
  return null;
}

let bad = 0;
for (const c of manifest.cases.filter((c: { capability: string; status: string }) => c.capability === "wallet-response" && c.status !== "pending")) {
  const file = join(outDir, `${c.id.replace(/\//g, "_")}.json`);
  let problem: string | null;
  if (!existsSync(file)) problem = "no credential written";
  else {
    try {
      problem = await verify(c, JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      problem = (e as Error).message;
    }
  }
  const listed = known[c.id];
  if (listed && problem) console.log(`known  ${c.id}: ${problem}`);
  else if (listed) { bad++; console.log(`FIXED  ${c.id}: passes now; remove it from known failures`); }
  else if (problem) { bad++; console.log(`FAIL   ${c.id}: ${problem}`); }
  else console.log(`ok     ${c.id}`);
}
process.exit(bad ? 1 : 0);
