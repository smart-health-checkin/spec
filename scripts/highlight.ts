#!/usr/bin/env bun
// Build-time syntax highlighting, set up as in the site's MAINTAINING.md
// ("Syntax highlighting"): Shiki's css-variables theme, whose colors come from
// the shared stylesheet's --syn-* tokens, so code follows light and dark mode.
//
// As a module: `highlight(code, lang)` returns a <pre class="shiki css-variables">.
// As a script: `bun scripts/highlight.ts page.html …` highlights, in place, each
// static <pre> in those pages whose text is a JSON object or array (examples may
// elide parts with "…"); other pres are left as they are.
import { createCssVariablesTheme, createHighlighter } from "shiki";

// Shiki has no CDDL grammar; this is the one MAINTAINING.md documents.
const cddl = {
  name: "cddl", scopeName: "source.cddl",
  patterns: [
    { match: ";.*$", name: "comment.line.semicolon.cddl" },
    { match: "\"(?:[^\"\\\\]|\\\\.)*\"", name: "string.quoted.double.cddl" },
    { match: "'(?:[^'\\\\]|\\\\.)*'", name: "string.quoted.single.cddl" },
    { match: "\\.[a-z][a-z0-9-]*\\b", name: "keyword.operator.control.cddl" },
    { match: "\\b(?:bool|true|false|nil|null|undefined|any|u?int|nint|float(?:16|32|64)?|tstr|text|bstr|bytes|uri|tdate|time|number)\\b", name: "support.type.cddl" },
    { match: "-?\\b\\d+(?:\\.\\d+)?\\b", name: "constant.numeric.cddl" },
    { match: "^[A-Za-z@_$][\\w@.$-]*(?=\\s*/{0,2}=)", name: "entity.name.type.cddl" },
    { match: "//|=>|/=|//=|\\?|\\*|\\+|\\^|=|~|&|\\.\\.\\.?", name: "keyword.operator.cddl" },
    { match: "[,:]", name: "punctuation.separator.cddl" },
  ],
};

const LANGS = ["ts", "tsx", "js", "json", "html", "xml", "sh", "kotlin"];
const ALIASES: Record<string, string> = { typescript: "ts", javascript: "js", bash: "sh", shell: "sh", jsonc: "json" };

const highlighter = await createHighlighter({
  themes: [createCssVariablesTheme()],
  langs: [...LANGS, cddl as any],
});

export function highlight(code: string, lang = "text"): string {
  const l = ALIASES[lang] ?? lang;
  const known = l === "cddl" || LANGS.includes(l);
  return highlighter.codeToHtml(code, { lang: known ? l : "text", theme: "css-variables" });
}

const unescape = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// Highlights each tag-free <pre> whose text is a JSON object or array, keeping the pre's
// own attributes (id, data-check, classes) and adding Shiki's classes.
export function highlightJsonPres(html: string): { html: string; count: number } {
  let count = 0;
  const out = html.replace(/<pre(\s[^>]*)?>([^<]*)<\/pre>/g, (whole, attrs = "", body: string) => {
    const text = unescape(body);
    if (!/^\s*[{[][\s\S]*[}\]]\s*$/.test(text)) return whole;
    const shiki = highlight(text, "json");
    const inner = shiki.slice(shiki.indexOf(">") + 1);   // "<code>…</code></pre>"
    const cls = /\bclass="([^"]*)"/.exec(attrs);
    const rest = attrs.replace(/\s*\bclass="[^"]*"/, "");
    count++;
    return `<pre class="${cls ? cls[1] + " " : ""}shiki css-variables" tabindex="0"${rest}>${inner}`;
  });
  return { html: out, count };
}

if (import.meta.main) {
  for (const file of process.argv.slice(2)) {
    const { html, count } = highlightJsonPres(await Bun.file(file).text());
    await Bun.write(file, html);
    if (count) console.log(`Highlighted ${count} JSON block(s) in ${file.split("/").pop()}`);
  }
}
