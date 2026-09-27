# Developer tools

This directory holds developer-only tooling that supports the checked-in
fixtures and Android/Web diagnostics, but is not part of the runtime app or
public static site.

| Path | Purpose |
| --- | --- |
| [`capture/`](capture/) | Browser and Android capture scripts for real Digital Credentials API runs. |
| [`fixtures-tool/`](fixtures-tool/) | Python pyMDOC-CBOR sidecar for fixture generation and byte-level validation. |
| [`conformance/`](conformance/) | `generate.ts`, which writes the conformance cases in `../conformance/` (never hand-edit them). |
| [`wire/`](wire/) | Tools that inspect requests and responses and generate request fixtures, using the client library's `/wire` module. |
