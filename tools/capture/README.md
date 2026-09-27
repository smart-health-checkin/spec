# Capture Tools

These tools are for checking what a verifier page actually passes to the
Digital Credentials API.

## The Chrome/Android capture

[`android-chrome/capture.ts`](android-chrome/capture.ts) re-captures
`fixtures/dcapi-requests/android-chrome-capture` and
`fixtures/responses/android-chrome-capture`, the capture that spec Appendix A,
the capture inspector, and the `capture` conformance cases use:

```sh
bun tools/capture/android-chrome/capture.ts --serial emulator-5554
bun scripts/worked-example.ts        # Appendix A
bun tools/conformance/generate.ts    # then keep only the */capture* cases' changes
```

It serves a Verifier page on the host at `http://127.0.0.1:3010` (through `adb
reverse`) that builds `android-chrome/smart-request.json` into a request with
the client library in `package.json`, and records the request's parts and its
HPKE private key. The page asks the installed reference wallet through the
Digital Credentials API; the script taps through Chrome and the wallet with
uiautomator. It then pulls the wallet's record of the run
(`scripts/pull-android-handler-run.sh`) and rebuilds both fixture folders with
the same file names (`android-chrome/assemble.sh`), after checking that the
page and the wallet saw the same request, transcript, and response. It needs
adb, a device with Chrome and Play services new enough for the Digital
Credentials API (the android-37 `google_apis_playstore` image works), the
wallet installed and opened once, and `uv` for the pyMDOC check.

## Android end to end

The old `capture-android-rp-flow.mjs` drove the retired `rp-web` app. To run a check-in from a web page to the Android wallet now, use the connectathon's [`scripts/android-e2e.ts`](https://github.com/smart-health-checkin/connectathon/blob/main/scripts/android-e2e.ts): it drives the live Testing EHR in the device's Chrome, through the Digital Credentials API, to the reference wallet. For the wallet's own record of a run, `scripts/pull-android-handler-run.sh` in this repo still pulls and inspects it.

## Browser Branching Probe

`probe-browser-branching.mjs` launches Chromium with CDP, installs a pre-page-load
hook around `navigator.credentials.get`, and writes a capture bundle.

Useful runs:

```sh
node tools/capture/probe-browser-branching.mjs --profile chrome --mode stub
node tools/capture/probe-browser-branching.mjs --profile safari-macos --mode stub
node tools/capture/probe-browser-branching.mjs --profile safari-ios --mode stub
```

By default the script opens `https://tools.mattrlabs.com/verify-credentials`.
Click the verifier button in the opened browser. Output goes under:

```text
tools/capture/browser-branching/<timestamp>-<profile>-<mode>/
```

Key files:

```text
run.json
probe-events.json
console.raw.log
navigator-credentials-get.arg.json
notes.md
```

Modes:

- `stub`: replace the credential API with a capture stub. This avoids launching
  a real wallet and works for observing request construction.
- `wrap`: wrap and forward to the real browser API. Use this when the local
  browser/platform can actually launch Credential Manager.

Safari profiles here are still Chromium with Safari-like user-agent and device
settings. They can reveal site-side user-agent branching, but they do not prove
actual WebKit behavior.

## Real Safari Capture

For actual Safari/WebKit behavior, use `manual-safari-hook.js` on a Mac or iOS
device with Web Inspector:

1. Open the verifier page in Safari.
2. Open Web Inspector.
3. Paste the contents of `manual-safari-hook.js` into the console.
4. Click the verifier button.
5. Copy the `@@DC-SAFARI-CAPTURE@@credentials.get@@...` console payload into a
   fixture folder.

If you only want the request argument and do not want Safari to launch a wallet,
edit `FORWARD_TO_BROWSER` to `false` before pasting.
