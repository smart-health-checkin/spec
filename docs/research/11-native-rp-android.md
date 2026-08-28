# Can a native Android app be the relying party?

Question: an Android app (think MyChart) wants to request a SMART Health
Check-in from the wallet. Can it invoke the platform directly, or does it need
a web surface — and if so, an embedded browser or a pivot out to Chrome?

Answered 2026-08-28 with sources plus a working spike, `wallet-android/rp-app`,
run on a Pixel 11 Pro XL (Android 17, Play services 26.32, Chrome/WebView 151)
against the wallet in `wallet-android/`.

## TL;DR

| Surface | Works? | UX | Notes |
| --- | --- | --- | --- |
| **Direct** — `CredentialManager.getCredential(GetDigitalCredentialOption)` | **Yes** | one API call; Play services shows the same bottom-sheet picker Chrome gets; wallet consent screen; back in the app with the response. **8 s, two user taps** on the Pixel. No browser anywhere. | androidx.credentials ≥ 1.5 (`@ExperimentalDigitalCredentialApi`), routed to Play services (≥ 24.31) on every Android version, API 23+. Large responses work (1.45 M chars measured) — native callers get the large-payload receiver automatically. |
| WebView | **No** | — | Chromium only wires a Digital Credentials provider in Chrome proper; WebView 151 exposes `navigator.credentials.get` but no `DigitalCredential`; the demo page reports "this browser has no Digital Credentials API". |
| Chrome Custom Tab | Yes, but | user is pivoted into browser chrome; the response lands in the web page, so returning it to the app needs a redirect/deep-link hop and server plumbing | it is Chrome, so the web flow applies unchanged. Only worth it if the RP already has a web check-in. |

Recommendation: native RPs should use the direct path. The web surface is
neither required nor helpful.

## The direct path, concretely

```kotlin
// androidx.credentials:credentials + credentials-play-services-auth (1.7.0-alpha03 here)
val built = OrgIsoMdocRequestBuilder.build(smartRequestJson)        // same wire request as rp-web builds
val response = CredentialManager.create(activity).getCredential(
    activity,
    GetCredentialRequest(listOf(GetDigitalCredentialOption(built.requestJson))),
)
val credential = response.credential as DigitalCredential           // credentialJson: {"protocol":"org-iso-mdoc","data":{"response":...}}
```

- `requestJson` is the W3C DC API shape, `{"requests":[{"protocol":"org-iso-mdoc","data":{"deviceRequest","encryptionInfo"}}]}`,
  exactly what the web verifier passes to `navigator.credentials.get`. The
  spike builds it in ~60 lines of Kotlin on top of the wallet's `MdocCbor` and
  `SmartMdocCrypto`; the wallet's matcher picks it up like any web request.
- The response is opened with the RP's own HPKE key (`SmartMdocCrypto.hpkeOpen`,
  added for this spike) using a SessionTranscript built from the **origin the
  wallet derived for the app** — see the caveat below.
- Measured on the Pixel: 7.96 s / 112 K-char response (82 K-char SMART
  response) and 8.23 s / 1.45 M-char response, both with two automated taps
  ("Agree and continue" in the picker, "Share selected data" in the wallet).

### Who the wallet thinks is calling

For a browser caller `CallingAppInfo.getOrigin()` yields the web origin. For a
native caller it is null (`isOriginPopulated=false`), and the wallet sees the
package name and signing certificate. The Android holder guide, Multipaz and
Google Wallet all bind app callers as
`android:apk-key-hash:<sha256(signing cert)>` (Android's snippet uses standard
base64, Google Wallet's uses base64url — the two Google docs disagree). **Our
wallet currently falls back to `android-app:<package>`**
(`HandlerActivity.resolveOrigin`, logged as `source=android-app-fallback`);
the spike tried all three strings and only that one decrypted. Before any
third-party RP integrates, the wallet should switch to the documented
`apk-key-hash` form and the spec should say which base64 flavour.

### Large payloads for native callers

androidx's Play-services controller puts
`EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER` (and `EXTRA_RP_PID`) into every
`getCredential` request from 1.7.0-alpha01 on, so a native RP gets the
out-of-band file-descriptor path without doing anything (Chrome had to add
it by hand). Verified: the wallet logged `receiverOffered=true
passedByReceiver=true` for the RP and returned a 1.45 M-char `credentialJson`
with a 216-byte result Intent. The ~500 KB Binder cliff from
[`10-android-response-size.md`](10-android-response-size.md) therefore
applies to native RPs only if they pin an older androidx.

## What a MyChart-class integration would carry

- Dependencies on `androidx.credentials` 1.5+ (experimental annotation; expect
  API churn until it stabilises) and Google Play services ≥ 24.31 on the
  device — no AOSP-only devices.
- The same request builder and response verifier the web SDK has, in Kotlin:
  CBOR, HPKE, MSO/COSE verification. The spike skips signature verification;
  a real RP would port `rp-web`'s verifier or call a server.
- Nothing else: no Custom Tabs, no redirect URIs, no app links, no server
  round trip for the response.

## Sources

- Verifier API and requirements: https://developer.android.com/identity/digital-credentials/credential-verifier ("The Verifier API is supported on Android 6 (API level 23) and higher").
- `GetDigitalCredentialOption` (`@ExperimentalDigitalCredentialApi`, 1.5.0-alpha05): https://android.googlesource.com/platform/frameworks/support/+/androidx-main/credentials/credentials/src/main/java/androidx/credentials/GetDigitalCredentialOption.kt ; routing to Play services in `CredentialProviderFactory.kt` (`if (option is … GetDigitalCredentialOption) return tryCreateClosedSourceProviderFromManifest()`), `MIN_GMS_APK_VERSION_DIGITAL_CRED = 243100000`.
- App-caller origin: https://developer.android.com/identity/digital-credentials/credential-holder ("If origin is empty, the verifier request is from an Android app… `android:apk-key-hash:<encoded SHA 256 fingerprint>`"); Multipaz `getAppOrigin` in `multipaz-dcapi/…/DigitalCredentialsExt.android.kt`; Google Wallet https://developers.google.com/wallet/identity/verify/accepting-ids-from-wallet-online.
- WebView: Chromium `content_browser_client.cc` default `CreateDigitalIdentityProvider() { return nullptr; }`, overridden only in `chrome/browser/chrome_content_browser_client.cc`; ChromeStatus 5166035265650688 lists `webview: None`.
- Custom Tabs run the user's browser engine with all web platform features: https://developer.chrome.com/docs/android/custom-tabs.
- Large payloads on the caller side: `credentials-play-services-auth/…/CredentialProviderGetDigitalCredentialController.kt` (`requestData.putParcelable(EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER, …)`), AOSP CL 3989977, androidx 1.7.0-alpha01 release notes.
- Google's native verifier sample: https://github.com/android/identity-samples/tree/main/DigitalCredentials.

## Reproducing

```sh
cd wallet-android
./gradlew :rp-app:assembleDebug && adb install -r rp-app/build/outputs/apk/debug/rp-app-debug.apk
python3 tools/payload-probe/rp_drive.py        # taps through picker + wallet, prints both sides' logs
```

The app's three buttons are the three rows of the table above.
