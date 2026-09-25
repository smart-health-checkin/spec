package org.smarthealthit.checkin.wallet

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The reference patient answering the connectathon baseline requests, the way
 * the web SMART Testing Wallet does. Requests are copies of
 * the request files in smart-health-checkin/connectathon.
 */
class ReferencePatientStoreTest {
    private val store = ImportedFhirWalletStore(
        ReferencePatients.fromBundle(
            JSONObject(File("src/main/assets/${ReferencePatients.assetPath(ReferencePatients.ARIA)}").readText()),
            "Aria Test",
        ),
    )

    private fun items(name: String): List<RequestItem> {
        val json = JSONObject(javaClass.getResource("/connectathon-requests/$name.json")!!.readText())
        return SmartRequestAdapter.build("https://ehr.example", "nonce", json).items
    }

    private fun bundleFor(item: RequestItem, resolution: RequestItemResolution): JSONObject =
        store.buildArtifact(item, resolution.candidates, emptyMap()).value

    private fun types(bundle: JSONObject): List<String> {
        val entries = bundle.getJSONArray("entry")
        return (0 until entries.length()).map { entries.getJSONObject(it).getJSONObject("resource").getString("resourceType") }
    }

    @Test
    fun baseline1MatchesEachItemByProfile() {
        val items = items("baseline-1")
        val resolutions = store.resolveItems(items)
        val expected = mapOf(
            "patient" to "Patient",
            "problems" to "Condition",
            "allergies" to "AllergyIntolerance",
            "medications" to "MedicationRequest",
            "immunizations" to "Immunization",
        )
        items.zip(resolutions).forEach { (item, resolution) ->
            assertEquals("${item.id} availability", WalletItemAvailability.Available, resolution.availability)
            assertTrue("${item.id} candidates are all ${expected[item.id]}", resolution.candidates.all { it.resourceType == expected[item.id] })
        }
        assertEquals(1, resolutions.first { it.itemId == "patient" }.candidates.size)
        assertEquals(3, resolutions.first { it.itemId == "problems" }.candidates.size)
    }

    @Test
    fun medicationsBundleIncludesThePrescriberSoReferencesResolve() {
        val items = items("baseline-1")
        val meds = items.first { it.id == "medications" }
        val bundle = bundleFor(meds, store.resolveItems(listOf(meds)).single())
        assertEquals(listOf("MedicationRequest", "MedicationRequest", "MedicationRequest", "Practitioner"), types(bundle))
        val entries = bundle.getJSONArray("entry")
        assertTrue((0 until entries.length()).all { entries.getJSONObject(it).optString("fullUrl").startsWith("urn:uuid:") })
    }

    @Test
    fun coverageMatchesCarinOrUsCoreAndBringsThePayer() {
        val coverage = items("baseline-2").first { it.id == "coverage" }
        val resolution = store.resolveItems(listOf(coverage)).single()
        assertEquals(listOf("Coverage"), resolution.candidates.map { it.resourceType })
        assertEquals(listOf("Coverage", "Organization"), types(bundleFor(coverage, resolution)))
    }

    @Test
    fun narrowedFamilyReturnsOnlyObservations() {
        val item = items("o4-narrowed-family").single()
        val resolution = store.resolveItems(listOf(item)).single()
        assertTrue(resolution.candidates.isNotEmpty())
        assertTrue(resolution.candidates.all { it.resourceType == "Observation" })
    }

    @Test
    fun questionnaireResponseEchoesTheRequestedCanonicalExactly() {
        val phq2 = items("baseline-3").first { it.id == "phq2" }
        val qr = QuestionnaireResponseBuilder.build(phq2, emptyMap())
        assertEquals("https://smart-health-checkin.org/connectathon/Questionnaire/phq-2.json", qr.getString("questionnaire"))

        val versioned = items("o2-versioned-canonical").single()
        val qr2 = QuestionnaireResponseBuilder.build(versioned, emptyMap())
        assertEquals("https://smart-health-checkin.org/connectathon/Questionnaire/phq-2.json|1", qr2.getString("questionnaire"))
    }

    @Test
    fun unknownSelectorKindIsUnsupportedWhileOtherItemsAreServed() {
        val items = items("o12-unknown-selector")
        val resolutions = store.resolveItems(items)
        assertEquals(WalletItemAvailability.Available, resolutions.first { it.itemId == "patient" }.availability)
        val mystery = resolutions.first { it.itemId == "mystery" }
        assertEquals(WalletItemAvailability.Unsupported, mystery.availability)
        assertEquals(RequestItemStatusCode.Unsupported, mystery.statusIfShared)
    }
}
