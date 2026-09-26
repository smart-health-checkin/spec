// Validates the JSON examples in spec.md with the client library's validators.
// A fenced block opts in through its info string:
//   ```json check=request id=<name>
//   ```json check=response request=<name>
import { validateResponseAgainstRequest, validateSmartCheckinRequest } from "@smart-health-checkin/client/model";

const md = await Bun.file(new URL("../spec.md", import.meta.url).pathname).text();
const blocks = [...md.matchAll(/^```json[ \t]+([^\n]*)\n([\s\S]*?)^```/gm)].map((m) => ({
  attrs: Object.fromEntries([...m[1].matchAll(/(\w+)=(\S+)/g)].map((a) => [a[1], a[2]])),
  text: m[2],
  line: md.slice(0, m.index).split("\n").length,
}));

const byId = new Map<string, unknown>();
let failures = 0;
const fail = (line: number, msg: string) => { failures++; console.error(`spec.md:${line}: ${msg}`); };
// Since 0.3 a result can be ok while setting parts aside (one item unsupported,
// one Artifact disregarded). An example has to be sound all the way through.
const strict = (line: number, r: any) => {
  for (const u of r.unsupportedItems ?? []) fail(line, `item ${u.id} is unsupported: ${u.message} [${u.rule}]`);
  for (const a of r.artifacts ?? []) if (!a.usable) fail(line, `artifact ${a.id ?? a.index} is disregarded: ${a.problems.map((p: any) => `${p.message} [${p.rule}]`).join("; ")}`);
  for (const i of r.items ?? []) {
    if (i.status === undefined) fail(line, `item ${i.id} has no valid status`);
    for (const p of i.problems ?? []) fail(line, `item ${i.id}: ${p.message} [${p.rule}]`);
  }
};
let checked = 0;
for (const b of blocks) {
  if (!b.attrs.check) continue;
  checked++;
  let value: unknown;
  try { value = JSON.parse(b.text); } catch (e) { fail(b.line, `not JSON: ${(e as Error).message}`); continue; }
  if (b.attrs.id) byId.set(b.attrs.id, value);
  if (b.attrs.check === "request") {
    const r = validateSmartCheckinRequest(value);
    if (!r.ok) fail(b.line, r.error);
    else strict(b.line, r);
  } else if (b.attrs.check === "response") {
    const request = byId.get(b.attrs.request);
    if (!request) { fail(b.line, `request "${b.attrs.request}" not defined above`); continue; }
    const r = validateResponseAgainstRequest(request, value);
    if (!r.ok) fail(b.line, r.error);
    else strict(b.line, r);
  } else fail(b.line, `unknown check "${b.attrs.check}"`);
}
if (failures) { console.error(`${failures} of ${checked} spec examples failed`); process.exit(1); }
if (!checked) { console.error("no checked examples found in spec.md"); process.exit(1); }
console.log(`All ${checked} spec examples are valid`);
