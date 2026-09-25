package org.smarthealthit.checkin.wallet

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStream
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets

/**
 * Resolves forms requested by reference (spec §5.4.2). A `form.fhir` item with
 * `questionnaireCanonical` and no inline `questionnaire` gets the fetched
 * Questionnaire put inline. An unversioned canonical is fetched directly; for
 * `url|version`, the base URL is fetched and used only if its `version`
 * matches. A form that can't be loaded is left out, so that item is answered
 * `unsupported` and the rest of the request still goes ahead.
 */
internal object SmartQuestionnaireFetcher {
    suspend fun hydrateQuestionnaireUrls(smartRequest: JSONObject): JSONObject = withContext(Dispatchers.IO) {
        val copy = JSONObject(smartRequest.toString())
        val items = copy.optJSONArray("items") ?: return@withContext copy

        for (i in 0 until items.length()) {
            val content = items.optJSONObject(i)?.optJSONObject("content") ?: continue
            if (content.optString("kind") != "form.fhir") continue
            if (content.optJSONObject("questionnaire") != null) continue
            val canonical = content.optString("questionnaireCanonical").ifBlank { null } ?: continue
            runCatching { fetchMatching(canonical) }
                .onSuccess { content.put("questionnaire", it) }
                .onFailure { android.util.Log.w("SHCQuestionnaire", "could not load $canonical: ${it.message}") }
        }

        copy
    }

    internal fun fetchMatching(canonical: String): JSONObject {
        val questionnaire = fetchQuestionnaire(canonical)
        require(questionnaire.optString("resourceType") == "Questionnaire") { "$canonical did not return a Questionnaire" }
        val url = canonical.substringBefore('|')
        require(questionnaire.optString("url") == url) { "$canonical returned a Questionnaire with url ${questionnaire.optString("url")}" }
        val version = canonical.substringAfter('|', "")
        require(version.isEmpty() || questionnaire.optString("version") == version) {
            "$canonical returned version ${questionnaire.optString("version")}"
        }
        return questionnaire
    }

    internal fun canonicalUrlForFetch(canonical: String): String {
        val rawUrl = canonical.substringBefore('|')
        require(rawUrl.isNotBlank()) { "Questionnaire canonical URL is blank" }
        return rawUrl
    }

    private fun fetchQuestionnaire(rawUrl: String): JSONObject {
        val fetchUrl = canonicalUrlForFetch(rawUrl)
        val url = URL(fetchUrl)
        require(url.protocol == "https" || url.protocol == "http") {
            "Unsupported questionnaireUrl scheme: ${url.protocol}"
        }
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 10_000
        connection.readTimeout = 15_000
        connection.setRequestProperty("Accept", "application/fhir+json, application/json")

        val status = connection.responseCode
        val body = readStream(if (status in 200..299) connection.inputStream else connection.errorStream)
        if (status !in 200..299) {
            error("HTTP $status fetching questionnaireUrl $rawUrl: $body")
        }
        return JSONObject(body)
    }

    private fun readStream(input: InputStream?): String {
        if (input == null) return ""
        val builder = StringBuilder()
        BufferedReader(InputStreamReader(input, StandardCharsets.UTF_8)).use { reader ->
            var line = reader.readLine()
            while (line != null) {
                builder.append(line)
                line = reader.readLine()
            }
        }
        return builder.toString()
    }
}
