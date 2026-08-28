package org.smarthealthit.checkin.wallet

import android.content.Context
import android.content.Intent
import android.os.Parcel
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Test-only hook for sweeping the size of the DigitalCredential response the
 * wallet hands back through Credential Manager. Driven from the host by
 * `tools/payload-probe/probe.py`.
 *
 * If `files/payload-pad-bytes` exists (debug builds: `adb shell run-as
 * org.smarthealthit.checkin.wallet sh -c 'echo N > files/payload-pad-bytes'`),
 * N filler characters are added to the SMART response *before* it is sealed
 * into the mdoc, so the padding travels exactly the way real clinical data
 * would (CBOR → HPKE → base64url → JSON string → Intent extra → Binder).
 * Absent or 0 = no effect.
 */
object PayloadProbe {
    const val TAG = "SHCPayloadProbe"
    private const val FILE = "payload-pad-bytes"
    private const val LEGACY_FILE = "payload-legacy"

    /**
     * `files/payload-legacy` present: return the response through the deprecated
     * two-argument `setGetCredentialResponse`, i.e. always as an Intent extra
     * through Binder, never via the large-payload ResultReceiver.
     */
    fun forceLegacyPath(context: Context): Boolean = File(context.filesDir, LEGACY_FILE).exists()

    fun padBytes(context: Context): Int =
        runCatching { File(context.filesDir, FILE).readText().trim().toInt() }.getOrDefault(0)

    /** Returns the pad size applied (0 when the knob is unset). */
    fun applyPadding(context: Context, smartResponse: JSONObject): Int {
        val n = padBytes(context)
        if (n > 0) {
            // Binder does not compress, so the content is irrelevant; letters
            // only so the JSON string needs no escaping and length == bytes.
            smartResponse.put("_payloadProbePadding", buildString(n) { repeat(n) { append('a' + (it % 26)) } })
        }
        return n
    }

    fun logSizes(
        pad: Int,
        path: String,
        receiverOffered: Boolean,
        passedByReceiver: Boolean,
        credentialJson: String,
        resultData: Intent,
    ) {
        val parcel = Parcel.obtain()
        val parcelBytes = try {
            resultData.writeToParcel(parcel, 0)
            parcel.dataSize()
        } finally {
            parcel.recycle()
        }
        Log.i(
            TAG,
            "pad=$pad path=$path receiverOffered=$receiverOffered passedByReceiver=$passedByReceiver " +
                "credentialJsonChars=${credentialJson.length} resultIntentParcelBytes=$parcelBytes " +
                "heapMaxMB=${Runtime.getRuntime().maxMemory() / 1048576}",
        )
    }

    fun logFinishFailure(pad: Int, t: Throwable) {
        Log.e(TAG, "pad=$pad finish() threw ${t::class.java.name}: ${t.message}", t)
    }
}
