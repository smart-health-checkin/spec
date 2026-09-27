/**
 * Re-captures fixtures/{dcapi-requests,responses}/android-chrome-capture: a
 * Verifier page built with the client library (the version in package.json),
 * in the device's Chrome, asks the installed reference wallet for
 * smart-request.json through the Digital Credentials API. Then it pulls the
 * wallet's record of the run and rebuilds both fixture folders (assemble.sh).
 *
 *   bun tools/capture/android-chrome/capture.ts [--serial emulator-5554]
 *
 * Needs adb, a device with Chrome and Play services new enough for the Digital
 * Credentials API (the android-37 google_apis_playstore image works), the
 * reference wallet installed and opened once, and uv (for the pyMDOC check).
 * Nothing but adb talks to the device: the page is served on the host at
 * http://127.0.0.1:3010 through adb reverse, and system and wallet screens are
 * tapped through uiautomator, answering the wallet's form with its first
 * choices. Afterwards run bun scripts/worked-example.ts (Appendix A) and
 * bun tools/conformance/generate.ts, keeping only the capture cases' changes.
 */
import { $ } from "bun";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const SERIAL = opt("--serial") ?? process.env.ANDROID_SERIAL ?? "emulator-5554";
const HERE = import.meta.dir;
const ROOT = join(HERE, "../../..");
const WORK = join(HERE, "work");
const PORT = 3010;
const WALLET = "org.smarthealthit.checkin.wallet";
const ADB = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/Sdk`}/platform-tools/adb`;
const adb = (...a: string[]) => $`${ADB} -s ${SERIAL} ${a}`.quiet().nothrow();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
const built = await Bun.build({ entrypoints: [join(HERE, "page.ts")], target: "browser", format: "iife" });
if (!built.success) throw new Error(built.logs.join("\n"));
const pageJs = await built.outputs[0]!.text();

let artifacts = "";
let credential = "";
let pageError = "";
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.method === "POST") {
      const body = await req.text();
      if (path === "/artifacts") artifacts = body;
      else if (path === "/credential") credential = body;
      else pageError = body;
      return new Response("ok");
    }
    if (path === "/page.js") return new Response(pageJs, { headers: { "content-type": "text/javascript" } });
    if (path === "/smart-request.json") return new Response(Bun.file(join(HERE, "smart-request.json")));
    if (path === "/") return new Response(Bun.file(join(HERE, "index.html")));
    return new Response("not found", { status: 404 });
  },
});

type Node = { text: string; id: string; desc: string; cls: string; checked: boolean; left: number; top: number; bottom: number; x: number; y: number };
async function screen(): Promise<Node[]> {
  await adb("shell", "uiautomator", "dump", "/sdcard/ui.xml");
  const xml = (await adb("shell", "cat", "/sdcard/ui.xml")).stdout.toString();
  return [...xml.matchAll(/<node ([^>]*)>/g)].map((m) => {
    const a = Object.fromEntries([...m[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const [l, t, r, b] = (a.bounds ?? "[0,0][0,0]").match(/\d+/g)!.map(Number);
    return { text: a.text ?? "", id: (a["resource-id"] ?? "").replace(/^.*:id\//, ""), desc: a["content-desc"] ?? "", cls: a.class ?? "", checked: a.checked === "true", left: l!, top: t!, bottom: b!, x: (l! + r!) >> 1, y: (t! + b!) >> 1 };
  });
}
// The wallet's controls carry test tags, which show as resource ids (wallet 0.4.5
// and later); older wallets are matched by their labels and layout.
const isShare = (n: Node) => n.id === "share-selected" || n.text === "Share selected data";
const SHARE = /^(share-selected|Share selected data)$/;
async function tapIfShown(re: RegExp): Promise<boolean> {
  const n = (await screen()).find((n) => re.test(n.text) || re.test(n.desc) || re.test(n.id));
  if (!n) return false;
  await adb("shell", "input", "tap", String(n.x), String(n.y));
  return true;
}
// Same as connectathon's scripts/android-e2e.ts: for each question whose radio
// buttons are all unchecked, tap the first one.
async function answerForms(): Promise<number> {
  const answered = new Set<string>();
  let last = "";
  for (let pass = 0; pass < 30; pass++) {
    const nodes = await screen();
    const signature = nodes.map((n) => n.text + n.checked).join("|");
    if (signature === last) break;
    last = signature;
    const viewBottom = Math.max(...nodes.filter(isShare).map((n) => n.top), 0) || 2000;
    const tagged = nodes.some((n) => n.id === "question");
    let question = "";
    let group: Node[] = [];
    const flush = async () => {
      if (question && group.length && !group.some((r) => r.checked) && !answered.has(question) && group[0]!.bottom < viewBottom) {
        await adb("shell", "input", "tap", String(group[0]!.x), String(group[0]!.y));
        answered.add(question);
      }
      group = [];
    };
    for (const n of nodes) {
      if (n.cls.endsWith("RadioButton")) group.push(n);
      else if (tagged ? n.id === "question" : n.cls.endsWith("TextView") && n.text && n.left <= 110) { await flush(); question = n.text; }
    }
    await flush();
    await adb("shell", "input", "swipe", "540", "1500", "540", "700", "300");
    await sleep(500);
  }
  return answered.size;
}

const fail = (msg: string): never => { server.stop(true); console.error(`capture: ${msg}`); process.exit(1); };
const version = async (pkg: string, field: "versionName" | "versionCode") =>
  (await adb("shell", "dumpsys", "package", pkg)).stdout.toString().match(new RegExp(`${field}=(\\S+)`))?.[1] ?? "";
const walletRelease = await version(WALLET, "versionName");
if (!walletRelease) fail(`${WALLET} is not installed on ${SERIAL}`);

await adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`);
await adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `http://127.0.0.1:${PORT}/`, "com.android.chrome");
for (let i = 0; i < 40 && !artifacts; i++) await sleep(500);
if (!artifacts) fail("the page never reported its request (is Chrome showing it?)");

const steps: string[] = [];
let tapped = false;
for (let i = 0; i < 10 && !tapped; i++) tapped = (await tapIfShown(/^Check in$/)) || (await sleep(1000), false);
if (!tapped) fail("could not find the page's Check in button");
for (let i = 0; i < 60 && !credential && !pageError; i++) {
  const nodes = await screen();
  if (nodes.some(isShare)) {
    steps.push(`answered ${await answerForms()} question(s)`);
    if (await tapIfShown(SHARE)) steps.push("shared from the wallet");
  } else {
    for (const [re, what] of [[/^No thanks$/, "dismissed a Chrome prompt"], [/^Continue$/, "trusted the site"], [/^Agree and continue$/, "picked the wallet"]] as const) {
      if (await tapIfShown(re)) { steps.push(what); break; }
    }
  }
  await sleep(1500);
}
server.stop(true);
console.log(`steps: ${steps.join(" → ")}`);
if (!credential) fail(pageError ? `the page got an error: ${pageError}` : "no credential reached the page");
await Bun.write(join(WORK, "artifacts.json"), artifacts);
await Bun.write(join(WORK, "credential.json"), credential);

const clientPkg = await Bun.file(join(ROOT, "node_modules/@smart-health-checkin/client/package.json")).json();
await Bun.write(join(WORK, "capture-env.json"), JSON.stringify({
  wallet: { release: walletRelease, versionCode: Number(await version(WALLET, "versionCode")) },
  client: clientPkg.version,
  chrome: await version("com.android.chrome", "versionName"),
  android: (await adb("shell", "getprop", "ro.build.version.release")).stdout.toString().trim(),
}, null, 2) + "\n");

const pulled = await $`bash ${join(ROOT, "scripts/pull-android-handler-run.sh")} ${join(WORK, "runs")}`
  .env({ ...process.env, ANDROID_SERIAL: SERIAL, ADB }).cwd(ROOT).quiet().nothrow();
if (pulled.exitCode) fail(`could not pull the wallet's run: ${pulled.stderr}`);
const runDir = pulled.stdout.toString().trim().split("\n").at(-1)!;
const assembled = await $`bash ${join(HERE, "assemble.sh")} ${ROOT} ${runDir} ${WORK}`.nothrow();
process.exit(assembled.exitCode);
