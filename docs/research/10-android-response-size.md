# How large a response can an Android wallet return?

Measured 2026-08-28 on a Pixel 11 Pro XL (Android 17, build CD1A.260714.001.A9),
Chrome 151.0.7922.173, Google Play services 26.32.34, with the wallet in
`wallet-android/` and the driver in `wallet-android/tools/payload-probe/`.

## TL;DR

- Nothing in the W3C Digital Credentials API, OpenID4VP, or ISO 18013-7 sets a
  response size. On Android the bound is Binder IPC, and it is **not a single
  number**: it depends on which hop fails, how the string is encoded, and what
  else is in flight to the receiving process.
- **Legacy path** (wallet calls the two-argument
  `PendingIntentHandler.setGetCredentialResponse(intent, response)` — what this
  wallet did until today, and what the Android holder docs still show): the
  response is an Intent extra. Measured ceiling on this phone: a result-Intent
  parcel of **514 KB passes, 522 KB is silently dropped** (2/2 each). Above
  ~1 MB the wallet itself crashes in `finish()`. Between the two, the failure
  is the worst kind: system_server drops the result, the picker stays open,
  and Chrome's promise never settles — no error anywhere the RP can see.
- **Large-payload path** (androidx.credentials ≥ 1.7.0‑alpha01 + the
  three-argument `setGetCredentialResponse(intent, response, request)` + a
  caller that offers a `ResultReceiver`, which Chrome does since **150**):
  any response whose bundle is ≥ 200 KB is written to a temp file and handed
  to Chrome as a file descriptor, bypassing Binder. Measured: **no transport
  ceiling up to 66.7 M characters** (50 MB of padding). Beyond ~20 MB
  (default heap) / ~50 MB (`largeHeap`) the *wallet's own* memory model is
  what fails — cleanly, and visibly to the RP.
- The fix for this wallet is in this change: `androidx.credentials` →
  `1.7.0-alpha03`, `registry-*` → `1.0.0-alpha05`, and `HandlerActivity`
  uses the three-argument overload. Wallets on older androidx (or the
  two-argument overload) keep the ~500 KB cliff.

## The path a response takes

```
wallet HandlerActivity.finish(resultIntent)
  │ 1. synchronous Binder → system_server (IActivityClientController.finishActivity)
  ▼                        target buffer: system_server's 1 MiB, shared with everything
system_server ActivityRecord.sendResult
  │ 2. ONEWAY Binder → GMS picker process (IApplicationThread.scheduleTransaction)
  ▼                        oneway budget: half the target's buffer = 512 KiB
com.google.android.gms:identitycredentials CredentialSelectorActivity
  │ 3. ResultReceiver → Chrome (the picker relays the provider Intent)
  ▼
Chrome DigitalCredentialsPresentationDelegate → Blink → navigator.credentials.get() resolves
```

Chrome does not use the framework `android.credentials.CredentialManager` for
digital credentials; it calls Play services' `IdentityCredentialClient`
directly, and the picker (`CredentialSelectorActivity`) is a GMS activity
launched into Chrome's task. Hop 2 is where the legacy path dies first.

## Documented limits (sources)

| Fact | Source |
| --- | --- |
| libbinder maps `BINDER_VM_SIZE = 1 MiB − 2 pages` per process | [ProcessState.cpp](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/binder/ProcessState.cpp) |
| The kernel reserves half of that for oneway (async) transactions: `free_async_space = buffer_size / 2`; a oneway transaction that does not fit fails with `-ENOSPC` → `BR_FAILED_REPLY` | [binder_alloc.c](https://android.googlesource.com/kernel/common/+/refs/heads/android-mainline/drivers/android/binder_alloc.c) |
| "The Binder transaction buffer has a limited fixed size, currently 1MB, which is shared by all transactions in progress for the process." | [TransactionTooLargeException](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/os/TransactionTooLargeException.java) |
| Result delivery is `oneway void scheduleTransaction(in ClientTransaction)`; `ActivityRecord.sendResult` catches the failure and only logs `Slog.w` — the result is dropped | [IApplicationThread.aidl](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/app/IApplicationThread.aidl), [ActivityRecord.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/wm/ActivityRecord.java) |
| `Parcel.writeString` is UTF‑16 (`writeString16`), so a JSON string costs 2 bytes per char | [Parcel.java](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/os/Parcel.java) |
| `DigitalCredential` stores `credentialJson` as a UTF‑8 byte array once it is ≥ 250,000 chars (`STRING_LEN_THRESHOLD`), otherwise as a String | [DigitalCredential.kt](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/credentials/credentials/src/main/java/androidx/credentials/DigitalCredential.kt) |
| androidx.credentials 1.7.0‑alpha01 (2026‑04‑22): "Support large credential payloads for getCredential API". Bundles ≥ 200 KB (`TWO_HUNDRED_KB`) go through `LargePayloadSupport.encodeBundleToPfd` (temp file + `ParcelFileDescriptor`) to the caller's `EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER`; the Intent only carries `EXTRA_PASS_IT_BY_RESULT_RECEIVER`. Only the three-argument `setGetCredentialResponse` does this; the two-argument overload is `@Deprecated` and always uses the Intent extra. | [PendingIntentHandler.kt](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/credentials/credentials/src/main/java/androidx/credentials/provider/PendingIntentHandler.kt), [LargePayloadSupport.kt](https://android.googlesource.com/platform/frameworks/support/+/refs/heads/androidx-main/credentials/credentials/src/main/java/androidx/credentials/internal/LargePayloadSupport.kt), [release notes](https://developer.android.com/jetpack/androidx/releases/credentials) |
| Chrome offers the receiver: "[DC] Implement LargePayloadSupport for Digital Credentials … to avoid TransactionTooLargeException when responses exceed Binder IPC limits" — first in 150.0.7832.0, stable in 150.0.7871.28 | [chromium 3e62ece6f0](https://chromium-review.googlesource.com/c/chromium/src/+/7780670), [DigitalCredentialsPresentationDelegate.java](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/webid/android/java/src/org/chromium/chrome/browser/webid/DigitalCredentialsPresentationDelegate.java) |

Not found anywhere: a size statement in the W3C DC API spec, OpenID4VP, or the
Android holder docs; any prior bug report about DC responses hitting this.

## Measured: legacy path (Intent extra through Binder)

`pad` is the number of filler bytes added to the SMART response before it is
CBOR-wrapped, HPKE-sealed and base64url-encoded into `credentialJson`;
`parcel` is the exact size of the wallet's result Intent as parcelled.

| pad | `credentialJson` chars | parcel bytes | outcome |
| ---: | ---: | ---: | --- |
| 0 | 13,597 | 27,664 | OK |
| 100,000 | 146,974 | 294,420 | OK (String → UTF‑16, 2×) |
| 150,000 | 213,642 | 427,756 | OK |
| 180,000 | 253,641 | 254,112 | OK (≥ 250k chars → byte array, 1×) |
| 200,000 | 280,309 | 280,780 | OK |
| 300,000 | 413,642 | 414,112 | OK |
| 350,000 | 480,308 | 480,776 | OK ×2 |
| 375,000 | 513,642 | **514,112** | **OK ×2** |
| 381,250 | 521,974 | **522,444** | **dropped ×2** — `!!! FAILED BINDER TRANSACTION !!! (parcel size = 523016)`, `ClientLifecycleManager: Failed to deliver transaction for ProcessRecord{… com.google.android.gms:identitycredentials}` |
| 387,500 | 530,308 | 530,776 | dropped ×2 |
| 400,000 | 546,973 | 547,444 | dropped |
| 500,000 | 680,309 | 680,780 | dropped |
| 600,000 | 813,642 | 814,112 | dropped |
| 800,000 | 1,080,306 | 1,080,776 | wallet `finish()` throws `RuntimeException: TransactionTooLargeException` (hop 1) |
| 1,000,000 | 1,346,976 | 1,347,444 | wallet crashes in `finish()` |
| 2,000,000 | 2,680,306 | 2,680,776 | wallet crashes in `finish()` |

Reading it:

- The cliff is at hop 2: the oneway transaction (parcel + ~570 bytes of
  `ClientTransaction` wrapping) must fit the picker process's 512 KiB
  (524,288 B) async budget — minus buffer bookkeeping and whatever other
  oneway traffic that process has in flight. On this idle phone the boundary
  fell between 514,684 and 523,016 transaction bytes. Under load it will be
  lower, so treat ~500 KB as the ceiling and budget well under it.
- Because of the UTF‑16/byte-array switch at 250,000 chars, the legacy path is
  **not monotonic**: a 240,000-char `credentialJson` costs ~480 KB of parcel
  and is one busy moment away from being dropped, while a 300,000-char one
  costs ~300 KB and is fine. With an androidx that predates
  `STRING_LEN_THRESHOLD`, everything is UTF‑16 and the cliff sits near
  ~255,000 chars.
- The failure between 522 KB and ~1 MB is silent for everyone: the wallet
  returns normally, system_server logs a warning, the picker waits forever,
  `navigator.credentials.get()` never settles. Only logcat tells you.
- The synchronous hop 1 is the stricter of the two only above ~1 MB, where
  the wallet crashes instead (`ActivityClient.finishActivity`).

## Measured: large-payload path (three-argument overload, Chrome offers a receiver)

Same wallet, same phone, `files/payload-legacy` absent. Chrome 151 put
`EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER` in every request (`receiverOffered=true`).

| pad | `credentialJson` chars | result-Intent parcel bytes | out of band | end-to-end | outcome |
| ---: | ---: | ---: | :---: | ---: | --- |
| 50,000 | 80,300 | 161,072 | no (< 200 KB) | 13.7 s | OK |
| 100,000 | 146,973 | 216 | yes | 14.1 s | OK |
| 300,000 | 413,640 | 216 | yes | 14.1 s | OK |
| 400,000 | 546,973 | 216 | yes | 14.2 s | OK — the size that hung the legacy path |
| 1,000,000 | 1,346,974 | 216 | yes | 14.1 s | OK |
| 2,000,000 | 2,680,309 | 216 | yes | 15.2 s | OK |
| 5,000,000 | 6,680,308 | 216 | yes | 18.5 s | OK |
| 10,000,000 | 13,346,974 | 216 | yes | 24.1 s | OK — page received all 13.3 M chars |

No ceiling found up to 13.3 MB of `credentialJson`. Once the bundle crosses
200 KB the Intent carries only the `EXTRA_PASS_IT_BY_RESULT_RECEIVER` flag and
the payload rides a temp-file descriptor straight from the wallet process to
Chrome's `ResultReceiver`, so Binder never sees it. The growth in elapsed time
is the wallet building/sealing/base64-encoding the mdoc and Chrome parsing the
JSON, not the transport. Practical limits above this are memory (the JSON is
held as a String in the wallet, in Chrome, and in the page) and patience —
not IPC.

For completeness, a wallet on this path with an **old Chrome (< 150)** or a
native caller that does not offer a receiver falls back to the Intent extra
and gets the legacy numbers above; androidx logs nothing when it does.

### Pushing further: 20 MB, 50 MB, 100 MB

Same path, with the wallet's fixture-capture artifacts disabled (they would
re-serialize the payload to disk several times). `heap` is the wallet's
`Runtime.maxMemory()`: 256 MB by default on this phone
(`dalvik.vm.heapgrowthlimit`), 512 MB with `android:largeHeap="true"`
(`dalvik.vm.heapsize`; build with `-Plarge-heap`).

| pad | `credentialJson` chars | wallet heap | end-to-end | outcome |
| ---: | ---: | ---: | ---: | --- |
| 20,000,000 | 26,680,308 | 256 MB | 32 s | OK — page received all 26.7 M chars |
| 50,000,000 | — | 256 MB | — | wallet `OutOfMemoryError` while CBOR-encoding: `Failed to allocate a 100018144 byte allocation with 63328784 free bytes and 60MB until OOM … growth limit 268435456` (`ByteArrayOutputStream.grow` doubling inside `MdocCbor.writeTypeAndLength`). Wallet shows "Could not complete request"; after Close, Chrome rejects the promise with **`NetworkError: Error retrieving a token.`** |
| 50,000,000 | 66,680,309 | 512 MB | 66 s | OK — page received all 66.7 M chars |
| 100,000,000 | — | 512 MB | — | wallet `OutOfMemoryError` at the same site: `Failed to allocate a 200018144 byte allocation with 131723792 free bytes and 125MB until OOM … growth limit 536870912` |

Reading it:

- **The transport never failed.** Every response the wallet managed to build
  reached the page intact, up to 66.7 M characters. The ceiling moved to the
  *endpoints' memory model*: the wallet's Kotlin pipeline holds the payload
  several times over (filler → SMART JSON → CBOR → HPKE ciphertext → base64 →
  `credentialJson` → UTF‑8 bytes → marshalled parcel → file), and its CBOR
  encoder writes into a `ByteArrayOutputStream` that doubles, so the final
  growth step alone needs 2× the payload contiguously. Hence ~20 MB fits a
  256 MB heap and ~50 MB fits a 512 MB one.
- The cap is Android's per-app managed-heap policy (`heapgrowthlimit` /
  `heapsize`), not RAM — this phone had 16 GB with 4 GB free. Native memory
  is not subject to it, which is why Chrome's side coped with 67 MB.
- This failure *is* visible to the RP (a rejected promise, generic
  `NetworkError`) once the user dismisses the wallet's error, unlike the legacy
  Binder drop, which never settles.
- Hundreds of MB or a GB are not realistic through this API for any
  in-memory design: both the wallet and Chrome's Java layer would have to hold
  the whole JSON, and V8 strings top out around 1 G characters anyway. Payloads
  of that order belong in an out-of-band fetch (a pointer such as a SMART
  Health Link in the response).
- A wallet that wants tens of MB should: build off the main thread (this one
  blocks the UI thread for the whole build — a minute at 50 MB), pre-size or
  stream its encoders instead of doubling, and avoid keeping every
  intermediate copy alive. `largeHeap` only buys 2×.

### Knowing which world you are in, from inside the wallet

The wallet can tell, per request, whether the *transport* is the 500 KB world
or the unbounded one: the request's option `requestData` contains a
`ResultReceiver` under
`androidx.credentials.provider.EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER` when the
caller (Chrome ≥ 150) accepts out-of-band delivery, and not otherwise. It can
also read its own headroom (`Runtime.maxMemory()`). What it cannot learn is
the caller's capacity, so even on the large path it needs a policy ceiling
(tens of MB at most). Above budget, a wallet should offer narrower
selections or return a pointer (SMART Health Link) instead of bytes.

The sample wallet packages this as `ResponseDelivery.describe(request)` in
`wallet-android/smart-checkin-credential-manager` (→ `callerAcceptsLargePayloads`,
`heapMaxMB`, `budgetChars`) and logs it for every request; it takes no action
on it yet. The keys it reads are `@RestrictTo(LIBRARY)` in androidx — a
de-facto handshake, not a public API.

## What this means for SMART Health Check-in

1. **Wallets**: depend on `androidx.credentials` ≥ 1.7.0‑alpha01 and call
   `PendingIntentHandler.setGetCredentialResponse(intent, response, request)`.
   The two-argument overload — still what the Android holder guide shows —
   silently caps you at ~500 KB of parcel, i.e. roughly 200,000 chars of
   `credentialJson`, i.e. roughly 140 KB of SMART response JSON before
   CBOR/HPKE/base64 overhead.
2. **Verifiers cannot detect the legacy failure**; the promise hangs. A
   verifier page should run its own timeout on `navigator.credentials.get()`
   and fall back (QR/handoff, or asking for less), rather than assuming an
   error will arrive.
3. **The spec** should not promise a hard limit, but it can state the
   platform reality: a same-device `org-iso-mdoc` response is bounded by the
   Android Credential Manager transport; wallets built on the deprecated
   overload should keep `credentialJson` under ~200,000 characters, and
   verifiers should keep individual request items small enough that a
   plausible answer stays under that. Responses that legitimately exceed it
   (full clinical histories, questionnaires with attachments) need either the
   large-payload path on both ends or an out-of-band fetch (a pointer in the
   response, resolved server-side).

## Reproducing

```sh
cd wallet-android
./gradlew :app:assembleDebug -Pskip-matcher
adb install app/build/outputs/apk/debug/app-debug.apk       # then open the app once so it registers
python3 tools/payload-probe/probe.py --legacy --sizes 300000 400000
python3 tools/payload-probe/probe.py --legacy --bisect 300000 400000 --resolution 8000 --repeat 2
python3 tools/payload-probe/probe.py --sizes 1000000 10000000
```

The driver needs no hands on the phone: it taps Chrome's share prompt, the
picker's "Agree and continue", and the wallet's "Share selected data" itself,
and classifies each trial from the promise outcome plus logcat. Records land
in `tools/payload-probe/results/trials.jsonl`.
