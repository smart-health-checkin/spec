// Computes spec.md Appendix A from the android-chrome-capture
// capture, checking every step against the fixture's own files.
//   bun scripts/worked-example.ts          rewrite the appendix in spec.md
//   bun scripts/worked-example.ts --check  fail if spec.md's appendix differs
import {
  base64UrlDecodeBytes,
  buildDcapiSessionTranscript,
  buildDeviceAuthenticationBytes,
  buildReaderAuthenticationBytes,
  bytesEqual,
  CborTag,
  cborDecode,
  cborDiagnostic,
  cborEncode,
  hex,
  importCertificatePublicKey,
  mapGet,
  openWalletResponse,
  sha256,
  verifyDeviceResponseSignatures,
  verifyReaderAuthSignature,
} from "@smart-health-checkin/client/wire";

const root = new URL("..", import.meta.url).pathname;
const REQ = `${root}fixtures/dcapi-requests/android-chrome-capture`;
const RES = `${root}fixtures/responses/android-chrome-capture`;
const bytes = async (p: string) => new Uint8Array(await Bun.file(p).arrayBuffer());
const text = async (p: string) => (await Bun.file(p).text()).trim();
const json = async (p: string) => JSON.parse(await Bun.file(p).text());

function must(cond: unknown, what: string): asserts cond {
  if (!cond) { console.error(`worked example: ${what}`); process.exit(1); }
}
const short = (b: Uint8Array, keep = 40) =>
  b.length <= keep ? hex(b) : `${hex(b.slice(0, keep))}… (${b.length} bytes)`;
const block = (s: string) => "```text\n" + s + "\n```";

// ---- Request side
const meta = await json(`${REQ}/metadata.json`);
const origin: string = meta.origin;
const encryptionInfoB64u = await text(`${REQ}/encryption-info.b64u`);
const encryptionInfo = base64UrlDecodeBytes(encryptionInfoB64u);
must(bytesEqual(encryptionInfo, await bytes(`${REQ}/encryption-info.cbor`)), "encryption-info.b64u and .cbor differ");

const dcapiInfo = cborEncode([encryptionInfoB64u, origin]);
const handoverHash = await sha256(dcapiInfo);
const transcript = await buildDcapiSessionTranscript({ origin, encryptionInfo: encryptionInfoB64u });
must(bytesEqual(transcript, await bytes(`${REQ}/session-transcript.cbor`)), "transcript differs from the request fixture");
must(bytesEqual(transcript, await bytes(`${RES}/session-transcript.cbor`)), "transcript differs from the response fixture");

const deviceRequest = cborDecode(await bytes(`${REQ}/device-request.cbor`));
const docRequest = (mapGet(deviceRequest, "docRequests") as unknown[])[0];
const itemsRequestTag = mapGet(docRequest, "itemsRequest") as CborTag;
must(itemsRequestTag instanceof CborTag && itemsRequestTag.tag === 24, "itemsRequest is not tag 24");
const itemsRequestBytes = cborEncode(itemsRequestTag);
must(bytesEqual(itemsRequestBytes, await bytes(`${REQ}/items-request-tag24.cbor`)), "ItemsRequestBytes differ from the fixture");
const readerAuth = mapGet(docRequest, "readerAuth") as unknown[];
must(Array.isArray(readerAuth) && readerAuth[2] === null, "readerAuth payload is not null");
const readerAuthenticationBytes = buildReaderAuthenticationBytes({ sessionTranscriptBytes: transcript, itemsRequestTag24Bytes: itemsRequestBytes });
must(bytesEqual(readerAuthenticationBytes, await bytes(`${REQ}/reader-auth-detached-payload.cbor`)), "ReaderAuthenticationBytes differ from the fixture");
const readerChain = (readerAuth[1] as Map<unknown, unknown>).get(33);
const readerCert = (Array.isArray(readerChain) ? readerChain[0] : readerChain) as Uint8Array;
const readerOk = await verifyReaderAuthSignature({
  readerAuthBytes: cborEncode(readerAuth),
  readerPublicKey: await importCertificatePublicKey(readerCert),
  sessionTranscriptBytes: transcript,
  itemsRequestTag24Bytes: itemsRequestBytes,
});
must(readerOk, "readerAuth does not verify");

// ---- Response side
const dcapiResponseBytes = await bytes(`${RES}/dcapi-response.cbor`);
const dcapiResponse = cborDecode(dcapiResponseBytes) as [string, Map<string, Uint8Array>];
const enc = mapGet(dcapiResponse[1], "enc") as Uint8Array;
const cipherText = mapGet(dcapiResponse[1], "cipherText") as Uint8Array;
const jwk = await json(`${REQ}/recipient-private.jwk.json`);
const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const { d: _d, key_ops: _k, ext: _e, ...publicJwk } = jwk;
const opened = await openWalletResponse({
  response: { protocol: "org-iso-mdoc", data: { response: Buffer.from(dcapiResponseBytes).toString("base64url") } },
  recipientPrivateKey: privateKey,
  recipientPublicJwk: publicJwk,
  sessionTranscript: transcript,
});
const deviceResponseBytes = opened.deviceResponseBytes;
must(bytesEqual(deviceResponseBytes, await bytes(`${RES}/device-response.cbor`)), "opened DeviceResponse differs from the fixture");

const deviceResponse = cborDecode(deviceResponseBytes);
const doc = (mapGet(deviceResponse, "documents") as unknown[])[0];
const issuerSigned = mapGet(doc, "issuerSigned");
const itemTag = (mapGet(mapGet(issuerSigned, "nameSpaces"), "org.smarthealthit.checkin") as CborTag[])[0];
const issuerSignedItemBytes = cborEncode(itemTag);
must(bytesEqual(issuerSignedItemBytes, await bytes(`${RES}/issuer-signed-item-tag24.cbor`)), "IssuerSignedItemBytes differ from the fixture");
const item = cborDecode(itemTag.value as Uint8Array);
const digestID = mapGet(item, "digestID") as number;
const random = mapGet(item, "random") as Uint8Array;
const elementValue = mapGet(item, "elementValue") as string;
const valueDigest = await sha256(issuerSignedItemBytes);

const issuerAuth = mapGet(issuerSigned, "issuerAuth") as unknown[];
const issuerProtected = issuerAuth[0] as Uint8Array;
const issuerChain = (issuerAuth[1] as Map<unknown, unknown>).get(33);
const msoBytes = issuerAuth[2] as Uint8Array;
const mso = cborDecode((cborDecode(msoBytes) as CborTag).value as Uint8Array);
const msoDigest = (mapGet(mapGet(mso, "valueDigests"), "org.smarthealthit.checkin") as Map<number, Uint8Array>).get(digestID)!;
must(bytesEqual(valueDigest, msoDigest), "value digest does not match the MSO");
const validity = mapGet(mso, "validityInfo") as Map<string, CborTag>;
const deviceKey = mapGet(mapGet(mso, "deviceKeyInfo"), "deviceKey") as Map<number, unknown>;

const deviceSigned = mapGet(doc, "deviceSigned");
const deviceNameSpacesBytes = cborEncode(mapGet(deviceSigned, "nameSpaces"));
const deviceSignature = mapGet(mapGet(deviceSigned, "deviceAuth"), "deviceSignature") as unknown[];
must(deviceSignature[2] === null, "device signature payload is not null");
const deviceAuthenticationBytes = buildDeviceAuthenticationBytes({
  sessionTranscript: transcript,
  docType: "org.smarthealthit.checkin.1",
  deviceNameSpaces: mapGet(deviceSigned, "nameSpaces"),
});
must(bytesEqual(deviceAuthenticationBytes, await bytes(`${RES}/device-authentication.cbor`)), "DeviceAuthenticationBytes differ from the fixture");
const [v] = await verifyDeviceResponseSignatures({ deviceResponseBytes, sessionTranscript: transcript });
must(v.issuerAuth.signatureValid && v.deviceSignature.signatureValid && v.digests.allMatch, "signatures or digests do not verify");
const otherOrigin = await buildDcapiSessionTranscript({ origin: "https://other.example", encryptionInfo: encryptionInfoB64u });
const [w] = await verifyDeviceResponseSignatures({ deviceResponseBytes, sessionTranscript: otherOrigin });
must(!w.deviceSignature.signatureValid, "device signature verifies under another origin");
const smart = JSON.parse(elementValue);
must(smart.requestId === (await json(`${REQ}/smart-request.json`)).id, "requestId does not echo the request id");

const chainShape = (c: unknown) =>
  Array.isArray(c) ? (c.length === 1 ? "an array holding one certificate" : `an array of ${c.length} certificates`) : "one certificate byte string";
const date = (t: CborTag) => `0("${t.value}")`;

const out = `
**1. The request.** The Verifier at \`${origin}\` sent this \`encryptionInfo\` (base64url, ${encryptionInfoB64u.length} characters):

${block(encryptionInfoB64u)}

Decoded, it is:

${block(cborDiagnostic(cborDecode(encryptionInfo)))}

**2. \`dcapiInfo\` and the handover** (§8.3). \`dcapiInfo = CBOR([encryptionInfoBase64url, origin])\` is ${dcapiInfo.length} bytes, and its SHA-256 is the handover's second element:

${block(`dcapiInfo          ${short(dcapiInfo, 24)}\nSHA-256(dcapiInfo) ${hex(handoverHash)}`)}

**3. \`SessionTranscript\`.** \`CBOR([null, null, ["dcapi", hash]])\` is ${transcript.length} bytes. It is the HPKE \`info\`, and it appears as an array inside \`ReaderAuthentication\` and \`DeviceAuthentication\`:

${block(hex(transcript))}

**4. Reader authentication** (§8.6). \`ItemsRequestBytes\` is ${itemsRequestBytes.length} bytes (\`${hex(itemsRequestBytes.slice(0, 6))}…\`: tag 24, then a byte string). \`ReaderAuthenticationBytes\` is ${readerAuthenticationBytes.length} bytes, and \`readerAuth\` has payload \`null\` with \`x5chain\` in its unprotected header as ${chainShape(readerChain)}. Its ES256 signature over those bytes verifies.

**5. Encryption** (§8.5). The Wallet's \`dcapiResponse\` holds a ${enc.length}-byte \`enc\` and a ${cipherText.length}-byte \`cipherText\`:

${block(`enc ${short(enc, 65)}`)}

Opening it with the capture's private key and \`info = CBOR(SessionTranscript)\` yields the ${deviceResponseBytes.length}-byte \`DeviceResponse\`.

**6. The issuer-signed item and its digest** (§8.4). \`IssuerSignedItemBytes\` is ${issuerSignedItemBytes.length} bytes, with \`digestID\` ${digestID}, a ${random.length}-byte \`random\`, and a ${elementValue.length}-character \`elementValue\`. SHA-256 over all of it, tag included, equals the MSO's \`valueDigests\` entry for digestID ${digestID}:

${block(`SHA-256(IssuerSignedItemBytes) ${hex(valueDigest)}`)}

**7. The MSO and \`issuerAuth\`.** \`issuerAuth\` has protected header \`${hex(issuerProtected)}\` (\`{1: -7}\`), \`x5chain\` in its unprotected header as ${chainShape(issuerChain)}, and an attached ${msoBytes.length}-byte \`MobileSecurityObjectBytes\` payload. The MSO holds:

${block([
  `version          "${mapGet(mso, "version")}"`,
  `digestAlgorithm  "${mapGet(mso, "digestAlgorithm")}"`,
  `docType          "${mapGet(mso, "docType")}"`,
  `validityInfo     signed ${date(validity.get("signed")!)}`,
  `                 validFrom ${date(validity.get("validFrom")!)}`,
  `                 validUntil ${date(validity.get("validUntil")!)}`,
  `deviceKey        kty ${deviceKey.get(1)}, crv ${deviceKey.get(-1)}, x ${hex((deviceKey.get(-2) as Uint8Array).slice(0, 8))}…`,
].join("\n"))}

**8. Device authentication.** \`DeviceNameSpacesBytes\` is \`${hex(deviceNameSpacesBytes)}\` (tag 24 around an empty map). \`DeviceAuthenticationBytes\` is ${deviceAuthenticationBytes.length} bytes; the device signature has payload \`null\` and verifies over them with the MSO's \`deviceKey\`. Rebuilt with a different origin, the same signature fails.

**9. The SMART response.** The \`elementValue\` parses as a SMART response with \`requestId\` \`${smart.requestId}\`, ${smart.artifacts.length} Artifacts, and ${smart.requestStatus.length} status entries.
`.trim();

const specPath = `${root}spec.md`;
const spec = await Bun.file(specPath).text();
const begin = spec.indexOf("<!-- BEGIN worked-example");
const beginEnd = spec.indexOf("-->", begin) + 3;
const end = spec.indexOf("<!-- END worked-example -->");
must(begin >= 0 && end > begin, "worked-example markers not found in spec.md");
const updated = spec.slice(0, beginEnd) + "\n\n" + out + "\n\n" + spec.slice(end);
if (process.argv.includes("--check")) {
  must(updated === spec, "Appendix A is out of date: run bun scripts/worked-example.ts");
  console.log("Appendix A matches the fixture");
} else {
  await Bun.write(specPath, updated);
  console.log("Wrote Appendix A from the fixture");
}
