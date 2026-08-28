#!/usr/bin/env python3
"""Drive the native RP spike (rp-app) through one direct CredentialManager request
and report what both sides logged. Reuses the UI helpers from probe.py."""
import re, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from probe import adb, adb_shell, sh, ui_nodes, tap_by_rules, log, PKG, GMS_PKG, foreground  # noqa: E402

RP = "org.smarthealthit.checkin.rp"
RULES = [
    (r"^Share selected data$", PKG),
    (r"^(Agree and continue|Agree|Continue|Allow|Use|Confirm)$", r"com\.google\.android\.gms|com\.android\.credentialmanager"),
    (r"^SMART Health Check-in$", r"com\.google\.android\.gms|com\.android\.credentialmanager"),
    (r"^Close$", PKG),
]

def tap_text(text_re, pkg_re):
    for text, pkg, _c, (x, y) in ui_nodes():
        if re.search(text_re, text, re.I) and re.search(pkg_re, pkg):
            adb_shell(f"input tap {x} {y}"); return f"tapped {text!r} in {pkg}"
    return None

def main():
    import probe
    probe.TAP_RULES[:] = RULES
    adb_shell(f"am force-stop {PKG}"); adb_shell(f"am force-stop {RP}")
    top = foreground()
    if "CredentialSelectorActivity" in top:
        adb_shell(f"am force-stop {GMS_PKG}"); time.sleep(2)
    time.sleep(1); adb("logcat", "-c")
    adb_shell(f"am start -n {RP}/.RpMainActivity"); time.sleep(2.5)
    log(tap_text(r"^Request check-in via CredentialManager", RP) or "RP button not found")
    t0 = time.time(); last_tap = {}; result = None
    while time.time() - t0 < 120:
        time.sleep(1.2)
        lc = adb("logcat", "-d", "-v", "time")
        m = re.search(r"SHCRp.*(RESULT ok=true.*|FAILED.*)", lc)
        if m: result = m.group(1); break
        t = tap_by_rules(last_tap)
        if t: log("  " + t)
    log("RP: " + (result or f"no result within 120 s; foreground={foreground()[:120]}"))
    wl = adb("logcat", "-d", "-v", "time", "-s", "SHCHandler:I", "SHCPayloadProbe:I", "*:S")
    for ln in wl.splitlines():
        if re.search(r"request origin=|delivery mode=|SHCPayloadProbe", ln): log("wallet: " + ln.split("): ", 1)[-1][:300])
    print("\n=== RP screen text ===")
    for text, pkg, _c, _xy in ui_nodes():
        if pkg == RP: print(text[:600])

if __name__ == "__main__":
    main()
