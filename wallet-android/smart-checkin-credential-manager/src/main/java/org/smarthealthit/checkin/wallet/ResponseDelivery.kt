package org.smarthealthit.checkin.wallet

import android.content.Intent
import android.os.ResultReceiver
import androidx.core.os.BundleCompat
import androidx.credentials.provider.ProviderGetCredentialRequest

/**
 * How the wallet's response will physically reach the caller, and what that
 * means for how much it can safely return.
 *
 * Android has two delivery modes for a Credential Manager provider response,
 * negotiated privately by the `androidx.credentials` library on both ends —
 * no Web, OpenID, or ISO spec describes either:
 *
 * - **Intent-extra ("legacy") mode.** The `DigitalCredential` bundle rides in
 *   the result `Intent` of the provider activity and is copied through Binder
 *   three times (wallet → system_server → GMS picker → Chrome). The oneway hop
 *   into the picker has a 512 KiB budget shared with everything else in flight
 *   to that process. Measured on a Pixel 11 Pro XL / Android 17: a result
 *   Intent parcel of 514 KB passes and 522 KB is dropped — *silently*: the
 *   picker stays open and the RP's `navigator.credentials.get()` never
 *   settles. Strings parcel as UTF-16 below 250,000 chars, so the safe budget
 *   is roughly 200,000 chars of `credentialJson`.
 *
 * - **Large-payload mode.** `androidx.credentials` ≥ 1.7.0-alpha01, when the
 *   wallet uses the three-argument
 *   [androidx.credentials.provider.PendingIntentHandler.setGetCredentialResponse]
 *   *and* the caller put a `ResultReceiver` in the request under
 *   [EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER] (Chrome does since 150): any bundle
 *   ≥ 200 KB is marshalled to an unlinked temp file and handed to the caller
 *   as a file descriptor; the Intent carries only a flag. Measured: no
 *   transport ceiling up to 66.7 M chars; the next limit is the wallet's own
 *   managed heap (≈ 20 MB of payload at the default 256 MB, ≈ 50 MB with
 *   `largeHeap`), which fails cleanly and the RP sees a rejected promise.
 *
 * The three-argument overload already falls back to Intent-extra mode by
 * itself when no receiver was offered, so a wallet needs nothing from this
 * class to be correct. It is here so a wallet can *know* which world a request
 * lives in before deciding what to share — e.g. offer narrower selections, or
 * return a pointer (a SMART Health Link) instead of bytes, when the plausible
 * response exceeds [ResponseDeliveryMode.budgetChars]. This sample app only
 * logs it. See `docs/research/10-android-response-size.md` in the spec repo.
 *
 * The extra keys are `@RestrictTo(LIBRARY)` in androidx, i.e. this reads a
 * de-facto handshake rather than a public API; they have been stable across
 * androidx 1.7.0-alpha01..alpha03 and Chrome pins the same strings.
 */
object ResponseDelivery {
    /** Present in an option's `requestData` when the caller accepts large responses out of band. */
    const val EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER =
        "androidx.credentials.provider.EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER"

    /** Set on the result Intent by androidx when the response actually went out of band. */
    const val EXTRA_PASS_IT_BY_RESULT_RECEIVER =
        "androidx.credentials.provider.EXTRA_PASS_IT_BY_RESULT_RECEIVER"

    /** Below this parcel size androidx keeps the response on the Intent even in large-payload mode. */
    const val LARGE_PAYLOAD_PIVOT_BYTES = 200 * 1024

    /** `credentialJson` length that stays safely under the Intent-extra path's ~500 KB parcel cliff. */
    const val LEGACY_BUDGET_CHARS = 200_000

    /**
     * Policy ceiling in large-payload mode. The transport has no known limit,
     * but the wallet and the caller each hold the whole JSON in memory several
     * times over; this sample's pipeline manages ~20 MB on a default heap.
     */
    const val LARGE_PAYLOAD_BUDGET_CHARS = 20_000_000

    data class ResponseDeliveryMode(
        /** The caller offered a large-payload `ResultReceiver`; androidx will use it for bundles ≥ 200 KB. */
        val callerAcceptsLargePayloads: Boolean,
        /** Wallet's managed-heap cap for this process, in MB (`Runtime.maxMemory()`). */
        val heapMaxMB: Long,
    ) {
        /** Rough maximum `credentialJson` length worth attempting in this mode. */
        val budgetChars: Int
            get() = if (callerAcceptsLargePayloads) LARGE_PAYLOAD_BUDGET_CHARS else LEGACY_BUDGET_CHARS

        val label: String
            get() = if (callerAcceptsLargePayloads) "large-payload" else "intent-extra (legacy, ~500 KB cliff)"
    }

    /** Inspect the request the provider activity was launched with. */
    fun describe(request: ProviderGetCredentialRequest?): ResponseDeliveryMode =
        ResponseDeliveryMode(
            callerAcceptsLargePayloads = callerAcceptsLargePayloads(request),
            heapMaxMB = Runtime.getRuntime().maxMemory() / (1024 * 1024),
        )

    fun callerAcceptsLargePayloads(request: ProviderGetCredentialRequest?): Boolean =
        request?.credentialOptions?.any { option ->
            BundleCompat.getParcelable(
                option.requestData,
                EXTRA_LARGE_PAYLOAD_RESULT_RECEIVER,
                ResultReceiver::class.java,
            ) != null
        } == true

    /** After `setGetCredentialResponse`: did androidx actually send this response out of band? */
    fun wentOutOfBand(resultIntent: Intent): Boolean = resultIntent.hasExtra(EXTRA_PASS_IT_BY_RESULT_RECEIVER)
}
