// Every anchor in scripts/spec-anchors.txt must exist exactly once in the
// rendered spec, so links from other sites keep working after edits.
const root = new URL("..", import.meta.url).pathname;
const html = await Bun.file(process.argv[2] ?? `${root}_site/spec.html`).text();
const ids = new Map<string, number>();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
const wanted = (await Bun.file(`${root}scripts/spec-anchors.txt`).text())
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const missing = wanted.filter((id) => !ids.has(id));
const dupes = [...ids].filter(([, n]) => n > 1).map(([id]) => id);
// Every citation (#ref-KEY) names a reference entry, and every entry is cited
// in the text at least once. The entry's own [KEY] label doesn't count.
const entries = [...html.matchAll(/<li class="ref-entry" id="ref-([^"]+)"/g)].map((m) => m[1]!);
const cited = new Map<string, number>();
for (const m of html.matchAll(/<a (?:class="([^"]*)" )?href="#ref-([^"]+)"/g)) {
  if (m[1] === "ref-key") continue;
  cited.set(m[2]!, (cited.get(m[2]!) ?? 0) + 1);
}
const dangling = [...cited.keys()].filter((k) => !entries.includes(k));
const uncited = entries.filter((k) => !cited.has(k));
if (missing.length || dupes.length || dangling.length || uncited.length || !entries.length) {
  if (missing.length) console.error(`missing anchors: ${missing.join(", ")}`);
  if (dupes.length) console.error(`duplicate ids: ${dupes.join(", ")}`);
  if (!entries.length) console.error("no reference entries found");
  if (dangling.length) console.error(`citations with no reference entry: ${dangling.map((k) => `#ref-${k}`).join(", ")}`);
  if (uncited.length) console.error(`reference entries never cited: ${uncited.join(", ")}`);
  process.exit(1);
}
const total = [...cited.values()].reduce((a, b) => a + b, 0);
console.log(`All ${wanted.length} section anchors resolve; no duplicate ids; ${total} citations resolve and all ${entries.length} references are cited`);
