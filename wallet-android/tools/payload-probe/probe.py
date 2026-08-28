#!/usr/bin/env python3
"""
Payload-size probe for the Android SMART Health Check-in wallet.

Sweeps how large a DigitalCredential response the wallet can hand back through
Android Credential Manager before Chrome's `navigator.credentials.get()` stops
receiving it. One trial =

  1. write N to the wallet's `files/payload-pad-bytes` knob (see PayloadProbe.kt)
  2. load the check-in demo page in Chrome on the phone (`#wallet=platform`)
  3. wrap `navigator.credentials.get` in the page (via Chrome DevTools over adb)
     so the promise outcome is recorded in `window.__shcProbe`
  4. tap "Check in with your health app" with a *trusted* CDP touch event
     (synthetic `.click()` carries no user activation, the DC API needs one)
  5. drive the system picker + wallet consent screen with uiautomator taps
  6. read the promise outcome, and pull the wallet's size log + any Binder /
     TransactionTooLarge / crash lines out of logcat

Usage:
  probe.py --sizes 0 100000 300000            # explicit pad sizes (bytes of filler in the SMART response)
  probe.py --bisect 0 2000000 --resolution 16384 --repeat 2
  probe.py --once 400000                      # single trial, verbose

Requires: adb (device authorised), Chrome on the device with the wallet
installed (debug build, so `run-as` works), python3 `websockets`.
"""
import argparse
import asyncio
import json
import re
import subprocess
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import websockets

PKG = "org.smarthealthit.checkin.wallet"
CHROME_PKG = "com.android.chrome"
GMS_PKG = "com.google.android.gms"
DEMO_URL = "https://smart-health-checkin.org/client/demo/#wallet=platform"
CDP_PORT = 9222
OUT_DIR = Path(__file__).parent / "results"

# (regex on node text/content-desc, regex on node package) tapped in priority
# order while waiting for the credential promise to settle.
TAP_RULES = [
    (r"^Share selected data$", PKG),
    # Chrome's own "share data with this site?" interstitial before the picker.
    (r"^(Continue|Agree|Share|Allow|Confirm|Yes|OK|Verify)$", r"^com\.android\.chrome$"),
    # The picker's consent sheet repeats the entry title, so consent buttons rank above the entry.
    (r"^(Agree and continue|Agree|Continue|Allow|Use|Confirm)$", r"com\.google\.android\.gms|com\.android\.credentialmanager"),
    (r"^SMART Health Check-in$", r"com\.google\.android\.gms|com\.android\.credentialmanager"),
    (r"^(Close app|Close|OK)$", r"^android$|com\.android\.systemui|com\.google\.android"),
    # The wallet's own "Could not complete request" screen (e.g. OutOfMemoryError caught
    # while building the response): Close makes it return an exception to the caller.
    (r"^Close$", PKG),
]

LOGCAT_INTEREST = re.compile(
    r"SHCPayloadProbe|SHCHandler|TransactionTooLarge|FAILED BINDER|DeadObject|too large|"
    r"FATAL EXCEPTION|Force finishing|has died|binder_alloc|no async space|"
    r"cr_DigitalCredential|cr_IdentityCredential|LargePayloadSupport|"
    r"IdentityCredential.*(Exception|Error|fail)|CredentialSelector.*(Exception|Error|fail)|"
    r"Process .* has died|ANR in|am_crash",
)
LOGCAT_NOISE = re.compile(r"NullBinder|WindowManager|CoreBackPreview|uiautomator|RuntimeInit|Using default boot image|lock profiling")


def sh(*args, timeout=30, check=False, text=True):
    return subprocess.run(list(args), capture_output=True, text=text, timeout=timeout, check=check)


def adb(*args, timeout=30):
    r = sh("adb", *args, timeout=timeout)
    return r.stdout


def adb_shell(cmd, timeout=30):
    return adb("shell", cmd, timeout=timeout)


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- device UI

BOUNDS = re.compile(r"\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]")


def ui_nodes():
    """uiautomator dump -> list of (text, package, clickable, center)."""
    try:
        r = sh("adb", "exec-out", "uiautomator", "dump", "/dev/tty", timeout=20)
    except subprocess.TimeoutExpired:
        return []
    xml = r.stdout
    start = xml.find("<?xml")
    if start < 0:
        start = xml.find("<hierarchy")
    if start < 0:
        return []
    xml = xml[start:]
    end = xml.rfind("</hierarchy>")
    if end > 0:
        xml = xml[: end + len("</hierarchy>")]
    try:
        root = ET.fromstring(xml)
    except ET.ParseError:
        return []
    out = []
    for n in root.iter("node"):
        text = n.get("text") or n.get("content-desc") or ""
        m = BOUNDS.match(n.get("bounds", ""))
        if not text.strip() or not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        if x2 <= x1 or y2 <= y1:
            continue
        out.append((text.strip(), n.get("package", ""), n.get("clickable") == "true", ((x1 + x2) // 2, (y1 + y2) // 2)))
    return out


def tap_by_rules(last_tap, verbose=False):
    nodes = ui_nodes()
    if verbose:
        seen = [(t[:32], p.split(".")[-1], "c" if c else "-") for t, p, c, _ in nodes]
        if seen:
            log(f"  texts: {seen[:16]}")
    for text_re, pkg_re in TAP_RULES:
        for text, pkg, clickable, (x, y) in nodes:
            if re.search(text_re, text) and re.search(pkg_re, pkg):
                key = (text, x, y)
                # Once the wallet's share button is tapped it may be busy for a long time on
                # large payloads; repeated input while it is blocked would provoke an ANR.
                cooldown = 180 if text == "Share selected data" else 4
                if last_tap.get("key") == key and time.time() - last_tap.get("t", 0) < cooldown:
                    return None
                adb_shell(f"input tap {x} {y}")
                last_tap.update(key=key, t=time.time())
                return f"tapped {text!r} in {pkg} at ({x},{y})"
    return None


def foreground():
    out = adb_shell("dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity|mResumedActivity'")
    return out.strip()


# Early-terminal signals from logcat while a trial is waiting on the promise.
DIAG_TAGS = ["SHCPayloadProbe:I", "ClientLifecycleManager:W", "ActivityTaskManager:W", "ActivityManager:W", "ActivityManager:I", "AndroidRuntime:E", "libc:F", "DEBUG:F", "*:S"]
TTL_RE = re.compile(r"TransactionTooLargeException: data parcel size (\d+) bytes")
WALLET_CRASH_RE = re.compile(r"FATAL EXCEPTION.*\n.*Process: " + re.escape(PKG), re.M)


def diag_logcat():
    return adb("logcat", "-d", "-v", "time", "-s", *DIAG_TAGS, timeout=20)


HANG_GRACE_S = 30


def classify_early(tail, wallet_logged_at):
    """Return (name, message) when logcat already tells us the trial cannot succeed."""
    # Order matters: a wallet whose own finish() threw also prints the
    # TransactionTooLargeException text, so check that first.
    if "finish() threw" in tail:
        return ("WALLET_FINISH_THREW", "wallet -> system_server (synchronous finishActivity) failed: " + tail.split("finish() threw", 1)[1].splitlines()[0][:200])
    m = TTL_RE.search(tail)
    if wallet_logged_at and m:
        return ("DROPPED_BY_SYSTEM_SERVER", f"system_server could not deliver the result to the picker (oneway scheduleTransaction): TransactionTooLargeException, data parcel size {m[1]} bytes; picker left waiting, promise never settles")
    if WALLET_CRASH_RE.search(tail):
        m2 = re.search(r"Process: " + re.escape(PKG) + r"[^\n]*\n[^\n]*?(\S*(?:Exception|Error)[^\n]{0,160})", tail)
        return ("WALLET_CRASHED", "FATAL EXCEPTION in the wallet process: " + (m2[1] if m2 else "see logcat"))
    killed = [ln for ln in tail.splitlines() if re.search(r"Killing \d+:" + re.escape(PKG) + r"|Process " + re.escape(PKG) + r" .*has died", ln) and "stop " + PKG not in ln]
    if killed:
        return ("WALLET_KILLED", "wallet process died or was killed: " + killed[0][:220])
    if wallet_logged_at and time.time() - wallet_logged_at > HANG_GRACE_S:
        return ("HANG_AFTER_WALLET_FINISH", f"no promise settlement {HANG_GRACE_S} s after the wallet returned and no diagnostic in logcat")
    return None


# ---------------------------------------------------------------- Chrome CDP


class CDP:
    def __init__(self):
        self.ws = None
        self.next_id = 0

    async def connect(self):
        sh("adb", "forward", f"tcp:{CDP_PORT}", "localabstract:chrome_devtools_remote")
        target = None
        for attempt in range(20):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/list", timeout=5) as r:
                    targets = json.load(r)
            except Exception as e:  # noqa: BLE001
                if attempt == 0:
                    log(f"Chrome DevTools not reachable yet ({e}); launching Chrome")
                    adb_shell(f"am start -a android.intent.action.VIEW -d '{DEMO_URL}' com.android.chrome")
                await asyncio.sleep(1.5)
                continue
            pages = [t for t in targets if t.get("type") == "page"]
            target = next((t for t in pages if "client/demo" in t.get("url", "")), None)
            if target is None:
                if attempt == 0:
                    adb_shell(f"am start -a android.intent.action.VIEW -d '{DEMO_URL}' com.android.chrome")
                await asyncio.sleep(1.5)
                continue
            break
        if target is None:
            raise RuntimeError("could not find the demo page tab in Chrome (is Chrome open? adb forward ok?)")
        self.ws = await websockets.connect(target["webSocketDebuggerUrl"], max_size=None)
        await self.send("Runtime.enable")
        await self.send("Page.enable")
        return target

    async def send(self, method, params=None, timeout=20):
        self.next_id += 1
        msg_id = self.next_id
        await self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError(f"CDP {method} timed out")
            raw = await asyncio.wait_for(self.ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP {method}: {msg['error']}")
                return msg.get("result", {})

    async def eval(self, expr, timeout=20):
        r = await self.send(
            "Runtime.evaluate",
            {"expression": expr, "awaitPromise": True, "returnByValue": True},
            timeout=timeout,
        )
        if "exceptionDetails" in r:
            raise RuntimeError(f"JS exception: {r['exceptionDetails'].get('text')} {r['exceptionDetails'].get('exception', {}).get('description', '')}")
        return r.get("result", {}).get("value")

    async def alive(self):
        try:
            return (await self.eval("1", timeout=5)) == 1
        except Exception:  # noqa: BLE001
            return False

    async def ensure_clean_start(self):
        """A dropped result leaves the GMS picker activity on top of Chrome's task, where it
        would swallow the next request; a crashed wallet may leave a dialog. Clear them."""
        top = foreground()
        if "CredentialSelectorActivity" in top or PKG in top:
            log(f"  clearing stale UI: {top[:100]}")
            adb_shell(f"am force-stop {PKG}")
            adb_shell(f"am force-stop {GMS_PKG}")  # the picker is a GMS activity; force-stopping Chrome does not remove it
            await asyncio.sleep(2)
        if not await self.alive():
            log("  Chrome DevTools connection lost; reconnecting")
            await self.close()
            await self.connect()

    async def navigate_fresh(self):
        # A same-URL fragment navigation is same-document, so reload to reset page state.
        await self.send("Page.navigate", {"url": DEMO_URL})
        await asyncio.sleep(0.3)
        await self.send("Page.reload")
        for _ in range(60):
            await asyncio.sleep(0.5)
            try:
                ok = await self.eval(
                    "document.readyState === 'complete' && !!document.getElementById('start') && !document.getElementById('start').disabled"
                )
            except Exception:  # noqa: BLE001
                ok = False
            if ok:
                return
        raise RuntimeError("demo page did not become ready (start button missing or disabled)")

    async def install_wrapper(self):
        return await self.eval(
            r"""(() => {
              if (window.__shcProbe) return 'already';
              const orig = navigator.credentials.get.bind(navigator.credentials);
              window.__shcProbe = { results: [] };
              navigator.credentials.get = function (o) {
                const t0 = performance.now();
                const p = orig(o);
                p.then(
                  (r) => {
                    let dataLen = -1;
                    try { dataLen = JSON.stringify(r && r.data !== undefined ? r.data : null).length; } catch (e) {}
                    window.__shcProbe.results.push({ ok: true, ms: Math.round(performance.now() - t0), dataLen, protocol: r && r.protocol });
                  },
                  (e) => {
                    window.__shcProbe.results.push({ ok: false, ms: Math.round(performance.now() - t0), name: e && e.name, message: String(e && e.message) });
                  },
                );
                return p;
              };
              return 'installed';
            })()"""
        )

    async def trusted_tap(self, selector):
        rect = await self.eval(
            f"""(() => {{
              const el = document.querySelector({json.dumps(selector)});
              if (!el) return null;
              el.scrollIntoView({{ block: 'center' }});
              const r = el.getBoundingClientRect();
              return {{ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }};
            }})()"""
        )
        if not rect or rect["w"] <= 0:
            raise RuntimeError(f"{selector} not found / zero size")
        await asyncio.sleep(0.3)
        pt = {"x": rect["x"], "y": rect["y"]}
        await self.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [pt]})
        await self.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})

    async def results_count(self):
        return await self.eval("window.__shcProbe ? window.__shcProbe.results.length : -1", timeout=10)

    async def last_result(self):
        return await self.eval("window.__shcProbe.results[window.__shcProbe.results.length - 1]", timeout=10)

    async def close(self):
        if self.ws:
            await self.ws.close()


# ---------------------------------------------------------------- trial


def set_pad(n):
    r = sh("adb", "shell", f"run-as {PKG} sh -c 'mkdir -p files && echo {int(n)} > files/payload-pad-bytes && cat files/payload-pad-bytes'")
    got = r.stdout.strip()
    if got != str(int(n)):
        raise RuntimeError(f"could not set pad knob via run-as (debug build installed?): {r.stdout!r} {r.stderr!r}")


def set_legacy(flag):
    """files/payload-legacy present => wallet uses the deprecated 2-arg setGetCredentialResponse (Intent extra only)."""
    cmd = "touch files/payload-legacy" if flag else "rm -f files/payload-legacy"
    r = sh("adb", "shell", f"run-as {PKG} sh -c 'mkdir -p files && {cmd} && ls files'")
    present = "payload-legacy" in r.stdout
    if present != bool(flag):
        raise RuntimeError(f"could not set legacy knob: {r.stdout!r} {r.stderr!r}")


def parse_wallet_log(lines):
    info = {}
    for ln in lines:
        m = re.search(r"pad=(\d+) (?:path=(\S+) receiverOffered=(\w+) passedByReceiver=(\w+) )?(?:smartResponseChars=(\d+) )?credentialJsonChars=(\d+) resultIntentParcelBytes=(\d+)(?: heapMaxMB=(\d+))?", ln)
        if m:
            info.update(pad=int(m[1]), credentialJsonChars=int(m[6]), resultIntentParcelBytes=int(m[7]))
            if m[5]:
                info["smartResponseChars"] = int(m[5])
            if m[8]:
                info["walletHeapMaxMB"] = int(m[8])
            if m[2]:
                info.update(path=m[2], receiverOffered=m[3] == "true", passedByReceiver=m[4] == "true")
        if "finish() threw" in ln:
            info["walletFinishThrew"] = ln.split("finish() threw", 1)[1].strip()[:300]
    return info


async def run_trial(cdp, pad, timeout_s=150, verbose=False):
    set_pad(pad)
    await cdp.ensure_clean_start()
    adb_shell(f"am force-stop {PKG}")  # fresh wallet process each time: no leftover binder buffers
    await asyncio.sleep(1.0)
    adb("logcat", "-c")  # after the force-stop, so its own "Killing"/"has died" lines are not misread
    t0 = time.time()
    await cdp.navigate_fresh()
    await cdp.install_wrapper()
    before = await cdp.results_count()
    await cdp.trusted_tap("#start")
    last_tap = {}
    taps = []
    outcome = None
    wallet_logged_at = None
    early = None
    iteration = 0
    while time.time() - t0 < timeout_s:
        await asyncio.sleep(1.2)
        iteration += 1
        try:
            n = await cdp.results_count()
        except Exception as e:  # noqa: BLE001
            n = before
            if verbose:
                log(f"  results_count failed: {e}")
            if not await cdp.alive():
                # The DevTools socket can drop while Chrome is busy with a huge payload;
                # the page keeps window.__shcProbe, so just reattach to the same tab.
                log("  DevTools socket lost mid-trial; reattaching")
                try:
                    await cdp.close()
                    await cdp.connect()
                except Exception as e2:  # noqa: BLE001
                    log(f"  reattach failed: {e2}")
        if n > before:
            outcome = await cdp.last_result()
            break
        if iteration % 2 == 0:
            tail = diag_logcat()
            if wallet_logged_at is None and "resultIntentParcelBytes=" in tail:
                wallet_logged_at = time.time()
                if verbose:
                    log("  wallet returned its result")
            early = classify_early(tail, wallet_logged_at)
            if early:
                await asyncio.sleep(4)  # grace, in case the promise settles after all
                try:
                    n = await cdp.results_count()
                except Exception:  # noqa: BLE001
                    n = before
                if n > before:
                    outcome = await cdp.last_result()
                else:
                    outcome = {"ok": False, "name": early[0], "message": early[1]}
                break
        t = tap_by_rules(last_tap, verbose=verbose)
        if t:
            taps.append(f"{time.time() - t0:5.1f}s {t}")
            if verbose:
                log("  " + t)
    elapsed = time.time() - t0
    raw = adb("logcat", "-d", "-v", "time", timeout=60)
    interesting = [ln for ln in raw.splitlines() if LOGCAT_INTEREST.search(ln) and not LOGCAT_NOISE.search(ln)]
    wallet = parse_wallet_log(interesting)
    rec = {
        "pad": pad,
        "elapsed_s": round(elapsed, 1),
        "outcome": outcome if outcome else {"ok": False, "name": "PROBE_TIMEOUT", "message": f"no promise settlement within {timeout_s}s; foreground={foreground()}"},
        "wallet": wallet,
        "taps": taps,
        "logcat_interesting": interesting[-80:],
    }
    OUT_DIR.mkdir(exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    (OUT_DIR / f"logcat-{stamp}-pad{pad}.txt").write_text(raw)
    with (OUT_DIR / "trials.jsonl").open("a") as f:
        f.write(json.dumps(rec) + "\n")
    return rec


def summarize(rec):
    o = rec["outcome"]
    w = rec["wallet"]
    status = "OK " if o.get("ok") else "FAIL"
    detail = f"dataLen={o.get('dataLen')}" if o.get("ok") else f"{o.get('name')}: {str(o.get('message'))[:120]}"
    sizes = f"credJson={w.get('credentialJsonChars', '?')} parcel={w.get('resultIntentParcelBytes', '?')}"
    path = f"{w.get('path', '?')}/rcv={'y' if w.get('receiverOffered') else 'n'}/oob={'y' if w.get('passedByReceiver') else 'n'}"
    extra = f" walletFinishThrew={w['walletFinishThrew'][:80]}" if "walletFinishThrew" in w else ""
    return f"{status} pad={rec['pad']:>9} {sizes:<38} {path:<32} {rec['elapsed_s']:>5}s {detail}{extra}"


def device_info():
    info = {}
    for k, cmd in {
        "model": "getprop ro.product.model",
        "android": "getprop ro.build.version.release",
        "sdk": "getprop ro.build.version.sdk",
        "build": "getprop ro.build.display.id",
        "chrome": "dumpsys package com.android.chrome | grep -m1 versionName",
        "gms": "dumpsys package com.google.android.gms | grep -m1 versionName",
        "wallet": f"dumpsys package {PKG} | grep -m1 versionName",
    }.items():
        info[k] = adb_shell(cmd).strip()
    return info


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sizes", nargs="*", type=int, help="explicit pad sizes to try, in order")
    ap.add_argument("--bisect", nargs=2, type=int, metavar=("LO_OK", "HI_FAIL"), help="bisect between a size that works and one that fails")
    ap.add_argument("--resolution", type=int, default=16384, help="stop bisecting when hi-lo <= this")
    ap.add_argument("--repeat", type=int, default=1, help="repeat each size this many times")
    ap.add_argument("--once", type=int, help="single verbose trial at this pad size")
    ap.add_argument("--timeout", type=int, default=90, help="seconds to wait for the promise per trial (backstop; drops/crashes are detected from logcat much sooner)")
    ap.add_argument("--hang-grace", type=int, default=30, help="seconds after the wallet returns before a silent hang is declared (raise for very large payloads)")
    ap.add_argument("--legacy", action="store_true", help="force the wallet onto the deprecated 2-arg setGetCredentialResponse (Intent extra through Binder only)")
    args = ap.parse_args()

    if sh("adb", "get-state").stdout.strip() != "device":
        sys.exit("no adb device (adb get-state != device)")
    global HANG_GRACE_S
    HANG_GRACE_S = args.hang_grace
    info = device_info()
    info["legacyPath"] = args.legacy
    set_legacy(args.legacy)
    log("device: " + json.dumps(info))
    cdp = CDP()
    target = await cdp.connect()
    log(f"attached to Chrome tab: {target.get('url')}")

    results = []
    try:
        if args.once is not None:
            rec = await run_trial(cdp, args.once, args.timeout, verbose=True)
            print(json.dumps(rec, indent=2))
            results.append(rec)
        elif args.sizes is not None:
            for size in args.sizes:
                for _ in range(args.repeat):
                    rec = await run_trial(cdp, size, args.timeout)
                    log(summarize(rec))
                    results.append(rec)
        elif args.bisect:
            lo, hi = args.bisect
            while hi - lo > args.resolution:
                mid = (lo + hi) // 2
                oks = []
                for _ in range(args.repeat):
                    rec = await run_trial(cdp, mid, args.timeout)
                    log(summarize(rec))
                    results.append(rec)
                    oks.append(bool(rec["outcome"].get("ok")))
                if all(oks):
                    lo = mid
                else:
                    hi = mid
                log(f"  bracket now ok<={lo} fail>={hi}")
            log(f"RESULT: largest pad that worked = {lo}, smallest that failed = {hi} (resolution {args.resolution})")
        else:
            ap.print_help()
    finally:
        set_pad(0)
        await cdp.close()

    if results:
        print("\n== summary ==")
        for rec in results:
            print(summarize(rec))
        print(f"\nfull records: {OUT_DIR / 'trials.jsonl'}")


if __name__ == "__main__":
    asyncio.run(main())
