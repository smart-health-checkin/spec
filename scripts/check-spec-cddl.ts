// Validates real captured bytes against the normative CDDL in spec.md §8.7,
// using the `cddl` tool (gem install cddl). Each fixture file is checked
// against the rule it should match.
import { $ } from "bun";

const root = new URL("..", import.meta.url).pathname;
const md = await Bun.file(`${root}spec.md`).text();
const cddl = [...md.matchAll(/^```cddl\n([\s\S]*?)^```/gm)].map((m) => m[1]).join("\n");
const prelude = "";

const REQ = "fixtures/dcapi-requests/real-chrome-android-smart-checkin-v2";
const RES = "fixtures/responses/real-chrome-android-smart-checkin-v2";
const cases: [string, string][] = [
  ["DeviceRequest", `${REQ}/device-request.cbor`],
  ["ItemsRequestBytes", `${REQ}/items-request-tag24.cbor`],
  ["ItemsRequest", `${REQ}/items-request.cbor`],
  ["EncryptionInfo", `${REQ}/encryption-info.cbor`],
  ["SessionTranscript", `${REQ}/session-transcript.cbor`],
  ["ReaderAuthenticationBytes", `${REQ}/reader-auth-detached-payload.cbor`],
  ["DetachedSign1", `${REQ}/reader-auth.cbor`],
  ["DcapiResponse", `${RES}/dcapi-response.cbor`],
  ["DeviceResponse", `${RES}/device-response.cbor`],
  ["IssuerSignedItemBytes", `${RES}/issuer-signed-item-tag24.cbor`],
  ["MobileSecurityObject", `${RES}/mso.cbor`],
  ["DeviceAuthenticationBytes", `${RES}/device-authentication.cbor`],
];

const tool = process.env.CDDL ?? "cddl";
if ((await $`which ${tool}`.quiet().nothrow()).exitCode !== 0 && !(await Bun.file(tool).exists())) {
  console.error("cddl tool not found (gem install cddl); skipping the CDDL check");
  process.exit(process.env.CI ? 1 : 0);
}
let failures = 0;
const dir = await $`mktemp -d`.text();
for (const [rule, file] of cases) {
  const schema = `${dir.trim()}/${rule}.cddl`;
  await Bun.write(schema, `start = ${rule}\n${prelude}${cddl}`);
  const r = await $`${tool} ${schema} validate ${root}${file}`.quiet().nothrow();
  const out = (r.stdout.toString() + r.stderr.toString()).trim();
  if (r.exitCode !== 0 || /error|fail|mismatch/i.test(out)) {
    failures++;
    console.error(`FAIL ${rule} <- ${file}\n${out.split("\n").slice(0, 8).join("\n")}`);
  }
}
// The pre-fix capture has an attached device-signature payload, which 1.0
// forbids; the CDDL must reject it.
{
  const schema = `${dir.trim()}/neg.cddl`;
  await Bun.write(schema, `start = DeviceResponse\n${prelude}${cddl}`);
  const r = await $`${tool} ${schema} validate ${root}fixtures/responses/real-chrome-android-smart-checkin/device-response.cbor`.quiet().nothrow();
  if (r.exitCode === 0) { failures++; console.error("FAIL the pre-fix DeviceResponse (attached device signature) was accepted"); }
}
if (failures) { console.error(`${failures} of ${cases.length} CDDL checks failed`); process.exit(1); }
console.log(`All ${cases.length} fixture structures match the spec's CDDL`);
