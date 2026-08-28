# rp-app — native Android relying party (spike)

Answers "can a native app request a SMART Health Check-in from the wallet
without a browser?" — yes. Findings and sources:
[`../../docs/research/11-native-rp-android.md`](../../docs/research/11-native-rp-android.md).

Three buttons:

| Button | What it shows |
| --- | --- |
| Request check-in via CredentialManager (direct) | `CredentialManager.getCredential(GetDigitalCredentialOption(requestJson))` → Play services picker → wallet → response decrypted here and printed. ~8 s, two taps. |
| Open demo page in WebView | the web demo inside a WebView: `DigitalCredential` is absent, the page says so. |
| Open demo page in Custom Tab | the web demo in Chrome: works, but the response stays in the page. |

Pieces:

- `OrgIsoMdocRequestBuilder` — the `org-iso-mdoc` request (DeviceRequest with
  the SMART request in `requestInfo`, `encryptionInfo` with a fresh P-256
  recipient key), same wire shape `rp-web` builds. Fixture SMART request in
  `src/main/assets/smart-request.json`.
- `RpMainActivity` — the call, then HPKE-open with
  `SmartMdocCrypto.hpkeOpen` using a SessionTranscript built for each
  app-origin convention in circulation (`android:apk-key-hash:` base64url /
  base64, `android-app:<package>`) and reports which one the wallet used.
  No MSO/COSE verification (spike).
- `WebViewProbeActivity` — feature probe + console capture for the WebView row.

```sh
./gradlew :rp-app:assembleDebug
adb install -r rp-app/build/outputs/apk/debug/rp-app-debug.apk
python3 tools/payload-probe/rp_drive.py     # drives the direct flow hands-free, prints both sides' logs
```

Needs `androidx.credentials:credentials-play-services-auth` (the verifier call
is always routed to Play services) and a device with Play services ≥ 24.31.
