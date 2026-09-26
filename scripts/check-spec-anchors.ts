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
if (missing.length || dupes.length) {
  if (missing.length) console.error(`missing anchors: ${missing.join(", ")}`);
  if (dupes.length) console.error(`duplicate ids: ${dupes.join(", ")}`);
  process.exit(1);
}
console.log(`All ${wanted.length} legacy anchors resolve; no duplicate ids`);
