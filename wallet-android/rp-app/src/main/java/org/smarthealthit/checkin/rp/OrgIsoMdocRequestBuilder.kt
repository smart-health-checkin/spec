package org.smarthealthit.checkin.rp

import org.json.JSONArray
import org.json.JSONObject
import org.smarthealthit.checkin.wallet.MdocCbor
import org.smarthealthit.checkin.wallet.SmartMdocBase64
import org.smarthealthit.checkin.wallet.SmartMdocCrypto
import java.security.KeyPair
import java.security.SecureRandom

/**
 * Builds the `org-iso-mdoc` Digital Credentials request for a SMART Health
 * Check-in request, the way the client library's `buildOrgIsoMdocRequest` (`@smart-health-checkin/client/wire`)
 * does: the SMART JSON rides in `ItemsRequest.requestInfo`, the response is
 * requested as the `smart_health_checkin_response` element, and
 * `encryptionInfo` carries a fresh P-256 HPKE recipient key plus a nonce.
 * No readerAuth in this spike (the wallet treats it as optional).
 */
object OrgIsoMdocRequestBuilder {
    const val PROTOCOL = "org-iso-mdoc"
    const val DOC_TYPE = "org.smarthealthit.checkin.1"
    const val NAMESPACE = "org.smarthealthit.checkin"
    const val ELEMENT = "smart_health_checkin_response"
    const val REQUEST_INFO_KEY = "org.smarthealthit.checkin.request"

    class BuiltRequest(
        /** What goes into `GetDigitalCredentialOption(requestJson)` — the DC API `{"requests":[...]}` shape. */
        val requestJson: String,
        val recipientKeyPair: KeyPair,
        val nonce: ByteArray,
        val encryptionInfoB64u: String,
        val deviceRequestB64u: String,
    )

    fun build(smartRequestJson: String, random: SecureRandom = SecureRandom()): BuiltRequest {
        val recipient = SmartMdocCrypto.generateP256KeyPair(random)
        val nonce = ByteArray(32).also(random::nextBytes)
        val encryptionInfo = MdocCbor.encode(
            listOf(
                "dcapi",
                linkedMapOf<Any, Any>(
                    "nonce" to nonce,
                    "recipientPublicKey" to SmartMdocCrypto.coseEc2PublicKey(recipient.public),
                ),
            ),
        )
        val itemsRequest = linkedMapOf<Any, Any>(
            "docType" to DOC_TYPE,
            "nameSpaces" to linkedMapOf<Any, Any>(NAMESPACE to linkedMapOf<Any, Any>(ELEMENT to true)),
            "requestInfo" to linkedMapOf<Any, Any>(REQUEST_INFO_KEY to smartRequestJson),
        )
        val deviceRequest = MdocCbor.encode(
            linkedMapOf<Any, Any>(
                "version" to "1.0",
                "docRequests" to listOf(
                    linkedMapOf<Any, Any>(
                        "itemsRequest" to MdocCbor.CborTag(MdocCbor.TAG_ENCODED_CBOR, MdocCbor.encode(itemsRequest)),
                    ),
                ),
            ),
        )
        val encryptionInfoB64u = SmartMdocBase64.encodeUrl(encryptionInfo)
        val deviceRequestB64u = SmartMdocBase64.encodeUrl(deviceRequest)
        val requestJson = JSONObject()
            .put(
                "requests",
                JSONArray().put(
                    JSONObject()
                        .put("protocol", PROTOCOL)
                        .put(
                            "data",
                            JSONObject()
                                .put("deviceRequest", deviceRequestB64u)
                                .put("encryptionInfo", encryptionInfoB64u),
                        ),
                ),
            )
            .toString()
        return BuiltRequest(requestJson, recipient, nonce, encryptionInfoB64u, deviceRequestB64u)
    }
}
