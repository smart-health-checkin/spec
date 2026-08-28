package org.smarthealthit.checkin.rp

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.browser.customtabs.CustomTabsIntent
import androidx.credentials.CredentialManager
import androidx.credentials.DigitalCredential
import androidx.credentials.ExperimentalDigitalCredentialApi
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetDigitalCredentialOption
import androidx.credentials.exceptions.GetCredentialException
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.smarthealthit.checkin.wallet.DirectMdocRequestParser
import org.smarthealthit.checkin.wallet.MdocCbor
import org.smarthealthit.checkin.wallet.SmartMdocBase64
import org.smarthealthit.checkin.wallet.SmartMdocCrypto
import java.security.MessageDigest

/**
 * Spike: can a native Android app be the relying party for a SMART Health
 * Check-in over the Digital Credentials API, with no browser in the loop?
 *
 * Three buttons, three answers:
 *  1. direct — `CredentialManager.getCredential(GetDigitalCredentialOption)`;
 *     Play services shows the same picker Chrome gets, the wallet answers, and
 *     this app decrypts the response itself.
 *  2. WebView — loads the web demo in a WebView and reports whether
 *     `navigator.credentials.get` / `DigitalCredential` exist there.
 *  3. Custom Tab — hands the web demo to Chrome; works, but the response lands
 *     in the web page, not in this app.
 */
@OptIn(ExperimentalDigitalCredentialApi::class)
class RpMainActivity : ComponentActivity() {
    companion object {
        const val TAG = "SHCRp"
        const val DEMO_URL = "https://smart-health-checkin.org/client/demo/#wallet=platform"
    }

    private lateinit var output: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 220, 32, 32)
        }
        fun button(label: String, onClick: () -> Unit) {
            root.addView(Button(this).apply { text = label; setOnClickListener { onClick() } })
        }
        button("Request check-in via CredentialManager (direct)") { requestDirect() }
        button("Open demo page in WebView") { startActivity(Intent(this, WebViewProbeActivity::class.java)) }
        button("Open demo page in Custom Tab") {
            CustomTabsIntent.Builder().build().launchUrl(this, Uri.parse(DEMO_URL))
        }
        output = TextView(this).apply {
            setTextIsSelectable(true)
            typeface = Typeface.MONOSPACE
            textSize = 11f
        }
        root.addView(ScrollView(this).apply { addView(output) }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        show(
            "package: $packageName\n" +
                "candidate origins the wallet might bind the SessionTranscript to:\n" +
                candidateOrigins().joinToString("\n") { "  $it" },
        )
    }

    private fun show(text: String) {
        output.text = text
        Log.i(TAG, text.replace('\n', ' ').take(400))
    }

    private fun requestDirect() {
        val smartRequestJson = assets.open("smart-request.json").bufferedReader().readText()
        val built = OrgIsoMdocRequestBuilder.build(smartRequestJson)
        val request = GetCredentialRequest(listOf(GetDigitalCredentialOption(built.requestJson)))
        show("requesting… requestJson=${built.requestJson.length} chars")
        val t0 = SystemClock.elapsedRealtime()
        lifecycleScope.launch {
            try {
                val response = CredentialManager.create(this@RpMainActivity)
                    .getCredential(this@RpMainActivity, request)
                val ms = SystemClock.elapsedRealtime() - t0
                val credential = response.credential
                if (credential is DigitalCredential) {
                    handleResponse(credential.credentialJson, built, ms)
                } else {
                    show("FAILED: unexpected credential type ${credential.type}")
                }
            } catch (e: GetCredentialException) {
                val ms = SystemClock.elapsedRealtime() - t0
                show("FAILED after ${ms} ms: ${e::class.java.simpleName} type=${e.type} message=${e.message}")
                Log.w(TAG, "getCredential failed", e)
            } catch (t: Throwable) {
                show("FAILED: $t")
                Log.e(TAG, "getCredential threw", t)
            }
        }
    }

    private fun handleResponse(credentialJson: String, built: OrgIsoMdocRequestBuilder.BuiltRequest, ms: Long) {
        val json = JSONObject(credentialJson)
        val protocol = json.optString("protocol")
        val responseB64u = json.getJSONObject("data").getString("response")
        val dcapi = MdocCbor.decode(SmartMdocBase64.decodeUrl(responseB64u)) as List<*>
        val fields = dcapi[1] as Map<*, *>
        val enc = fields["enc"] as ByteArray
        val cipherText = fields["cipherText"] as ByteArray

        // The wallet binds the HPKE info to a SessionTranscript built from the
        // origin it derived for us; we don't know which convention it used, so
        // try each — AES-GCM fails authentication on the wrong one.
        var opened: ByteArray? = null
        var usedOrigin: String? = null
        for (origin in candidateOrigins()) {
            val transcript = DirectMdocRequestParser.buildSessionTranscript(built.encryptionInfoB64u, origin)
            try {
                opened = SmartMdocCrypto.hpkeOpen(enc, cipherText, built.recipientKeyPair, transcript)
                usedOrigin = origin
                break
            } catch (_: Exception) {
            }
        }
        if (opened == null) {
            show("response received in ${ms} ms (protocol=$protocol, ${credentialJson.length} chars) but HPKE open failed for every candidate origin")
            return
        }
        val deviceResponse = MdocCbor.decode(opened) as Map<*, *>
        val document = (deviceResponse["documents"] as List<*>)[0] as Map<*, *>
        val issuerNamespaces = (document["issuerSigned"] as Map<*, *>)["nameSpaces"] as Map<*, *>
        val items = issuerNamespaces[OrgIsoMdocRequestBuilder.NAMESPACE] as List<*>
        val item = MdocCbor.decodeTag24(items[0]) as Map<*, *>
        val smartResponse = item["elementValue"] as String
        val pretty = runCatching { JSONObject(smartResponse).toString(2) }.getOrDefault(smartResponse)
        show(
            "OK in ${ms} ms\n" +
                "protocol=$protocol credentialJson=${credentialJson.length} chars\n" +
                "SessionTranscript origin that decrypted: $usedOrigin\n" +
                "docType=${document["docType"]} smartResponse=${smartResponse.length} chars\n\n" +
                pretty.take(4000),
        )
        Log.i(TAG, "RESULT ok=true ms=$ms credentialJsonChars=${credentialJson.length} origin=$usedOrigin smartResponseChars=${smartResponse.length}")
    }

    /** The conventions in circulation for "origin" of an app-invoked request. */
    private fun candidateOrigins(): List<String> {
        val cert = packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            .signingInfo!!.apkContentsSigners[0].toByteArray()
        val digest = MessageDigest.getInstance("SHA-256").digest(cert)
        val b64url = Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val b64 = Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
        return listOf(
            "android:apk-key-hash:$b64url",   // Android holder docs / Multipaz / Google Wallet (base64url)
            "android:apk-key-hash:$b64",      // Android holder docs snippet (standard base64)
            "android-app:$packageName",       // this repo's wallet fallback today
        )
    }
}
