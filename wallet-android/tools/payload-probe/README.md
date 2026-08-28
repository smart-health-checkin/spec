# payload-probe — how big a response can the Android wallet return?

Empirical sweep of the DigitalCredential response size the wallet can hand
back through Android Credential Manager before Chrome's
`navigator.credentials.get()` stops receiving it.

Two halves:

- **On the wallet** — `app/src/main/java/.../PayloadProbe.kt`. If
  `files/payload-pad-bytes` exists in the app's private storage, `HandlerActivity`
  adds that many filler characters to the SMART response *before* it is sealed
  into the mdoc, so the padding takes the real route (CBOR → HPKE → base64url
  → `credentialJson` → Intent extra → Binder). It also logs, under tag
  `SHCPayloadProbe`, the SMART response size, the `credentialJson` size, and the
  exact Parcel size of the result Intent, and logs if `finish()` throws.
  Absent or `0` = no effect. Debug builds only (`run-as` is how the knob is set).

- **On the host** — `probe.py`. Per trial: sets the knob via `adb shell run-as`,
  loads the check-in demo in Chrome (`#wallet=platform`), wraps
  `navigator.credentials.get` through Chrome DevTools over adb so the promise
  outcome is captured, taps the start button with a *trusted* CDP touch (a
  synthetic `.click()` has no user activation), drives the system picker and the
  wallet's "Share selected data" button with uiautomator, then pulls the size log
  and any Binder / `TransactionTooLarge` / crash lines from logcat.

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk       # open the app once so it registers
python3 tools/payload-probe/probe.py --once 0                 # smoke test, verbose
python3 tools/payload-probe/probe.py --legacy --sizes 100000 300000 500000 800000
python3 tools/payload-probe/probe.py --legacy --bisect 300000 400000 --resolution 8000 --repeat 2
python3 tools/payload-probe/probe.py --sizes 1000000 10000000  # large-payload (3-arg) path
```

`--legacy` puts `files/payload-legacy` in place so the wallet returns through
the deprecated two-argument `setGetCredentialResponse` (Intent extra only);
without it the wallet uses the three-argument overload, which lets androidx
hand responses ≥ 200 KB to Chrome out of band.

For very large payloads (tens of MB) raise `--timeout` and `--hang-grace`
(seconds after the wallet returns before a silent hang is declared; Chrome
needs time to ingest 60+ MB of JSON), and build the wallet with
`./gradlew :app:assembleDebug -Pskip-matcher -Plarge-heap` to separate the
wallet's managed-heap cap (256 MB default, 512 MB with `largeHeap` on a Pixel)
from the transport. In probe mode the wallet skips its fixture-capture
artifacts, which would otherwise re-serialize the payload to disk. Do not
expect much past ~20 MB (default heap) / ~50 MB (`largeHeap`): the wallet's
own pipeline OOMs there, not the transport.

Each trial is classified from the promise outcome *and* logcat, so an
oversize response is recognised within seconds rather than waiting for a
promise that will never settle:

| outcome | meaning |
| --- | --- |
| `OK` | `navigator.credentials.get()` resolved; `dataLen` is the JSON length Chrome handed the page |
| `DROPPED_BY_SYSTEM_SERVER` | wallet `finish()` succeeded, but system_server could not deliver the result to the GMS picker (oneway `scheduleTransaction`, `TransactionTooLargeException`); picker left open, promise hangs |
| `WALLET_FINISH_THREW` | the wallet's own `finish()` threw (synchronous hop to system_server over ~1 MB) |
| `HANG_AFTER_WALLET_FINISH` | wallet returned, nothing settled in 30 s, no diagnostic in logcat |
| `PROBE_TIMEOUT` | nothing happened within `--timeout` (driver could not get through the UI) |

A dropped result leaves the picker activity on top of Chrome's task and it
would swallow the next request; the driver force-stops Play services to clear
it before the next trial. Never run `uiautomator dump` by hand while the
driver is running — two UiAutomation clients crash each other.

Results accumulate in `results/trials.jsonl` (one JSON record per trial, with
the promise outcome, wallet-logged sizes and path, taps performed, and
interesting logcat lines); the full logcat of each trial is saved beside it.
Findings from the first run are written up in
`../../../docs/research/10-android-response-size.md`.

Needs: adb with the device authorised, Chrome with the DC API (141+), the
debug wallet installed and registered, python3 `websockets`.
