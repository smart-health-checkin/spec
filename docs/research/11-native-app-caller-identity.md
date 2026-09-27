# Can a wallet tell the patient which native app is asking?

Internal design note, 2026-09-27. Not part of the spec and not a decision. Web
callers are the focus; Josh hasn't committed to either design below.

## The problem

When a native Android app calls `CredentialManager.getCredential` directly, the
wallet gets no web origin. The transcript uses `android:apk-key-hash:<base64url
SHA-256 of the signing cert>` ([TR-2]), which binds the response to the app but
means nothing to a patient. The package name and app label are the app's own
choice, so a wallet can't honestly show them as "who is asking". Today the
reference wallet says "An app is asking for your health information" and shows
the package name and origin only under Technical details.

## History

The reference Android wallet briefly shipped a manifest-based design in
**v0.4.6** (2026-09-27): it read the caller's `asset_statements` meta-data
through `PackageManager`, fetched each declared site's
`/.well-known/assetlinks.json`, and said "An app linked to example.org is
asking" when both directions matched. It needed `QUERY_ALL_PACKAGES`. It was
withdrawn in **v0.4.7** the same day, along with the Platform notes section
(`#app-callers`) and the client guide sections that described it, and the
example verifier-app's `asset_statements` declaration.

## What the wallet gets from Credential Manager

`androidx.credentials.provider.CallingAppInfo` exposes only `packageName`,
`signingInfo` / `signingInfoCompat`, `getOrigin(privilegedAllowlist)` (non-null
only for an allowlisted privileged caller such as a browser) and
`isOriginPopulated()`
([reference](https://developer.android.com/reference/kotlin/androidx/credentials/provider/CallingAppInfo)).
The framework `android.service.credentials.CallingAppInfo` has the same three
things ([reference](https://developer.android.com/reference/android/service/credentials/CallingAppInfo)).
Nothing gives the caller's meta-data, resources, manifest, or label.

## Package visibility: measured

Emulator `ktc_api37`: Android 17 (API 37,
`google/sdk_gphone64_x86_64/emu64xa:17/CE2A.260420.019`), Play services
26.34.36. Wallet targetSdk 35, androidx.credentials 1.7.0-alpha03. Caller:
`org.smarthealthit.checkin.verifier` via the direct `GetDigitalCredentialOption`
path. A throwaway probe in `HandlerActivity` (the `GET_CREDENTIAL` handler)
called PackageManager with the package name from `CallingAppInfo`; `pm
log-visibility --enable` was on for the wallet.

| Call | `QUERY_ALL_PACKAGES` | Neither | `<queries><package …verifier/>` only |
|---|---|---|---|
| `getApplicationInfo(pkg, GET_META_DATA)` | ok, meta-data has `asset_statements` | `NameNotFoundException: org.smarthealthit.checkin.verifier` | ok |
| `getPackageInfo(pkg, GET_META_DATA)` | ok | `NameNotFoundException` | ok |
| `getResourcesForApplication(pkg)`, `getApplicationLabel`, `getInstallSourceInfo`, `getPackageUid` | ok | `NameNotFoundException` | ok |
| `createPackageContext(pkg, 0)` | ok | `NameNotFoundException: Application package … not found` | ok |
| `canPackageQuery(self, pkg)` | `true` | `NameNotFoundException: Package(s) org.smarthealthit.checkin.wallet and/or [org.smarthealthit.checkin.verifier] not found.` | `true` |

With neither, system_server logged
`AppsFilter: interaction: PackageSetting{… org.smarthealthit.checkin.wallet/10248} -> PackageSetting{… org.smarthealthit.checkin.verifier/10246} BLOCKED`.
The check-in itself succeeded in all three builds; only the lookups failed.

Why the caller isn't visible: the wallet's activity is not started by the
caller. In every run `Activity.launchedFromPackage`, `callingPackage` and
`referrer` were `com.google.android.gms`, and `callingActivity` was
`com.google.android.gms/…identitycredentials.ui.CredentialSelectorActivity`. The
automatic-visibility rules cover an app that starts your activity with
`startActivityForResult`, binds your service, or uses your content provider
([Package visibility: automatic](https://developer.android.com/training/package-visibility/automatic));
here Play services does all of that, so it is Play services, not the caller,
that becomes visible. None of the package-visibility pages
([overview](https://developer.android.com/training/package-visibility),
[declaring](https://developer.android.com/training/package-visibility/declaring),
[use cases](https://developer.android.com/training/package-visibility/use-cases),
[testing](https://developer.android.com/training/package-visibility/testing))
or the provider guides
([credential provider](https://developer.android.com/identity/sign-in/credential-provider),
[credential holder](https://developer.android.com/identity/digital-credentials/credential-holder/credential-holder))
mention Credential Manager callers or `<queries>`. The overview says visibility
filtering affects `getPackageInfo()` and similar methods; that a hidden package
throws `NameNotFoundException` is only implied by the
[PackageManager reference](https://developer.android.com/reference/android/content/pm/PackageManager),
and measured above.

So: without `QUERY_ALL_PACKAGES`, a wallet can read a caller's manifest only if
it lists that package in `<queries>` in advance, which can't cover unknown
callers. The declaring page lists browsers, security, device-management and
accessibility apps as fitting cases for `QUERY_ALL_PACKAGES`, not credential
providers.

## Google Play policy

[Use of the broad package (App) visibility (QUERY_ALL_PACKAGES) permission](https://support.google.com/googleplay/android-developer/answer/10158779):
allowed only when the app's "core user-facing functionality or purpose requires
broad visibility into installed apps". The listed uses are device search,
antivirus, file managers and browsers. A temporary exception covers "dedicated
digital wallets" for regulated financial instruments, "solely for
security-based purposes". It's invalid "when the required task can be done with
a less broad app-visibility method", and it needs a Permissions Declaration
Form. A health-record or identity wallet isn't named, and reading a caller's
manifest would be hard to justify under that test.

## Candidate designs

1. **Read the caller's manifest** (what v0.4.6 did). The app declares its site
   in `asset_statements`, and the wallet checks the site's `assetlinks.json`
   lists the package and cert. Needs `QUERY_ALL_PACKAGES` (above), which Play is
   unlikely to allow, or a `<queries>` list of known callers.
2. **The caller names its website in the request, and the wallet checks Digital
   Asset Links**, as passkey providers do with the rpId. The provider already
   has the package and cert from `CallingAppInfo`; it fetches
   `https://<claimed site>/.well-known/assetlinks.json` and checks for that
   package and fingerprint. No manifest read, so no visibility problem. The
   passkey guide only says "Check the asset-link for the calling app if the call
   originates from a native Android app"
   ([credential provider](https://developer.android.com/identity/sign-in/credential-provider));
   the RP side publishes `assetlinks.json` with `get_login_creds` /
   `handle_all_urls` ([prerequisites](https://developer.android.com/identity/credential-manager/prerequisites),
   [relation strings](https://developers.google.com/digital-asset-links/v1/relation-strings)).
   For us this would need a request field for the claimed site (the request has
   none today, and [ID-2] says request content isn't evidence of who is asking,
   so the field would count only after the check passes). The holder guide doesn't
   ask wallets to verify native callers at all; it just uses the
   `android:apk-key-hash:` origin
   ([credential holder](https://developer.android.com/identity/digital-credentials/credential-holder/credential-holder)).

[TR-2]: https://smart-health-checkin.org/spec/#TR-2
[ID-2]: https://smart-health-checkin.org/spec/#ID-2
