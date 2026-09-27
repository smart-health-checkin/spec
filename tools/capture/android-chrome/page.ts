// The capture's Verifier page: builds the request with the client library,
// reports every request artifact (including its HPKE private key, which is
// published with the fixture) to the capture server, then sends the request
// through the Digital Credentials API and reports the credential it gets back.
import {
  base64UrlEncodeBytes,
  buildOrgIsoMdocRequest,
  hex,
  MDOC_DOC_TYPE,
  MDOC_NAMESPACE,
  PROTOCOL_ID,
  SMART_RESPONSE_ELEMENT_ID,
} from "@smart-health-checkin/client/wire";

const setStatus = (s: string) => { document.getElementById("status")!.textContent = s; };
const post = (path: string, body: string) => fetch(path, { method: "POST", body });

async function main() {
  const smartRequest = await (await fetch("smart-request.json")).json();
  const origin = location.origin;
  const b = await buildOrgIsoMdocRequest(smartRequest, { origin });
  const artifacts = {
    origin,
    protocol: PROTOCOL_ID,
    docType: MDOC_DOC_TYPE,
    namespace: MDOC_NAMESPACE,
    responseElement: SMART_RESPONSE_ELEMENT_ID,
    navigatorArgument: b.navigatorArgument,
    recipientPublicJwk: b.verifierPublicJwk,
    recipientPrivateJwk: await crypto.subtle.exportKey("jwk", b.verifierKeyPair.privateKey),
    deviceRequest: { base64url: base64UrlEncodeBytes(b.deviceRequestBytes), hex: hex(b.deviceRequestBytes) },
    encryptionInfo: { base64url: base64UrlEncodeBytes(b.encryptionInfoBytes), hex: hex(b.encryptionInfoBytes) },
    sessionTranscript: { base64url: base64UrlEncodeBytes(b.sessionTranscriptBytes!), hex: hex(b.sessionTranscriptBytes!) },
    readerAuth: { hex: hex(b.readerAuthBytes!) },
    note: "Captured at the verifier page (client library request builder) before navigator.credentials.get. The private JWK is intentionally public test material for offline HPKE opening.",
  };
  await post("/artifacts", JSON.stringify(artifacts, null, 2) + "\n");
  setStatus("ready");

  document.getElementById("go")!.addEventListener("click", async () => {
    setStatus("waiting for the wallet");
    try {
      const credential = (await navigator.credentials.get(b.navigatorArgument as CredentialRequestOptions)) as unknown as { protocol: string; data: unknown };
      await post("/credential", JSON.stringify({ protocol: credential.protocol, data: credential.data }, null, 2) + "\n");
      setStatus("done");
    } catch (e) {
      await post("/error", String(e));
      setStatus(`error: ${(e as Error).message}`);
    }
  });
}

main().catch((e) => post("/error", String(e)));
