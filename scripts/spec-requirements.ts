// Extracts every requirement ID from spec.md into requirements.json, and
// checks the spec's normative text is well formed:
//   - each ID (**[PREFIX-N]**) is defined exactly once;
//   - every line with an all-caps BCP 14 keyword carries an ID (so no
//     normative text hides in notes, tables, or examples);
//   - TypeScript and CDDL blocks contain no BCP 14 keywords;
//   - every [ID] reference points at a defined ID.
// A numbered procedure step may be a plain imperative: the procedure's
// introduction (with its own ID) says the actor SHALL follow the steps.
//   bun scripts/spec-requirements.ts          write requirements.json
//   bun scripts/spec-requirements.ts --check  fail if requirements.json is stale
const root = new URL("..", import.meta.url).pathname;
const check = process.argv.includes("--check");
const md = await Bun.file(`${root}spec.md`).text();

const KEYWORD = /\b(MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/;
const DEF = /\*\*\[([A-Z]+(?:[0-9]+[A-Z]+)?-\d+)\]\*\*/g;
const REF = /(?<!\*\*)\[([A-Z]+(?:[0-9]+[A-Z]+)?-\d+)\](?!\*\*)/g;

// Who each requirement binds. Prefixes listed here are authoritative; for
// the others, the first role named in the text decides.
const PREFIX_ACTOR: Record<string, string> = {
  VRQ: "Verifier", VRS: "Verifier", XV: "Verifier", RA: "", WRQ: "Wallet", WRS: "Wallet",
  HOLD: "Wallet", ART: "Wallet", RSP: "Wallet", STAT: "", HPKE: "Wallet",
  REQ: "", ITEM: "", SEL: "", FORM: "", ACC: "", CAN: "Verifier, Wallet",
  TR: "Verifier, Wallet", ENC: "Verifier, Wallet", MD: "Verifier, Wallet", ALG: "Verifier, Wallet",
  JSON: "Verifier, Wallet", I18N: "Verifier, Wallet", PRIV: "Verifier, Wallet", CONF: "Implementer",
};
const ROLE = /\b(Verifiers and Wallets|Verifier|Wallet|Holder|deployment profile|extension|producer|receiver|both sides|Senders|Anyone parsing|Implementations|Software|conformance claim|product|user interfaces)\b/i;
const normalizeRole = (r: string) => {
  const l = r.toLowerCase();
  if (l.startsWith("verifiers and")) return "Verifier, Wallet";
  if (l === "both sides" || l === "senders" || l === "anyone parsing" || l === "implementations" || l === "software" || l === "producer" || l === "receiver" || l === "user interfaces") return "Verifier, Wallet";
  if (l === "deployment profile") return "Deployment profile";
  if (l === "extension") return "Extension author";
  if (l === "conformance claim" || l === "product") return "Implementer";
  return r[0].toUpperCase() + r.slice(1);
};

const plain = (s: string) =>
  s.replace(DEF, "").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*(\d+\.|[-*>])\s*/, "").replace(/\s+/g, " ").trim();

type Req = { id: string; section: string; actor: string; text: string };
const reqs: Req[] = [];
const problems: string[] = [];
let section = "";
let fence: string | undefined;
const lines = md.split("\n");
lines.forEach((line, i) => {
  const at = `spec.md:${i + 1}`;
  const f = line.match(/^\s*```(\w*)/);
  if (f) { fence = fence === undefined ? f[1] : undefined; return; }
  if (fence !== undefined) {
    if (["typescript", "cddl"].includes(fence) && KEYWORD.test(line)) problems.push(`${at}: BCP 14 keyword inside a ${fence} block`);
    return;
  }
  const h = line.match(/^#{2,4}\s+(.*)$/);
  if (h) { section = h[1].replace(/`/g, ""); return; }
  const defs = [...line.matchAll(DEF)].map((m) => m[1]);
  if (KEYWORD.test(line) && !defs.length && !line.includes("BCP 14")) problems.push(`${at}: BCP 14 keyword without a requirement ID`);
  for (const [n, id] of defs.entries()) {
    const start = line.indexOf(`**[${id}]**`);
    const next = defs[n + 1] ? line.indexOf(`**[${defs[n + 1]}]**`) : line.length;
    const text = plain(line.slice(start, next));
    const step = /^\s*\d+\.\s/.test(line);
    if (!step && !KEYWORD.test(line.slice(start, next)) && !/\bneeds\b/.test(text)) problems.push(`${at}: ${id} has no BCP 14 keyword`);
    const role = text.match(ROLE)?.[1];
    const fixed = PREFIX_ACTOR[id.split("-")[0]];
    const actor = fixed || (role ? normalizeRole(role) : "unspecified");
    const num = section.match(/^([0-9A-Z]+(?:\.\d+)*)/)?.[1] ?? section;
    reqs.push({ id, section: num, actor, text: text.length > 240 ? text.slice(0, 237) + "…" : text });
  }
});

const seen = new Map<string, number>();
for (const r of reqs) seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
for (const [id, n] of seen) if (n > 1) problems.push(`${id} is defined ${n} times`);
for (const m of md.matchAll(REF)) if (!seen.has(m[1])) problems.push(`reference to undefined ${m[1]}`);

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`${problems.length} problem(s) in spec.md requirements`);
  process.exit(1);
}

const out = JSON.stringify({
  spec: "SMART Health Check-in 1.0",
  generatedFrom: "spec.md",
  requirements: reqs.map(({ id, section, actor, text }) => ({ id, section, actor, summary: text })),
}, null, 2) + "\n";
const file = `${root}requirements.json`;
if (check) {
  const current = await Bun.file(file).exists() ? await Bun.file(file).text() : "";
  if (current !== out) { console.error("requirements.json is out of date: run bun scripts/spec-requirements.ts"); process.exit(1); }
  console.log(`${reqs.length} requirements; requirements.json is current`);
} else {
  await Bun.write(file, out);
  console.log(`Wrote ${reqs.length} requirements to requirements.json`);
}
