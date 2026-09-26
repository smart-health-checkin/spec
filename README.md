# SMART Health Check-in: specification

The SMART Health Check-in 1.0 draft specification and its conformance fixtures.

SMART Health Check-in is two layers: a transport-neutral request/response model for what a visit needs, and a same-device presentation flow over the W3C Digital Credentials API with `org-iso-mdoc`. QR codes, kiosks, and relays built around that flow are deployment choices, not part of the protocol.

- **Spec:** <https://smart-health-checkin.org/spec/>
- **Client library** (EHR pages, web wallets, testing): [smart-health-checkin/client](https://github.com/smart-health-checkin/client), docs at <https://smart-health-checkin.org/client/>
- **Reference Android wallet:** [smart-health-checkin/android-wallet](https://github.com/smart-health-checkin/android-wallet) ([latest APK](https://github.com/smart-health-checkin/android-wallet/releases/latest/download/smart-checkin-wallet-debug.apk)). It moved out of this repo with its history; releases up to wallet-v0.3.2 remain here.
- **Connectathon:** [smart-health-checkin/connectathon](https://github.com/smart-health-checkin/connectathon), at <https://smart-health-checkin.org/connectathon/>

## What's here

| Path | What it is |
| --- | --- |
| [`spec.md`](spec.md) | The draft spec. §§5–6 define the request and response model; §8 the `org-iso-mdoc` flow; Appendix A a byte-level bridge. |
| [`site/`](site/) | Explainers published with the spec: the model, the wire protocol, a byte-level inspector, the kiosk flow. |
| [`fixtures/`](fixtures/) | Checked-in byte captures and generated request fixtures. The Android wallet and the client library test against copies of them. |
| [`tools/wire/`](tools/wire/) | Developer tools that inspect requests and responses and generate request fixtures, using the client library's `/wire` module. |
| [`tools/fixtures-tool/`](tools/fixtures-tool/) | Python fixture checks with pyMDOC. |
| [`tools/capture/`](tools/capture/README.md) | Browser capture and probing scripts. |
| [`examples/swift-ios/`](examples/swift-ios/) | A Swift package exploring the iOS side. |
| [`docs/`](docs/) | Research notes and archived planning. Historical, not part of the spec. |

The TypeScript verifier and web-wallet code that used to live in `rp-web/` is now the [client library](https://github.com/smart-health-checkin/client); its demos run at <https://smart-health-checkin.org/client/demo/>.

## Build the site

```sh
bun install
scripts/build-pages.sh      # builds _site/
scripts/serve-pages.sh      # builds and serves http://localhost:3015/
```

Pushes to `main` deploy to <https://smart-health-checkin.org/spec/> through [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml).

| Path | Page |
| --- | --- |
| `./` and `./spec.html` | The draft spec, rendered |
| `./spec.md` | The draft spec, raw Markdown |
| `./smart-model-explainer.html` | The request and response model |
| `./wire-protocol-explainer.html` | The wire protocol, byte by byte |
| `./wire-protocol-inspector.html` | Inspect the checked-in captures |
| `./kiosk-flow-explainer.html` | The kiosk hand-off flow |
| `./llms.txt` | The spec and explainers in one file |
| `./fixtures/` | The fixtures |

## Tests and fixtures

```sh
vendor/scripts/regenerate-local-fixtures.sh    # regenerate fixtures and run the Python checks
scripts/pull-android-handler-run.sh            # pull and inspect a wallet run from a connected Android device
```

The Android wallet's test vectors are generated from the client library's wire module, in the android-wallet repo, so the Kotlin wallet and the TypeScript library are checked against the same bytes.
