---
name: documentary-extraction
description: Extraction addendum for documentary / historical subjects — identity fields, paintable identity symbols, no source pollution
---

# Documentary / Historical Subjects: Extraction Addendum

Layered on top of the base extractor specification; where they conflict, this file wins. How to call the tools is described in the tool descriptions — this file only states **what to write**.

## Characters

**Who gets a character card (hard rule)**: every historical figure named in the narration who makes a **decision or takes action** in this episode's events gets a card —
including a monarch who only issues orders from afar and never appears on screen in this episode (such as the Qing emperor sending troops on the southern front at the same time).
No cards for: people merely mentioned in passing by the narration with no decision and no action, later historians and relayers of the account,
and unnamed groups (soldiers, retainers, prisoners, boatmen) — groups go into scenes and storyboards, they do not take a character card.

- `role`: a short identity label, ≤12 characters ("Tsar · Issuer of the Edict").
- `description`: 1–3 sentences covering ① status and identity ② faction / dynasty ③ period and present situation ④ narrative function in this episode.
- `appearance`: apparent age, build, face shape, hairstyle, shape of moustache and beard; for historical figures, write the features confirmed by archival portraits.
- `styling`: **at least 2 wearable or carryable identity symbols**, each with its cut and colour pinned down. Symbol categories: crown / headgear / braid form,
  sashes and orders, cuirass and military dress, court robes and rank badges, robe patterns and belts, sword and sceptre, seals and documents, ceremonial objects held in hand.
- **Recognisability first (hard rule)**: when a character has several historically valid outfits, choose the one with the highest identity recognisability.
  For Peter I write "cuirass military dress + blue sash of the Order of St Andrew", not the equally true but commoner-looking plain coat; for a Qing emperor write court robe, court beads and court hat, not informal dress.

## No Background in the Three-View Sheet (hard rule)

The character turnaround reference sheet has a pure white background. Identity **may only** be expressed through what is worn and carried; it is **forbidden** to write palaces, battlefields, maps, banners, desks,
ceremonial processions or any other environmental element into any field — the prompt agent will put them into the image and destroy the reference-sheet layout.

## Scenes

`prompt` must let the reader deduce ① the period (architectural form, materials and craft — write the concrete form, not "ancient style") ② the region (geography, climate, vegetation)
③ the function (negotiation hall / post station / workshop / army tent; function determines the furnishings). Objects later than that period are forbidden.
`time` is still a **time of day** (early morning / noon / dusk / night …); the period goes into `prompt` — do not put a year into `time`.
`lighting` uses only light sources available in that period (daylight, moonlight, candlelight, oil lamp, hearth fire, torch) and must agree with `time`.

## Props

`description` must contain **period + use + material and craft** ("a late-17th-century hand-copied parchment document, written with a quill, sealed with red wax, worn at the edges").
Modern machining traces (laser-cut edges, machine screws, plastic parts) are forbidden unless the period itself allows them.

## Historical Fact and Sources (hard rule)

- Use only facts from the **script text** and from **content returned by the search tools**; what you cannot recall precisely or cannot verify is not written — better one symbol fewer than one invented.
- Verify key historical figures once, following the discipline stated in the tool description; when a tool returns `degraded`, use the script text only — extraction does not fail.
- No field may **ever contain** a URL, a domain, "according to Wikipedia", "see also", "source", "[1]" or any other source annotation.
  Provenance is saved automatically by the "source" records.
