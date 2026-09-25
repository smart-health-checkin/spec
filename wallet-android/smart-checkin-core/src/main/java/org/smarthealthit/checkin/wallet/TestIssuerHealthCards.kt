package org.smarthealthit.checkin.wallet

import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPrivateKeySpec
import java.util.Base64
import java.util.zip.Deflater
import org.json.JSONArray
import org.json.JSONObject

/**
 * Mints SMART Health Cards (https://spec.smarthealth.cards/) with the connectathon
 * test issuer, the same issuer the SMART Testing Wallet on the web uses. Its
 * public key is published at [ISSUER]/.well-known/jwks.json.
 *
 * The private key is public on purpose: this issuer exists only for testing,
 * and anyone may mint cards with it. Never trust it for real data.
 */
object TestIssuerHealthCards {
    const val ISSUER = "https://smart-health-checkin.org/connectathon/testing-wallet/issuer"
    private const val KID = "T8so9DbszgV8Y5E1_KcYtN8mScyJYAcINo_QTKT8M0g"
    private const val D = "kbu08zkcUbtePuzYXnDzW8x2SdRZiQS9iuaG7IRX0Wo"

    /** A compact JWS for the given resources, with resource:N references. */
    fun mint(resources: List<JSONObject>, nowSeconds: Long = System.currentTimeMillis() / 1000): String {
        val header = JSONObject().put("zip", "DEF").put("alg", "ES256").put("kid", KID)
        val payload = JSONObject()
            .put("iss", ISSUER)
            .put("nbf", nowSeconds)
            .put(
                "vc",
                JSONObject()
                    .put("type", JSONArray().put("https://smarthealth.cards#health-card"))
                    .put(
                        "credentialSubject",
                        JSONObject().put("fhirVersion", "4.0.1").put("fhirBundle", shcBundle(resources)),
                    ),
            )
        val signingInput = b64url(header.toString().toByteArray()) + "." + b64url(deflateRaw(payload.toString().toByteArray()))
        return signingInput + "." + b64url(sign(signingInput.toByteArray()))
    }

    /** Bundle with resource:N fullUrls and references; ids, meta, and text dropped to keep cards small. */
    fun shcBundle(resources: List<JSONObject>): JSONObject {
        val index = HashMap<String, String>()
        resources.forEachIndexed { i, r ->
            val id = r.optString("id")
            if (id.isNotBlank()) {
                index["urn:uuid:$id"] = "resource:$i"
                index["${r.optString("resourceType")}/$id"] = "resource:$i"
            }
        }
        val entries = JSONArray()
        resources.forEachIndexed { i, r ->
            entries.put(JSONObject().put("fullUrl", "resource:$i").put("resource", rewrite(r, index)))
        }
        return JSONObject().put("resourceType", "Bundle").put("type", "collection").put("entry", entries)
    }

    private fun rewrite(value: Any?, index: Map<String, String>): Any? = when (value) {
        is JSONObject -> JSONObject().also { out ->
            value.keys().forEach { key ->
                if (key == "id" || key == "meta" || key == "text") return@forEach
                val v = value.opt(key)
                out.put(key, if (key == "reference" && v is String) index[v] ?: v else rewrite(v, index))
            }
        }
        is JSONArray -> JSONArray().also { out -> for (i in 0 until value.length()) out.put(rewrite(value.opt(i), index)) }
        else -> value
    }

    private fun deflateRaw(bytes: ByteArray): ByteArray {
        val deflater = Deflater(Deflater.BEST_COMPRESSION, true)
        deflater.setInput(bytes)
        deflater.finish()
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (!deflater.finished()) out.write(buffer, 0, deflater.deflate(buffer))
        deflater.end()
        return out.toByteArray()
    }

    private fun sign(input: ByteArray): ByteArray {
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
        val spec = params.getParameterSpec(ECParameterSpec::class.java)
        val key = KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, Base64.getUrlDecoder().decode(D)), spec))
        val der = Signature.getInstance("SHA256withECDSA").apply { initSign(key); update(input) }.sign()
        return derToRaw(der)
    }

    /** ASN.1 DER ECDSA signature to the 64-byte r||s form JWS uses. */
    private fun derToRaw(der: ByteArray): ByteArray {
        var i = 2
        if (der[1].toInt() and 0x80 != 0) i += der[1].toInt() and 0x7f
        fun readInt(): ByteArray {
            require(der[i].toInt() == 0x02) { "bad DER signature" }
            val len = der[i + 1].toInt()
            val bytes = der.copyOfRange(i + 2, i + 2 + len)
            i += 2 + len
            return bytes.dropWhile { it.toInt() == 0 }.toByteArray()
        }
        val r = readInt()
        val s = readInt()
        val out = ByteArray(64)
        System.arraycopy(r, 0, out, 32 - r.size, r.size)
        System.arraycopy(s, 0, out, 64 - s.size, s.size)
        return out
    }

    private fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}
