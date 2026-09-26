// Checks every example marked data-check in the model explainer against the
// client library's validators, so the page can't drift from the spec.
//   data-check="request"   a whole request
//   data-check="item"      one request item, wrapped in a minimal request
//   data-check="response"  a whole response; data-request names the request's <pre> id
import {
  validateResponseAgainstRequest,
  validateSmartCheckinRequest,
} from "@smart-health-checkin/client/model";

const file = process.argv[2] ?? new URL("../site/smart-model-explainer.html", import.meta.url).pathname;
const html = await Bun.file(file).text();
const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const blocks = [...html.matchAll(/<pre([^>]*\bdata-check="[^"]+"[^>]*)>([\s\S]*?)<\/pre>/g)].map((m) => {
  const attr = (name: string) => m[1].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
  const line = html.slice(0, m.index).split("\n").length;
  return { check: attr("data-check")!, id: attr("id"), request: attr("data-request"), text: unescape(m[2]), line };
});

let failures = 0;
const byId = new Map<string, unknown>();
const fail = (line: number, msg: string) => { failures++; console.error(`line ${line}: ${msg}`); };

for (const b of blocks) {
  let value: unknown;
  try { value = JSON.parse(b.text); } catch (e) { fail(b.line, `not JSON: ${(e as Error).message}`); continue; }
  if (b.id) byId.set(b.id, value);
  if (b.check === "request") {
    const r = validateSmartCheckinRequest(value);
    if (!r.ok) fail(b.line, r.error);
  } else if (b.check === "item") {
    const r = validateSmartCheckinRequest({
      type: "smart-health-checkin-request", version: "1", id: "x", purpose: "x", fhirVersions: ["4.0.1"], items: [value],
    });
    if (!r.ok) fail(b.line, r.error);
  } else if (b.check === "response") {
    const request = b.request && byId.get(b.request);
    if (!request) { fail(b.line, `data-request "${b.request}" not found above`); continue; }
    const r = validateResponseAgainstRequest(request, value);
    if (!r.ok) fail(b.line, r.error);
  } else {
    fail(b.line, `unknown data-check "${b.check}"`);
  }
}

if (failures) { console.error(`${failures} of ${blocks.length} explainer examples failed`); process.exit(1); }
console.log(`All ${blocks.length} explainer examples are valid`);
