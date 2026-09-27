#!/usr/bin/env bun
/**
 * Writes this section's llms.txt and llms-full.txt from the built site.
 *
 *   bun scripts/llms.ts _site
 *
 * llms.txt follows llmstxt.org: an H1, a one-paragraph summary, a pointer to
 * the shared background, then every page grouped as in nav.json, with a link
 * to llms-full.txt and to the other sections' files. llms-full.txt is the
 * shared background followed by the full text of every page, converted from
 * the built HTML to Markdown, each under a "Source:" line.
 *
 * The shared background is written once, in the apex repo
 * (smart-health-checkin.github.io, llms-background.md), and published at
 * https://smart-health-checkin.org/llms-background.md. This script fetches it
 * and fails if it can't. LLMS_BACKGROUND=<file or URL> reads another copy, for
 * example ../smart-health-checkin.github.io/llms-background.md offline.
 *
 * The build fails if a page in the site is neither listed nor skipped below,
 * or if a link in llms.txt into this section names a file the build didn't
 * produce.
 */
// @ts-ignore: @mixmark-io/domino ships no types.
import domino from "@mixmark-io/domino";
import TurndownService from "turndown";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// ---------------------------------------------------------------- this section
const ORIGIN = "https://smart-health-checkin.org";
const BASE: string = "/spec/";
const TITLE = "SMART Health Check-in: Spec";
const SUMMARY =
  "The draft SMART Health Check-in 1.0 specification and its explainers. The spec defines a JSON request (the items a clinic's Verifier asks for), a JSON response (the records and form answers the patient chose to share, with a status for every item), and how both travel through the W3C Digital Credentials API as an ISO mdoc presentation. The explainers walk the model, the wire format, kiosk check-in, security, and platform behavior with worked examples.";
// Pages published but not in llms-full.txt, with the reason. A key ending in
// "/" skips everything under that folder.
const SKIP: Record<string, string> = {
  "spec.html": "the same page as the section's front page",
  "fixtures/": "test data, not pages",
};
// Links in llms.txt beyond the menu. With full: true, llms-full.txt also
// includes the file as it is.
const EXTRA: { group: string; title: string; href: string; note: string; full?: boolean }[] = [
  { group: "Specification", title: "spec.md", href: "spec.md", note: "The specification's Markdown source" },
  { group: "Specification", title: "requirements.json", href: "requirements.json", note: "Every requirement ID with its section, actor, and summary" },
];
// Elements inside <main> that are page furniture, not content.
const DROP = ["nav", ".toc"];
// The menu, which orders and groups llms.txt: this section's nav.json.
const NAV: string | object | object[] = "nav.json";
// One-line descriptions that replace the menu's notes, by page URL.
const NOTES: Record<string, string> = {};
// Where the shared background comes from: the apex's published copy.
const BACKGROUND_FROM = "https://smart-health-checkin.org/llms-background.md";
// Section-specific changes to a page's <main> before conversion.
const PREPARE = (_main: any, _doc: any): void => {};

// ---------------------------------------------------------------- shared
// Everything below is the same in every repo's scripts/llms.ts (apex, spec,
// client, connectathon). Change it in all four together.
const SECTIONS = [
  { title: "Home", base: "/", note: "The shared background and the home page" },
  { title: "Spec", base: "/spec/", note: "The draft specification and its explainers" },
  { title: "Developers and Demos", base: "/client/", note: "The JavaScript library: guides, API reference, demos" },
  { title: "Connectathon", base: "/connectathon/", note: "The testing event: pages for each participant, scenarios, test tools, prompts" },
];
const BACKGROUND_URL = `${ORIGIN}/llms-background.md`;

const OUT = process.argv[2] ?? "_site";
const SITE = `${ORIGIN}${BASE}`;
const die = (msg: string): never => {
  console.error(`llms: ${msg}`);
  process.exit(1);
};

async function loadBackground(): Promise<string> {
  const src = process.env.LLMS_BACKGROUND ?? BACKGROUND_FROM;
  let text = "";
  let problem = "";
  for (let attempt = 1; attempt <= 3 && !text; attempt++) {
    try {
      if (/^https?:/.test(src)) {
        const res = await fetch(src, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        text = await res.text();
      } else {
        text = readFileSync(src, "utf8");
      }
    } catch (e) {
      problem = (e as Error).message;
      if (attempt < 3) await Bun.sleep(2000 * attempt);
    }
  }
  if (!text) die(`couldn't read the shared background from ${src} (${problem}). The apex repo publishes it; set LLMS_BACKGROUND to a local copy to build offline.`);
  if (!text.startsWith("# SMART Health Check-in")) die(`${src} doesn't look like the shared background (it should start with "# SMART Health Check-in").`);
  return text.trim();
}

// ---------------------------------------------------------------- HTML to Markdown
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "*" });
const cellText = (cell: any): string =>
  turndown.turndown(cell.innerHTML).replace(/\s*\n+\s*/g, " ").replace(/\|/g, "\\|").trim();
turndown.addRule("table", {
  filter: "table",
  replacement: (_content, node: any) => {
    const rows = Array.from(node.querySelectorAll("tr")) as any[];
    if (!rows.length) return "";
    const cells = rows.map((r) => (Array.from(r.children) as any[]).filter((c) => /^T[HD]$/.test(c.nodeName)).map(cellText));
    const width = Math.max(...cells.map((r) => r.length));
    const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
    return `\n\n${line(cells[0]!)}\n| ${Array(width).fill("---").join(" | ")} |\n${cells.slice(1).map(line).join("\n")}\n\n`;
  },
});
turndown.addRule("pre", {
  filter: "pre",
  replacement: (_content, node: any) => {
    const text = String(node.textContent).replace(/\n+$/, "");
    if (!text.trim()) return "";
    const cls = `${node.getAttribute("class") ?? ""} ${node.querySelector("code")?.getAttribute("class") ?? ""}`;
    const lang = node.getAttribute("data-lang") ?? cls.match(/language-([\w-]+)/)?.[1] ?? (/\bmermaid\b/.test(cls) ? "mermaid" : "");
    const fence = "`".repeat(Math.max(3, ...(text.match(/`{3,}/g) ?? []).map((f) => f.length + 1)));
    return `\n\n${fence}${lang}\n${text}\n${fence}\n\n`;
  },
});
// Text reads as written: no backslashes before brackets, dots, or underscores.
turndown.escape = (text: string) => text;
turndown.addRule("listItem", {
  filter: "li",
  replacement: (content, node: any) => {
    const parent = node.parentNode;
    const start = Number(parent.getAttribute?.("start") ?? 1);
    const prefix = parent.nodeName === "OL" ? `${start + Array.prototype.indexOf.call(parent.children, node)}. ` : "- ";
    const body = content.replace(/^\n+/, "").replace(/\n+$/, "\n").replace(/\n/gm, `\n${" ".repeat(prefix.length)}`);
    return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "");
  },
});
turndown.addRule("dt", { filter: "dt", replacement: (content) => `\n\n**${content.trim()}**\n` });
turndown.addRule("dd", { filter: "dd", replacement: (content) => `: ${content.trim().replace(/\n+/g, " ")}\n` });
turndown.addRule("figure-caption", { filter: "figcaption", replacement: (content) => `\n\n${content.trim()}\n\n` });

const all = (root: any, sel: string): any[] => Array.from(root.querySelectorAll(sel));

/** The Markdown of a built page's <main>, with links made absolute. */
function pageToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const doc = domino.createDocument(html);
  const main = doc.querySelector("main#main") ?? doc.querySelector("main") ?? doc.body;
  const remove = (sel: string) => all(main, sel).forEach((el: any) => el.remove());
  for (const sel of ["script", "style", "noscript", "template", "link", "button", "input", "select", "textarea", "[aria-hidden='true']", ".xd-narrow", "[data-smart-topbar]", "[data-smart-breadcrumb]", "[data-smart-footer]", ...DROP]) remove(sel);
  PREPARE(main, doc);
  // A Mermaid diagram keeps its source, as code.
  all(main, ".mermaid:not(pre)").forEach((el: any) => {
    const pre = doc.createElement("pre");
    pre.setAttribute("data-lang", "mermaid");
    pre.textContent = el.textContent.trim();
    el.replaceWith(pre);
  });
  // A drawing becomes its accessible name and description.
  all(main, "svg").forEach((svg: any) => {
    const words = [svg.querySelector("title")?.textContent, svg.querySelector("desc")?.textContent, svg.getAttribute("aria-label")]
      .map((s) => (s ?? "").replace(/\s+/g, " ").trim()).filter(Boolean)
      .map((s) => (/[.!?:]$/.test(s) ? s : `${s}.`));
    const p = doc.createElement("p");
    p.textContent = words.length ? `Diagram: ${[...new Set(words)].join(" ")}` : "";
    svg.replaceWith(p);
  });
  all(main, "a[href]").forEach((a: any) => {
    const href = a.getAttribute("href");
    if (/^(javascript|data):/i.test(href)) return a.removeAttribute("href");
    try { a.setAttribute("href", new URL(href, url).href); } catch {}
  });
  // A card that is one big link: the link moves onto its heading (or a line
  // of its own), and the card's text stays plain.
  all(main, "a[href]").forEach((a: any) => {
    if (!a.querySelector("h1, h2, h3, h4, h5, h6, p, div, ul, ol")) return;
    const link = doc.createElement("a");
    link.setAttribute("href", a.getAttribute("href"));
    const heading = a.querySelector("h1, h2, h3, h4, h5, h6");
    if (heading) {
      link.textContent = heading.textContent.trim();
      heading.textContent = "";
      heading.appendChild(link);
    } else {
      link.textContent = a.getAttribute("href");
      const p = doc.createElement("p");
      p.appendChild(link);
      a.appendChild(p);
    }
    while (a.firstChild) a.parentNode.insertBefore(a.firstChild, a);
    a.remove();
  });
  all(main, "img[src]").forEach((img: any) => {
    try { img.setAttribute("src", new URL(img.getAttribute("src"), url).href); } catch {}
  });
  const h1 = main.querySelector("h1");
  const title = (h1?.textContent ?? doc.title ?? url).replace(/\s+/g, " ").trim();
  h1?.remove();
  const markdown = turndown.turndown(main.innerHTML).replace(/\n{3,}/g, "\n\n").trim();
  return { title, markdown };
}

// ---------------------------------------------------------------- the pages
type NavItem = { title: string; href?: string; note?: string; items?: NavItem[] };
type NavSource = { file: string; prefix?: string } | { nav: NavItem; prefix?: string };

/** The built file a URL in this section is served from, or undefined outside it. */
function fileFor(url: string): string | undefined {
  const u = new URL(url);
  if (u.origin !== ORIGIN || !u.pathname.startsWith(BASE)) return undefined;
  if (SECTIONS.some((s) => s.base !== BASE && s.base.startsWith(BASE) && u.pathname.startsWith(s.base))) return undefined;
  const rel = decodeURIComponent(u.pathname.slice(BASE.length));
  return !rel || rel.endsWith("/") ? join(OUT, rel, "index.html") : join(OUT, rel);
}
const pageKey = (url: string): string => {
  const u = new URL(url);
  return `${u.origin}${u.pathname.replace(/index\.html$/, "")}`;
};
/** A menu href as a URL. Hrefs are relative to their nav.json; a root-relative
 * one without this section's base comes from a standalone build (the client's
 * SITE_BASE unset) and is relative to the section. */
const navUrl = (href: string, navFileUrl: string): string =>
  href.startsWith("/") && !href.startsWith(BASE) ? new URL(href.slice(1), SITE).href : new URL(href, navFileUrl).href;

// Menu order, one group per menu group. As in the chrome, a menu that doesn't
// list its front page gets "Overview" first.
const groups: { title: string; entries: { title: string; url: string; note: string }[] }[] = [];
const add = (group: string, entry: { title: string; url: string; note: string }) => {
  let g = groups.find((x) => x.title === group);
  if (!g) groups.push((g = { title: group, entries: [] }));
  g.entries.push({ ...entry, note: NOTES[pageKey(entry.url)] ?? entry.note });
};
const navSources = (typeof NAV === "string" ? [{ file: NAV }] : Array.isArray(NAV) ? NAV : [{ nav: NAV }]) as NavSource[];
for (const source of navSources) {
  const nav: NavItem = "file" in source ? JSON.parse(readFileSync(join(OUT, source.file), "utf8")) : source.nav;
  const navFileUrl = "file" in source ? new URL(source.file, SITE).href : SITE;
  const prefix = source.prefix ?? "";
  const hrefs = (items: NavItem[]): string[] => items.flatMap((i) => (i.items ? hrefs(i.items) : i.href ? [navUrl(i.href, navFileUrl)] : []));
  const front = navUrl(nav.href ?? "./", navFileUrl);
  if (!hrefs(nav.items ?? []).some((u) => pageKey(u) === pageKey(front))) add(`${prefix}Overview`, { title: "Overview", url: front, note: "" });
  const walk = (items: NavItem[], group: string) => {
    for (const item of items) {
      if (item.items) walk(item.items, `${prefix}${item.title}`);
      else if (item.href) add(group, { title: item.title, url: navUrl(item.href, navFileUrl), note: item.note ?? "" });
    }
  };
  walk(nav.items ?? [], `${prefix}Overview`);
}
for (const e of EXTRA) add(e.group, { title: e.title, url: new URL(e.href, SITE).href, note: e.note });
// Published Markdown or text files that llms-full.txt includes as they are.
const texts = EXTRA.filter((e) => e.full).map((e) => new URL(e.href, SITE).href);
for (const url of texts) if (!existsSync(fileFor(url) ?? "")) die(`EXTRA names ${url} for llms-full.txt, but the build has no such file`);

const htmlFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? htmlFiles(p) : p.endsWith(".html") ? [p] : [];
  });
const pageUrls: string[] = [];
const seen = new Set<string>();
const addPage = (url: string) => {
  const file = fileFor(url);
  if (!file || !file.endsWith(".html") || !existsSync(file) || seen.has(pageKey(url))) return;
  seen.add(pageKey(url));
  pageUrls.push(pageKey(url));
};
// llms-full.txt: the section's front page first, then the menu's order.
addPage(SITE);
for (const g of groups) for (const e of g.entries) addPage(e.url);
const unlisted: string[] = [];
for (const file of htmlFiles(OUT).sort()) {
  const rel = relative(OUT, file);
  if (rel === "404.html" || Object.keys(SKIP).some((k) => (k.endsWith("/") ? rel.startsWith(k) : rel === k))) continue;
  const url = `${SITE}${rel}`;
  if (!seen.has(pageKey(url))) unlisted.push(rel);
}
if (unlisted.length) die(`these pages are in the site but not in the menu, EXTRA, or SKIP in scripts/llms.ts: ${unlisted.join(", ")}`);

// ---------------------------------------------------------------- write
const background = await loadBackground();
const sectionTitle = TITLE.replace(/^SMART Health Check-in: /, "");
const others = SECTIONS.filter((s) => s.base !== BASE);

const sectionList = [
  `## ${BASE === "/" ? "Sections" : "Other sections"}`,
  "",
  ...others.map((s) => `- [${s.title}](${ORIGIN}${s.base}llms.txt): ${s.note}. In one file: ${ORIGIN}${s.base}llms-full.txt`),
  "",
];
const index = [
  `# ${TITLE}`,
  "",
  `> ${SUMMARY}`,
  "",
  `What SMART Health Check-in is, its roles and transports, and a map of every section are in the shared background: ${BACKGROUND_URL}`,
  "",
  // The site's root lists the sections first; a section lists its own pages first.
  ...(BASE === "/" ? sectionList : []),
  ...groups.flatMap((g) => [`## ${g.title}`, "", ...g.entries.map((e) => `- [${e.title}](${e.url})${e.note ? `: ${e.note}` : ""}`), ""]),
  "## This section in one file",
  "",
  `- [llms-full.txt](${SITE}llms-full.txt): the shared background and the full text of every page in this section, as Markdown`,
  "",
  ...(BASE === "/" ? [] : sectionList),
].join("\n");

const pages = pageUrls.map((url) => {
  const { title, markdown } = pageToMarkdown(readFileSync(fileFor(url)!, "utf8"), url);
  return `# ${title}\n\nSource: ${url}\n\n${markdown}`;
});
for (const url of texts) {
  const text = readFileSync(fileFor(url)!, "utf8").trim();
  const title = text.match(/^# (.+)/)?.[1] ?? EXTRA.find((e) => new URL(e.href, SITE).href === url)!.title;
  pages.push(`# ${title}\n\nSource: ${url}\n\n${text.replace(/^# .+\n*/, "")}`);
}
const full = [
  `# ${TITLE}: llms-full.txt`,
  "",
  `> ${SUMMARY}`,
  "",
  `This file is the shared background (${BACKGROUND_URL}) followed by the full text of the ${pages.length} pages of this section (${sectionTitle}), converted to Markdown. Its index is ${SITE}llms.txt.`,
  "",
  "---",
  "",
  background,
  ...pages.flatMap((p) => ["", "---", "", p]),
  "",
].join("\n");

writeFileSync(join(OUT, "llms.txt"), index);
writeFileSync(join(OUT, "llms-full.txt"), full);

// Every link in llms.txt into this section names a file this build produced.
const broken = [...index.matchAll(/\]\((https?:[^)\s]+)\)/g)]
  .map((m) => m[1]!)
  .filter((url) => {
    const file = fileFor(url.replace(/#.*$/, ""));
    return file !== undefined && !existsSync(file);
  });
if (broken.length) die(`llms.txt links to pages this build doesn't have: ${broken.join(", ")}`);

console.log(`llms.txt (${(index.length / 1024).toFixed(1)} KB) and llms-full.txt (${pages.length} pages, ${(Buffer.byteLength(full) / 1024).toFixed(1)} KB)`);
