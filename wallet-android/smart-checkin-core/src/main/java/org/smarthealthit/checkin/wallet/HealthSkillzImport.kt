package org.smarthealthit.checkin.wallet

import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject

data class ImportedProviderRecords(
    val provider: String,
    val patientDisplayName: String?,
    val patientBirthDate: String?,
    val fetchedAt: String?,
    val fhir: Map<String, List<JSONObject>>,
    val attachments: List<JSONObject> = emptyList(),
)

data class ImportedHealthRecords(
    val importedAt: String,
    val providers: List<ImportedProviderRecords>,
) {
    fun summary(): ImportedHealthRecordsSummary {
        val counts = linkedMapOf<String, Int>()
        providers.forEach { provider ->
            provider.fhir.forEach { (resourceType, resources) ->
                counts[resourceType] = (counts[resourceType] ?: 0) + resources.size
            }
        }
        val patients = providers.mapNotNull { it.patientDisplayName?.takeIf(String::isNotBlank) }.distinct()
        return ImportedHealthRecordsSummary(
            importedAt = importedAt,
            providerCount = providers.size,
            patientNames = patients,
            resourceCounts = counts,
            totalResources = counts.values.sum(),
        )
    }

    fun toJson(): JSONObject {
        return JSONObject()
            .put("version", 1)
            .put("importedAt", importedAt)
            .put(
                "providers",
                JSONArray().also { array ->
                    providers.forEach { provider ->
                        array.put(provider.toJson())
                    }
                },
            )
    }

    companion object {
        fun fromJson(json: JSONObject): ImportedHealthRecords {
            val providers = jsonObjectItems(json.optJSONArray("providers")).map(::providerFromJson)
            require(providers.isNotEmpty()) { "Imported records must include at least one provider payload." }
            return ImportedHealthRecords(
                importedAt = json.optString("importedAt").ifBlank { Instant.now().toString() },
                providers = providers,
            )
        }
    }
}

data class ImportedHealthRecordsSummary(
    val importedAt: String,
    val providerCount: Int,
    val patientNames: List<String>,
    val resourceCounts: Map<String, Int>,
    val totalResources: Int,
) {
    fun patientSummary(): String {
        return when {
            patientNames.isEmpty() -> "Patient identity not listed"
            patientNames.size == 1 -> patientNames.single()
            else -> patientNames.joinToString(limit = 2, truncated = "and ${patientNames.size - 2} more")
        }
    }

    fun resourceSummary(limit: Int = 5): String {
        if (resourceCounts.isEmpty()) return "No FHIR resources"
        return resourceCounts.entries
            .sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
            .take(limit)
            .joinToString { "${it.key} ${it.value}" }
    }
}

object HealthSkillzImportParser {
    fun parse(input: InputStream, fileName: String? = null): ImportedHealthRecords {
        val bytes = input.readBytes()
        val payloads = if (fileName?.lowercase()?.endsWith(".zip") == true || bytes.looksLikeZip()) {
            parseZip(ByteArrayInputStream(bytes))
        } else {
            parseJsonPayloads(bytes.toString(StandardCharsets.UTF_8))
        }
        require(payloads.isNotEmpty()) {
            "No Health Skillz provider payloads found. Expected health-record-assistant/data/*.json or health-records.json."
        }
        return ImportedHealthRecords(
            importedAt = Instant.now().toString(),
            providers = payloads.map(::providerFromHealthSkillzPayload),
        )
    }

    private fun parseZip(input: InputStream): List<JSONObject> {
        val payloads = mutableListOf<JSONObject>()
        ZipInputStream(input).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                val name = entry.name
                if (!entry.isDirectory && name.endsWith(".json") && isHealthSkillzDataEntry(name)) {
                    val text = zip.readBytes().toString(StandardCharsets.UTF_8)
                    payloads += parseJsonPayloads(text)
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        return payloads
    }

    private fun isHealthSkillzDataEntry(name: String): Boolean {
        return name.startsWith("data/") ||
            name.contains("/data/") ||
            name == "health-records.json"
    }

    private fun parseJsonPayloads(text: String): List<JSONObject> {
        val trimmed = text.trim()
        require(trimmed.isNotEmpty()) { "Imported JSON is empty." }
        return when (trimmed.first()) {
            '[' -> jsonObjectItems(JSONArray(trimmed))
            '{' -> {
                val obj = JSONObject(trimmed)
                when {
                    obj.has("providers") -> jsonObjectItems(obj.optJSONArray("providers"))
                    obj.has("fhir") -> listOf(obj)
                    else -> emptyList()
                }
            }
            else -> emptyList()
        }
    }
}

private fun ByteArray.looksLikeZip(): Boolean {
    return size >= 4 && this[0] == 0x50.toByte() && this[1] == 0x4b.toByte()
}

object ImportedHealthRecordsRepository {
    private const val FILE_NAME = "imported-health-records.normalized.json"

    fun importFromStream(root: File, fileName: String?, input: InputStream): ImportedHealthRecords {
        val records = HealthSkillzImportParser.parse(input, fileName)
        save(root, records)
        return records
    }

    fun load(root: File): ImportedHealthRecords? {
        val file = File(root, FILE_NAME)
        if (!file.exists()) return null
        return ImportedHealthRecords.fromJson(JSONObject(file.readText()))
    }

    fun loadSummary(root: File): ImportedHealthRecordsSummary? = load(root)?.summary()

    fun save(root: File, records: ImportedHealthRecords) {
        root.mkdirs()
        File(root, FILE_NAME).writeText(records.toJson().toString(2))
    }

    fun clear(root: File): Boolean = File(root, FILE_NAME).delete()
}

class ImportedFhirWalletStore(
    private val records: ImportedHealthRecords,
    /** Where the records came from, as shown to the patient ("Matched from …"). */
    private val sourceLabel: String = "imported Health Skillz records",
) : SmartHealthWalletStore {
    override fun resolveItems(items: List<RequestItem>): List<RequestItemResolution> {
        return items.map { item ->
            val mediaType = preferredMediaType(item)
            if (mediaType == null) {
                return@map RequestItemResolution(
                    itemId = item.id,
                    availability = WalletItemAvailability.Unsupported,
                    candidates = emptyList(),
                    matchSummary = "This wallet cannot produce an accepted media type for this item.",
                    statusIfShared = RequestItemStatusCode.Unsupported,
                )
            }
            if (item.kind == RequestKind.Questionnaire && item.meta.optJSONObject("questionnaire") == null) {
                return@map RequestItemResolution(
                    itemId = item.id,
                    availability = WalletItemAvailability.Unsupported,
                    candidates = emptyList(),
                    matchSummary = "This wallet couldn't load the form from ${item.meta.optString("questionnaireCanonical")}.",
                    statusIfShared = RequestItemStatusCode.Unsupported,
                )
            }
            if (item.kind == RequestKind.Questionnaire) {
                return@map RequestItemResolution(
                    itemId = item.id,
                    availability = WalletItemAvailability.Available,
                    candidates = listOf(
                        WalletCandidate(
                            id = "form-${item.id}",
                            label = questionnaireTitleForRequestItem(item) ?: "Form answers",
                            subtitle = "QuestionnaireResponse built from reviewed answers",
                            resourceType = "QuestionnaireResponse",
                            sourceName = "This wallet",
                        ),
                    ),
                    matchSummary = "Form can be completed now",
                )
            }

            val resourceTypes = requestedResourceTypes(item)
            if (resourceTypes == null) {
                return@map RequestItemResolution(
                    itemId = item.id,
                    availability = WalletItemAvailability.Unsupported,
                    candidates = emptyList(),
                    matchSummary = "This wallet cannot interpret this selector.",
                    statusIfShared = RequestItemStatusCode.Unsupported,
                )
            }

            val candidates = candidatesForResourceTypes(resourceTypes).filter { matchesProfileSelectors(item, it.value) }
            if (candidates.isEmpty()) {
                RequestItemResolution(
                    itemId = item.id,
                    availability = WalletItemAvailability.Unavailable,
                    candidates = emptyList(),
                    matchSummary = "No matching records found",
                    detail = "Nothing in $sourceLabel matches this request.",
                    statusIfShared = RequestItemStatusCode.Unavailable,
                )
            } else {
                RequestItemResolution(
                    itemId = item.id,
                    availability = WalletItemAvailability.Available,
                    candidates = candidates,
                    matchSummary = "${candidates.size} matching ${if (candidates.size == 1) "record" else "records"} available",
                    detail = "Matched from $sourceLabel.",
                )
            }
        }
    }

    override fun buildArtifact(
        item: RequestItem,
        selectedCandidates: List<WalletCandidate>,
        questionnaireAnswers: Map<String, Any>,
    ): SmartHealthWalletArtifact {
        if (item.kind == RequestKind.Questionnaire) {
            return SmartHealthWalletArtifact(
                value = QuestionnaireResponseBuilder.build(item, questionnaireAnswers),
            )
        }
        val resources = withReferencedResources(selectedCandidates.mapNotNull { it.value }.map { JSONObject(it.toString()) })
        if (preferredMediaType(item) == SMART_HEALTH_CARD) {
            return SmartHealthWalletArtifact(
                mediaType = SMART_HEALTH_CARD,
                value = JSONObject().put("verifiableCredential", JSONArray().put(TestIssuerHealthCards.mint(resources))),
            )
        }
        val value = JSONObject()
            .put("resourceType", "Bundle")
            .put("type", "collection")
            .put(
                "entry",
                JSONArray().also { entries ->
                    resources.forEach { resource ->
                        val entry = JSONObject()
                        fullUrlFor(resource)?.let { entry.put("fullUrl", it) }
                        entries.put(entry.put("resource", resource))
                    }
                },
            )
        return SmartHealthWalletArtifact(value = value)
    }

    override fun prefillQuestionnaireAnswers(items: List<RequestItem>): Map<String, Any> = emptyMap()

    /**
     * The first accepted media type this wallet can produce. Forms are always
     * FHIR JSON; for records, a SMART Health Card signed by the connectathon test
     * issuer is produced when the item lists it before FHIR JSON.
     */
    private fun preferredMediaType(item: RequestItem): String? = item.acceptedMediaTypes.firstOrNull {
        it == FHIR_JSON || (it == SMART_HEALTH_CARD && item.kind != RequestKind.Questionnaire)
    }

    /**
     * Profile semantics (spec §5.4.1, §5.5). A resource that declares profiles in
     * meta.profile must match a requested profile (unversioned request: any
     * version; versioned: exact) or sit in a requested profile family.
     * Resources with no declared profiles, such as imported records, fall back to
     * the resource-type guess made by requestedResourceTypes.
     */
    private fun matchesProfileSelectors(item: RequestItem, resource: JSONObject?): Boolean {
        if (resource == null) return false
        val content = item.meta.optJSONObject("content") ?: return true
        val wantProfiles = stringValues(content.opt("profiles"))
        val wantFamilies = stringValues(content.opt("profilesFrom")).map { it.substringBefore('|').trimEnd('/') }
        if (wantProfiles.isEmpty() && wantFamilies.isEmpty()) return true
        val declared = stringValues(resource.optJSONObject("meta")?.opt("profile"))
        if (declared.isEmpty()) return true
        return declared.any { have ->
            val haveUrl = have.substringBefore('|')
            wantProfiles.any { want ->
                haveUrl == want.substringBefore('|') && (!want.contains('|') || have == want)
            } || wantFamilies.any { family -> haveUrl.startsWith("$family/StructureDefinition/") }
        }
    }

    private fun fullUrlFor(resource: JSONObject): String? {
        val id = resource.optString("id")
        return when {
            id.isBlank() -> null
            UUID_PATTERN.matches(id) -> "urn:uuid:$id"
            else -> "${resource.optString("resourceType")}/$id"
        }
    }

    /** Add resources the selection references (prescriber, payer, ...), except the Patient. */
    private fun withReferencedResources(selected: List<JSONObject>): List<JSONObject> {
        val byFullUrl = LinkedHashMap<String, JSONObject>()
        records.providers.forEach { provider ->
            provider.fhir.values.flatten().forEach { r -> fullUrlFor(r)?.let { byFullUrl[it] = r } }
        }
        val out = LinkedHashMap<String, JSONObject>()
        selected.forEachIndexed { i, r -> out[fullUrlFor(r) ?: "selected-$i"] = r }
        val queue = ArrayDeque(selected)
        while (queue.isNotEmpty()) {
            collectReferences(queue.removeFirst()).forEach { ref ->
                val target = byFullUrl[ref] ?: return@forEach
                if (target.optString("resourceType") == "Patient" || out.containsKey(ref)) return@forEach
                val copy = JSONObject(target.toString())
                out[ref] = copy
                queue.addLast(copy)
            }
        }
        return out.values.toList()
    }

    private fun collectReferences(value: Any?): List<String> = when (value) {
        is JSONObject -> value.keys().asSequence().flatMap { key ->
            val v = value.opt(key)
            if (key == "reference" && v is String) sequenceOf(v) else collectReferences(v).asSequence()
        }.toList()
        is JSONArray -> (0 until value.length()).flatMap { collectReferences(value.opt(it)) }
        else -> emptyList()
    }

    private fun candidatesForResourceTypes(resourceTypes: Set<String>): List<WalletCandidate> {
        val out = mutableListOf<WalletCandidate>()
        records.providers.forEachIndexed { providerIndex, provider ->
            resourceTypes.forEach { resourceType ->
                provider.fhir[resourceType].orEmpty().forEachIndexed { resourceIndex, resource ->
                    out += WalletCandidate(
                        id = "p$providerIndex:$resourceType:$resourceIndex:${resource.optString("id")}",
                        label = resourceLabel(provider, resource, resourceIndex),
                        subtitle = resourceSubtitle(provider, resource),
                        resourceType = resourceType,
                        sourceName = provider.provider,
                        selectedByDefault = true,
                        value = JSONObject(resource.toString()),
                    )
                }
            }
        }
        return out
    }

    private fun requestedResourceTypes(item: RequestItem): Set<String>? {
        val content = item.meta.optJSONObject("content")
        val explicitTypes = stringValues(content?.opt("resourceTypes")).map(::normalizeResourceType).toSet()
        val profileTypes = stringValues(content?.opt("profiles"))
            .flatMap(::resourceTypesForProfile)
            .toSet()
        val profileFamilies = stringValues(content?.opt("profilesFrom")).map { it.substringBefore('|').lowercase() }
        // resourceTypes narrows any profile selector rather than adding to it (spec §5.4.1);
        // matchesProfileSelectors then applies the profiles themselves.
        if (explicitTypes.isNotEmpty()) return explicitTypes
        val requested = linkedSetOf<String>()
        requested += profileTypes
        if (profileFamilies.any { it == US_CORE_CANONICAL }) requested += BROAD_US_CORE_RESOURCE_TYPES
        if (requested.isNotEmpty()) return requested

        return when (item.kind) {
            RequestKind.Coverage -> setOf("Coverage")
            RequestKind.Plan -> setOf("InsurancePlan")
            RequestKind.Clinical -> BROAD_US_CORE_RESOURCE_TYPES
            RequestKind.Questionnaire -> emptySet()
            RequestKind.Unknown -> null
        }
    }

    private fun resourceTypesForProfile(profile: String): Set<String> {
        val p = profile.substringBefore('|').lowercase()
        return when {
            p.contains("c4dic-coverage") -> setOf("Coverage")
            p.contains("sbc-insurance-plan") || p.contains("c4dic-insuranceplan") -> setOf("InsurancePlan")
            p.contains("us-core-patient") -> setOf("Patient")
            p.contains("us-core-condition") -> setOf("Condition")
            p.contains("us-core-allergyintolerance") -> setOf("AllergyIntolerance")
            p.contains("us-core-medicationrequest") -> setOf("MedicationRequest")
            p.contains("us-core-medicationstatement") -> setOf("MedicationStatement")
            p.contains("us-core-immunization") -> setOf("Immunization")
            p.contains("us-core-observation") -> setOf("Observation")
            p.contains("us-core-diagnosticreport") -> setOf("DiagnosticReport")
            p.contains("us-core-documentreference") -> setOf("DocumentReference")
            p.contains("us-core-procedure") -> setOf("Procedure")
            p.contains("us-core-encounter") -> setOf("Encounter")
            p.contains("us-core-careplan") -> setOf("CarePlan")
            p.contains("us-core-careteam") -> setOf("CareTeam")
            p.contains("us-core-goal") -> setOf("Goal")
            p.contains("us-core-device") -> setOf("Device")
            p.contains("us-core-servicerequest") -> setOf("ServiceRequest")
            else -> emptySet()
        }
    }

    private fun resourceLabel(provider: ImportedProviderRecords, resource: JSONObject, index: Int): String {
        val resourceType = resource.optString("resourceType").ifBlank { "Resource" }
        val name = firstHumanName(resource.optJSONArray("name"))
        val code = when (resourceType) {
            "Coverage" -> coverageLabel(resource)
            "MedicationRequest",
            "MedicationStatement",
            "MedicationDispense" -> medicationLabel(provider, resource)
            "Immunization" -> codeText(resource.optJSONObject("vaccineCode"))
            "DiagnosticReport",
            "Observation",
            "Procedure",
            "ServiceRequest" -> codeText(resource.optJSONObject("code"))
            "DocumentReference" -> codeText(resource.optJSONObject("type"))
            "Encounter" -> firstCodeText(resource.optJSONArray("type")) ?: classText(resource.optJSONObject("class"))
            "CarePlan",
            "CareTeam" -> firstCodeText(resource.optJSONArray("category"))
            "Goal" -> codeText(resource.optJSONObject("description"))
            "Specimen" -> codeText(resource.optJSONObject("type"))
            "Location",
            "Organization" -> resource.optString("name").ifBlank { null }
            else -> codeText(resource.optJSONObject("code"))
        }
        val title = resource.optString("title").ifBlank { null }
        val description = resource.optString("description").ifBlank { null }
        val id = resource.optString("id").ifBlank { null }
        return listOf(name, code, title, description, id).firstOrNull { !it.isNullOrBlank() }
            ?: "$resourceType ${index + 1}"
    }

    private fun resourceSubtitle(provider: ImportedProviderRecords, resource: JSONObject): String {
        val resourceType = resource.optString("resourceType").ifBlank { "FHIR resource" }
        val parts = mutableListOf(resourceType)
        when (resourceType) {
            "Coverage" -> coverageSubtitle(resource)
            "MedicationRequest",
            "MedicationStatement",
            "MedicationDispense" -> medicationSubtitle(provider, resource)
            "Observation" -> observationSubtitle(resource)
            "DocumentReference" -> documentSubtitle(resource)
            "Encounter" -> encounterSubtitle(resource)
            else -> genericSubtitle(resource)
        }.filterTo(parts) { it.isNotBlank() }
        return parts.distinct().joinToString(" · ")
    }

    private fun firstHumanName(names: JSONArray?): String? {
        val first = names?.optJSONObject(0) ?: return null
        first.optString("text").takeIf(String::isNotBlank)?.let { return it }
        val given = stringValues(first.opt("given")).joinToString(" ")
        val family = first.optString("family")
        return "$given $family".trim().ifBlank { null }
    }

    private fun codeText(code: JSONObject?): String? {
        if (code == null) return null
        code.optString("text").takeIf(String::isNotBlank)?.let { return it }
        val coding = code.optJSONArray("coding") ?: return null
        for (i in 0 until coding.length()) {
            val item = coding.optJSONObject(i) ?: continue
            item.optString("display").takeIf(String::isNotBlank)?.let { return it }
            item.optString("code").takeIf(String::isNotBlank)?.let { return it }
        }
        return null
    }

    private fun firstCodeText(codes: JSONArray?): String? {
        return jsonObjectItems(codes).firstNotNullOfOrNull(::codeText)
    }

    private fun classText(code: JSONObject?): String? {
        if (code == null) return null
        code.optString("display").takeIf(String::isNotBlank)?.let { return it }
        return code.optString("code").ifBlank { null }
    }

    private fun coverageLabel(resource: JSONObject): String? {
        val payor = firstReferenceDisplay(resource.optJSONArray("payor"))
        val type = codeText(resource.optJSONObject("type"))
        val plan = coverageClass(resource, "plan") ?: coverageClass(resource, "group")
        return listOf(plan?.name, type, payor, plan?.value).firstOrNull { !it.isNullOrBlank() }
    }

    private fun coverageSubtitle(resource: JSONObject): List<String> {
        val parts = mutableListOf<String>()
        resource.optString("status").takeIf(String::isNotBlank)?.let(parts::add)
        firstReferenceDisplay(resource.optJSONArray("payor"))?.let { parts += "Payor: $it" }
        resource.optString("subscriberId").takeIf(String::isNotBlank)?.let { parts += "Subscriber: $it" }
        coverageClass(resource, "group")?.let { parts += "Group: ${it.display}" }
        coverageClass(resource, "plan")?.let { parts += "Plan: ${it.display}" }
        periodSummary(resource.optJSONObject("period"))?.let(parts::add)
        return parts
    }

    private fun medicationLabel(provider: ImportedProviderRecords, resource: JSONObject): String? {
        codeText(resource.optJSONObject("medicationCodeableConcept"))?.let { return it }
        val medicationReference = resource.optJSONObject("medicationReference")
        medicationReference?.optString("display")?.takeIf(String::isNotBlank)?.let { return it }
        val medication = referencedResource(provider, medicationReference)
        return medication?.let { codeText(it.optJSONObject("code")) }
    }

    private fun medicationSubtitle(provider: ImportedProviderRecords, resource: JSONObject): List<String> {
        val parts = genericSubtitle(resource).toMutableList()
        resource.optJSONObject("requester")?.optString("display")?.takeIf(String::isNotBlank)?.let {
            parts += "Requester: $it"
        }
        resource.optJSONObject("medicationReference")?.let { reference ->
            if (medicationLabel(provider, resource).isNullOrBlank()) {
                reference.optString("reference").takeIf(String::isNotBlank)?.let(parts::add)
            }
        }
        return parts
    }

    private fun observationSubtitle(resource: JSONObject): List<String> {
        return genericSubtitle(resource) + listOfNotNull(valueSummary(resource))
    }

    private fun documentSubtitle(resource: JSONObject): List<String> {
        val parts = genericSubtitle(resource).toMutableList()
        resource.optString("docStatus").takeIf(String::isNotBlank)?.let(parts::add)
        return parts
    }

    private fun encounterSubtitle(resource: JSONObject): List<String> {
        val parts = genericSubtitle(resource).toMutableList()
        periodSummary(resource.optJSONObject("period"))?.let(parts::add)
        return parts
    }

    private fun genericSubtitle(resource: JSONObject): List<String> {
        val parts = mutableListOf<String>()
        resource.optString("status").takeIf(String::isNotBlank)?.let(parts::add)
        codeText(resource.optJSONObject("clinicalStatus"))?.let(parts::add)
        resource.optString("recordedDate").takeIf(String::isNotBlank)?.let(parts::add)
        resource.optString("effectiveDateTime").takeIf(String::isNotBlank)?.let(parts::add)
        resource.optString("issued").takeIf(String::isNotBlank)?.let(parts::add)
        resource.optString("authoredOn").takeIf(String::isNotBlank)?.let(parts::add)
        resource.optString("occurrenceDateTime").takeIf(String::isNotBlank)?.let(parts::add)
        resource.optString("performedDateTime").takeIf(String::isNotBlank)?.let(parts::add)
        resource.optString("date").takeIf(String::isNotBlank)?.let(parts::add)
        return parts
    }

    private data class CoverageClass(val name: String?, val value: String?) {
        val display: String
            get() = listOfNotNull(name, value).joinToString(" ").ifBlank { name ?: value.orEmpty() }
    }

    private fun coverageClass(resource: JSONObject, code: String): CoverageClass? {
        return jsonObjectItems(resource.optJSONArray("class"))
            .firstOrNull { coverageClassCode(it.optJSONObject("type")) == code }
            ?.let { item ->
                CoverageClass(
                    name = item.optString("name").ifBlank { null },
                    value = item.optString("value").ifBlank { null },
                )
            }
    }

    private fun coverageClassCode(type: JSONObject?): String? {
        val coding = type?.optJSONArray("coding") ?: return null
        return jsonObjectItems(coding).firstNotNullOfOrNull { codingItem ->
            codingItem.optString("code").lowercase().ifBlank { null }
        }
    }

    private fun firstReferenceDisplay(references: JSONArray?): String? {
        return jsonObjectItems(references).firstNotNullOfOrNull { reference ->
            reference.optString("display").ifBlank {
                reference.optString("reference").substringAfterLast('/').ifBlank { null }
            }
        }
    }

    private fun referencedResource(provider: ImportedProviderRecords, reference: JSONObject?): JSONObject? {
        val ref = reference?.optString("reference")?.takeIf(String::isNotBlank) ?: return null
        val parts = ref.split('/')
        if (parts.size < 2) return null
        val resourceType = parts[parts.size - 2]
        val id = parts.last()
        return provider.fhir[resourceType].orEmpty().firstOrNull { it.optString("id") == id }
    }

    private fun periodSummary(period: JSONObject?): String? {
        if (period == null) return null
        val start = period.optString("start").ifBlank { null }
        val end = period.optString("end").ifBlank { null }
        return when {
            start != null && end != null -> "$start to $end"
            start != null -> "Since $start"
            end != null -> "Until $end"
            else -> null
        }
    }

    private fun valueSummary(resource: JSONObject): String? {
        resource.optJSONObject("valueQuantity")?.let { quantity ->
            val value = quantity.opt("value")?.toString()?.takeIf(String::isNotBlank)
            val unit = quantity.optString("unit").ifBlank { quantity.optString("code") }
            return listOfNotNull(value, unit.ifBlank { null }).joinToString(" ").ifBlank { null }
        }
        resource.optString("valueString").takeIf(String::isNotBlank)?.let { return it }
        codeText(resource.optJSONObject("valueCodeableConcept"))?.let { return it }
        val components = resource.optJSONArray("component")
        if (components != null && components.length() > 0) return "${components.length()} component values"
        return null
    }

    private fun normalizeResourceType(value: String): String {
        return value.trim().replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }
    }

    private companion object {
        private const val US_CORE_CANONICAL = "http://hl7.org/fhir/us/core"
        private const val FHIR_JSON = "application/fhir+json"
        private const val SMART_HEALTH_CARD = "application/smart-health-card"
        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
        private val BROAD_US_CORE_RESOURCE_TYPES = linkedSetOf(
            "Patient",
            "RelatedPerson",
            "Coverage",
            "Condition",
            "AllergyIntolerance",
            "MedicationRequest",
            "MedicationStatement",
            "Immunization",
            "Observation",
            "DiagnosticReport",
            "DocumentReference",
            "Procedure",
            "Encounter",
            "CarePlan",
            "CareTeam",
            "Goal",
            "Device",
            "ServiceRequest",
        )
    }
}

private fun ImportedProviderRecords.toJson(): JSONObject {
    return JSONObject()
        .put("provider", provider)
        .put("patientDisplayName", patientDisplayName ?: JSONObject.NULL)
        .put("patientBirthDate", patientBirthDate ?: JSONObject.NULL)
        .put("fetchedAt", fetchedAt ?: JSONObject.NULL)
        .put(
            "fhir",
            JSONObject().also { fhirJson ->
                fhir.forEach { (resourceType, resources) ->
                    fhirJson.put(
                        resourceType,
                        JSONArray().also { array ->
                            resources.forEach { array.put(JSONObject(it.toString())) }
                        },
                    )
                }
            },
        )
        .put(
            "attachments",
            JSONArray().also { array ->
                attachments.forEach { array.put(JSONObject(it.toString())) }
            },
        )
}

private fun providerFromJson(json: JSONObject): ImportedProviderRecords {
    val fhir = linkedMapOf<String, List<JSONObject>>()
    val fhirJson = json.optJSONObject("fhir") ?: JSONObject()
    fhirJson.keys().forEach { resourceType ->
        fhir[resourceType] = jsonObjectItems(fhirJson.optJSONArray(resourceType))
            .map { JSONObject(it.toString()) }
    }
    return ImportedProviderRecords(
        provider = json.optString("provider").ifBlank { "Imported records" },
        patientDisplayName = json.optString("patientDisplayName").ifBlank { null },
        patientBirthDate = json.optString("patientBirthDate").ifBlank { null },
        fetchedAt = json.optString("fetchedAt").ifBlank { null },
        fhir = fhir,
        attachments = jsonObjectItems(json.optJSONArray("attachments")).map { JSONObject(it.toString()) },
    )
}

private fun providerFromHealthSkillzPayload(payload: JSONObject): ImportedProviderRecords {
    val fhirJson = payload.optJSONObject("fhir")
        ?: throw IllegalArgumentException("Health Skillz provider payload is missing fhir.")
    val fhir = linkedMapOf<String, MutableList<JSONObject>>()
    fhirJson.keys().forEach { sourceType ->
        jsonObjectItems(fhirJson.optJSONArray(sourceType)).forEach { resource ->
            val resourceType = resource.optString("resourceType").ifBlank { sourceType }
            fhir.getOrPut(resourceType) { mutableListOf() }.add(JSONObject(resource.toString()))
        }
    }
    require(fhir.values.any { it.isNotEmpty() }) { "Health Skillz provider payload has no FHIR resources." }
    return ImportedProviderRecords(
        provider = payload.optString("provider").ifBlank {
            payload.optString("name").ifBlank { "Imported records" }
        },
        patientDisplayName = payload.optString("patientDisplayName").ifBlank { null },
        patientBirthDate = payload.optString("patientBirthDate").ifBlank { null },
        fetchedAt = payload.optString("fetchedAt").ifBlank {
            payload.optString("connectedAt").ifBlank { null }
        },
        fhir = fhir.mapValues { (_, resources) -> resources.toList() },
        attachments = jsonObjectItems(payload.optJSONArray("attachments")).map { JSONObject(it.toString()) },
    )
}

private fun stringValues(value: Any?): List<String> {
    return when (value) {
        is String -> listOf(value).filter { it.isNotBlank() }
        is JSONArray -> {
            val out = mutableListOf<String>()
            for (i in 0 until value.length()) {
                out += stringValues(value.opt(i))
            }
            out
        }
        is JSONObject -> listOf(value.optString("canonical")).filter { it.isNotBlank() }
        else -> emptyList()
    }
}


/**
 * The reference wallet's bundled synthetic patients, the same ones the SMART
 * Testing Wallet serves (connectathon repo, testing-wallet/data/). Loaded into an
 * ImportedFhirWalletStore so matching works the same way as for imported records.
 */
object ReferencePatients {
    const val PREFS = "reference-patients"
    const val PREF_KEY = "patient"
    const val ARIA = "aria"
    const val LARGE = "large"

    val labels = linkedMapOf(
        ARIA to "Aria Test",
        LARGE to "Aria Test, large record (over 2 MB)",
    )

    fun assetPath(key: String): String = when (key) {
        LARGE -> "reference-patients/large-record.json"
        else -> "reference-patients/aria-test.json"
    }

    fun fromBundle(bundle: JSONObject, label: String): ImportedHealthRecords {
        val fhir = linkedMapOf<String, MutableList<JSONObject>>()
        var patientName: String? = null
        var birthDate: String? = null
        jsonObjectItems(bundle.optJSONArray("entry")).forEach { entry ->
            val resource = entry.optJSONObject("resource") ?: return@forEach
            val type = resource.optString("resourceType")
            if (type.isBlank()) return@forEach
            fhir.getOrPut(type) { mutableListOf() }.add(JSONObject(resource.toString()))
            if (type == "Patient") {
                val name = resource.optJSONArray("name")?.optJSONObject(0)
                patientName = listOfNotNull(
                    name?.optJSONArray("given")?.optString(0),
                    name?.optString("family"),
                ).joinToString(" ").ifBlank { null }
                birthDate = resource.optString("birthDate").ifBlank { null }
            }
        }
        return ImportedHealthRecords(
            importedAt = Instant.now().toString(),
            providers = listOf(
                ImportedProviderRecords(
                    provider = label,
                    patientDisplayName = patientName,
                    patientBirthDate = birthDate,
                    fetchedAt = null,
                    fhir = fhir,
                ),
            ),
        )
    }
}
