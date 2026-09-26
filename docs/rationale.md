# Why SMART Health Check-in looks the way it does

Non-normative background for [the specification](../spec.md). Nothing here adds or changes a requirement.

## Why the Digital Credentials API and mdoc

Check-in needs a low-friction way for a patient to move data from their wallet into a clinic's workflow. In 2026, browser-mediated wallet invocation through the W3C Digital Credentials API, with ISO mdoc presentations, is deployed in current browsers and phone platforms. Healthcare-specific, cross-vendor wallet protocols are not. So the protocol standardizes the clinical content model plus the one presentation surface that interoperates today.

Using mdoc this way is unconventional. mdoc was designed for identity documents, where an authority issues each data element and the holder discloses elements selectively. Here, the Wallet puts the whole response JSON into one element and signs the mdoc itself. The mdoc layer is an envelope: encrypted to the clinic, bound to the calling origin, and signed so it is intact and well formed. It is not a clinical credential.

## Why disclosure choices live in the JSON

Mapping each FHIR resource, Questionnaire, or status to its own mdoc element would push clinical meaning into mdoc element names. Keeping one stable element (`smart_health_checkin_response`) means:

- item-level choices, statuses, and many-to-many fulfillment are expressed in JSON that FHIR-aware software can validate;
- mdoc software sees an ordinary, fixed document type;
- the request and response model can travel over other transports later without change.

## Why a request is not a limit

Clinics ask for what helps; patients decide what to share. A selector describes what the clinic is looking for, and the Wallet and patient may share less, more, or different content. The response says what happened for each item, so the clinic never has to guess.

## Why signatures don't identify an issuer

A trust framework for health apps does not exist yet, and waiting for one would block useful exchange between willing parties. The protocol therefore requires real, verifiable signatures, so strict mdoc software accepts the messages, while stating plainly that the signatures prove integrity and well-formedness, not issuer identity. Deployments that need more can add trust requirements (for example, trusted reader certificates) through a deployment profile.

## Why handoffs aren't part of the protocol

Getting the patient to a page that calls the Digital Credentials API (a text-message link, a QR code at the desk, a portal button, a kiosk session passed to a phone) is product and workflow design. Keeping it out of the protocol lets deployments vary freely without changing the request, the response, or validation.

## Editorial approach

The specification states each requirement once, gives it a stable ID, and keeps TypeScript and CDDL to structure. Tutorials, captures, byte ladders, and implementation notes are companion material. Earlier drafts named the roles Requester and Responder; 1.0 uses Verifier and Wallet throughout.
