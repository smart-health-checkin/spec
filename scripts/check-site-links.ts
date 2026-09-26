// Every relative link in the site's pages resolves: `spec.html#ID` to an id in
// the rendered spec, `page.html#id` to that page and id. Keeps the explainers
// from pointing at requirements or sections that moved.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const site = process.argv[2] ?? "_site";
const ids = new Map<string, Set<string>>();
const idsOf = (page: string) => {
  if (!ids.has(page)) {
    const file = join(site, page);
    const html = existsSync(file) ? readFileSync(file, "utf8") : "";
    ids.set(page, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)));
  }
  return ids.get(page)!;
};

let bad = 0;
const pages = readdirSync(site).filter((f) => f.endsWith(".html") && f !== "spec.html" && f !== "index.html");
for (const page of pages) {
  const html = readFileSync(join(site, page), "utf8");
  // Skip script bodies: they build links at runtime.
  const markup = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  for (const m of markup.matchAll(/href="([^"]+)"/g)) {
    const href = m[1]!;
    if (/^(https?:|mailto:|\/)/.test(href)) continue;
    const [path, frag] = href.replace(/^\.\//, "").split("#");
    const target = path === "" ? page : path!;
    if (!target.endsWith(".html")) continue;
    if (!existsSync(join(site, target))) { console.error(`${page}: ${href} — no such page`); bad++; continue; }
    if (frag && !idsOf(target).has(frag)) { console.error(`${page}: ${href} — no id "${frag}" in ${target}`); bad++; }
  }
}
if (bad) { console.error(`${bad} broken site link(s)`); process.exit(1); }
console.log(`Site links resolve in ${pages.length} pages`);
