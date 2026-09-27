#!/usr/bin/env bun
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer } from "marked";
import { highlight } from "./highlight.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const inputArg = process.argv[2] ?? resolve(ROOT, "spec.md");
const outputArg = process.argv[3] ?? resolve(ROOT, "_site", "spec.html");
const titleArg = process.argv[4];
const descriptionArg = process.argv[5];
const rawHrefArg = process.argv[6];
const heroTitleArg = process.argv[7];

const inputPath = resolve(inputArg);
const outputPath = resolve(outputArg);

const md = await readFile(inputPath, "utf8");

interface Heading {
  depth: number;
  text: string;
  id: string;
}
const headings: Heading[] = [];
const slugSeen = new Map<string, number>();
// Numbered headings ("8.2" → its id), so section references like §8.2 link to them.
const sectionIds = new Map<string, string>();

function slugify(raw: string): string {
  const base =
    raw
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/&[a-z]+;/gi, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "section";
  const n = slugSeen.get(base) ?? 0;
  slugSeen.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const renderer = new Renderer();

// "Check-in" must not break at its hyphen in a heading.
const keepCheckIn = (html: string) => html.replace(/\bCheck-in\b/g, '<span class="nowrap">Check-in</span>');
// The document's one H1 (its title) goes in the page head, not the body.
let docH1: { id: string; html: string } | undefined;

renderer.heading = function ({ tokens, depth }) {
  const text = keepCheckIn(this.parser.parseInline(tokens));
  const raw = tokens
    .map((t: any) => ("text" in t ? t.text : "raw" in t ? t.raw : ""))
    .join(" ");
  const id = slugify(raw || text);
  const num = /^(\d+(?:\.\d+)*)\.?\s/.exec(raw.trim());
  if (num) sectionIds.set(num[1], id);
  if (depth === 2 || depth === 3) {
    headings.push({ depth, text, id });
  }
  if (depth === 1) {
    if (docH1) throw new Error("spec.md has more than one H1");
    docH1 = { id, html: text };
    return "";
  }
  return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${text}</h${depth}>\n`;
};

renderer.code = function ({ text, lang }) {
  const language = (lang ?? "").trim().split(/\s+/)[0];
  if (language === "mermaid") {
    return `<div class="mermaid">${escapeHtml(text)}</div>\n`;
  }
  return highlight(text, language || "text") + "\n";
};
// Tables scroll sideways in the shared wrapper instead of widening the page.
const baseTable = renderer.table.bind(renderer);
renderer.table = function (token) {
  return `<div class="smart-table-wrap">${baseTable(token)}</div>\n`;
};

const marked = new Marked({ gfm: true, breaks: false });
const REQ_ID = "[A-Z]+(?:[0-9]+[A-Z]+)?-\\d+";
// Requirement IDs: each definition (**[XV-2]**) becomes a link target, and
// each plain reference ([XV-2]) links to it.
const body = (await marked.parse(md, { renderer }))
  .replace(new RegExp(`<strong>\\[(${REQ_ID})\\]</strong>`, "g"), '<strong class="req-id" id="$1"><a href="#$1">[$1]</a></strong>')
  .replace(new RegExp(`(?<!["#>])\\[(${REQ_ID})\\](?!</a>)`, "g"), '<a class="req-ref" href="#$1">[$1]</a>');
// Section references (§8.2, §§5–6, §§6, 8.4, 8.5) link each number to its
// heading, outside code blocks and diagrams.
const linkedBody = body
  .split(/(<pre[\s\S]*?<\/pre>|<div class="mermaid">[\s\S]*?<\/div>)/)
  .map((part) =>
    part.startsWith("<pre") || part.startsWith('<div class="mermaid">')
      ? part
      : part.replace(/(§§?)(\d+(?:\.\d+)*(?:(?:–|, )\d+(?:\.\d+)*)*)/g, (_m, sign: string, list: string) =>
          sign +
          list.replace(/\d+(?:\.\d+)*/g, (n) => {
            const id = sectionIds.get(n);
            if (!id) throw new Error(`spec.md refers to §${n}, which has no heading`);
            return `<a class="sec-ref" href="#${id}">${n}</a>`;
          }),
        ),
  )
  .join("");

const docTitle = titleArg ?? "SMART Health Check-in 1.0 — Draft Spec";
const docDescription =
  descriptionArg ??
  "SMART Health Check-in 1.0 draft: TypeScript/JSDoc clinical model, trust rules and layer separation, same-device org-iso-mdoc flow, and Appendix A diagnostic bridge.";
const rawHref = rawHrefArg ?? "./spec.md";
if (!docH1) throw new Error("spec.md has no H1");
const heroEyebrow = heroTitleArg ?? "Specification · Editor's draft";

const tocItems = headings
  .map(
    (h) =>
      `<li class="toc-l${h.depth}"><a href="#${h.id}">${h.text}</a></li>`,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en" data-theme="auto">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(docTitle)}</title>
<meta name="description" content="${escapeHtml(docDescription)}" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="/assets/smart-design.css">
<script src="/assets/site-chrome.js" defer></script>
<style>
  :root { --measure: 980px; }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    font-family: var(--font-sans);
    font-size: 16.5px;
    line-height: 1.62;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  a {
    color: var(--brand);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: color var(--dur) var(--ease-out), border-color var(--dur) var(--ease-out);
  }
  a:hover { color: var(--brand-ink); border-bottom-color: currentColor; }

  /* Page layout. Wide screens: the contents in a sticky left column, the
     title and the text to its right. Narrower: title, then the contents
     collapsed into a "Contents" disclosure, then the text. */
  .layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "hero" "toc" "body";
    max-width: var(--measure);
    margin: 0 auto;
    padding: 28px 24px 80px;
  }
  .hero { grid-area: hero; }
  .toc { grid-area: toc; }
  .spec-body { grid-area: body; min-width: 0; }
  @media (max-width: 700px) {
    .layout { padding: 20px 16px 64px; }
  }
  @media (min-width: 1100px) {
    .layout {
      max-width: 1280px;
      grid-template-columns: 260px minmax(0, 1fr);
      grid-template-areas: "toc hero" "toc body";
      column-gap: 36px;
    }
  }

  .toc {
    font-size: 13.5px;
    color: var(--fg-2);
    line-height: 1.5;
    margin: 0 0 var(--space-6);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  .toc > summary {
    cursor: pointer;
    padding: 10px 14px;
    min-height: 44px;
    display: flex;
    align-items: center;
    font-size: var(--fs-sm);
    font-weight: 700;
    color: var(--fg-1);
  }
  .toc > summary::-webkit-details-marker { display: none; }
  .toc > summary::after {
    content: "";
    width: 7px;
    height: 7px;
    margin: -3px 2px 0 auto;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
    transform: rotate(45deg);
  }
  .toc[open] > summary::after { margin-top: 3px; transform: rotate(-135deg); }
  .toc[open] > summary { border-bottom: 1px solid var(--border); }
  .toc > ul { padding: 8px 14px 4px 4px; }
  @media (min-width: 1100px) {
    .toc {
      position: sticky;
      top: 72px;
      align-self: start;
      max-height: calc(100vh - 88px);
      overflow-y: auto;
      margin: 0;
      padding: 0 16px 0 0;
      border: 0;
      border-right: 1px solid var(--border);
      border-radius: 0;
    }
    /* Always open here; the label is a heading, not a control. */
    .toc > summary {
      list-style: none;
      pointer-events: none;
      min-height: 0;
      padding: 0;
      margin: 0 0 var(--space-3);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: var(--tracking-caps);
      color: var(--fg-mark);
    }
    .toc > summary::after { display: none; }
    .toc[open] > summary { border-bottom: 0; }
    .toc > ul { padding: 0; }
  }
  .toc ul { list-style: none; padding: 0; margin: 0 0 var(--space-4); }
  .toc li { margin: 2px 0; }
  .toc a {
    color: var(--fg-2);
    text-decoration: none;
    display: block;
    padding: 2px 0;
    border-left: 2px solid transparent;
    padding-left: 10px;
    border-bottom: 0;
    font-weight: 500;
  }
  .toc a:hover { color: var(--brand-ink); border-left-color: var(--brand); border-bottom-color: transparent; }
  .toc-l3 { padding-left: 14px; font-size: 12.5px; color: var(--fg-3); }
  .toc-l3 a { color: var(--fg-3); }

  .hero {
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--space-4);
    margin-bottom: var(--space-5);
  }
  .hero .eyebrow {
    font-size: var(--fs-xs);
    text-transform: uppercase;
    letter-spacing: var(--tracking-caps);
    color: var(--brand);
    font-weight: 700;
    margin: 0 0 var(--space-2);
  }
  .hero h1 {
    font-size: clamp(2rem, 3.8vw, 3rem);
    line-height: var(--lh-tight);
    letter-spacing: var(--tracking-tight);
    margin: 0;
    color: var(--fg-1);
    font-weight: 800;
    text-wrap: balance;
  }
  .nowrap { white-space: nowrap; }
  /* Prose keeps a readable measure; code, tables, and diagrams use the full width. */
  .spec-body > :is(p, ul, ol, blockquote),
  .spec-body > :is(ul, ol) p { max-width: 38em; }

  h1, h2, h3, h4, h5, h6 { line-height: 1.22; color: var(--fg-1); }
  h1 { margin: 0 0 var(--space-3); font-weight: 800; letter-spacing: var(--tracking-tight); }
  h2 {
    font-size: 1.5rem;
    margin: var(--space-7) 0 var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
    font-weight: 700;
    letter-spacing: var(--tracking-snug);
  }
  h3 { font-size: var(--fs-lg); margin: var(--space-6) 0 var(--space-2); font-weight: 600; }
  h4 { font-size: var(--fs-md); margin: var(--space-5) 0 var(--space-2); font-weight: 600; }
  h5, h6 { font-size: var(--fs-base); margin: var(--space-4) 0 var(--space-2); font-weight: 600; }

  h2, h3, h4 { position: relative; }
  /* A "#" link in the left margin on hover. */
  h2 .anchor, h3 .anchor, h4 .anchor {
    position: absolute;
    right: 100%;
    padding-right: 6px;
    color: var(--fg-3);
    text-decoration: none;
    margin-right: 0;
    font-weight: 400;
    opacity: 0;
    transition: opacity 80ms ease;
    border-bottom: 0;
  }
  h2:hover .anchor, h3:hover .anchor, h4:hover .anchor { opacity: 1; }

  p { margin: 0 0 var(--space-3); }
  ul, ol { padding-left: 22px; margin: 0 0 var(--space-3); }
  li { margin: 4px 0; }
  li > p { margin: 0 0 6px; }

  /* A rule right before a section heading would double its top border. */
  .spec-body > hr + h2 { border-top: 0; }
  hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: var(--space-7) 0;
  }

  code, kbd, samp { font-family: var(--font-mono); }

  .mermaid {
    background: var(--bg-alt);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 16px;
    margin: 0 0 var(--space-4);
    text-align: center;
  }

  /* Jump targets land below the sticky bar. */
  :target { scroll-margin-top: 80px; }
</style>
</head>
<body>
<div data-smart-topbar></div>

<main id="main" class="layout">
  <div class="hero">
    <p class="eyebrow">${escapeHtml(heroEyebrow)}</p>
    <h1 id="${docH1.id}">${docH1.html}</h1>
  </div>

  <details class="toc" id="toc">
    <summary>Contents</summary>
    <ul>
${tocItems}
    </ul>
  </details>
  <script>
    // Wide screens show the contents as an open sidebar; narrower ones start collapsed.
    (() => {
      const toc = document.getElementById("toc");
      const wide = matchMedia("(min-width: 1100px)");
      const sync = () => { toc.open = wide.matches; };
      sync();
      wide.addEventListener("change", sync);
      toc.addEventListener("click", (e) => { if (!wide.matches && e.target.closest("a")) toc.open = false; });
    })();
  </script>

  <article class="spec-body smart-prose">
${linkedBody}
  </article>
</main>

<div data-smart-footer></div>

<script type="module">
  // Mermaid diagrams (only initialized if any .mermaid blocks are present).
  if (document.querySelector(".mermaid")) {
    const { default: mermaid } = await import("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs");
    // Follow the page's mode: dark when forced, or when "auto" and the reader prefers dark.
    const theme = document.documentElement.dataset.theme;
    const isDark = theme === "dark" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    mermaid.initialize({ startOnLoad: false, theme: isDark ? "dark" : "neutral", securityLevel: "strict" });
    try {
      await mermaid.run({ querySelector: ".mermaid" });
    } catch (e) {
      console.warn("mermaid.run failed", e);
    }
  }
</script>
</body>
</html>
`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, html);
console.log(
  `Rendered ${headings.length} headings, ${md.length.toLocaleString()} chars markdown -> ${outputPath} (${html.length.toLocaleString()} bytes).`,
);
