---
name: documentary-extraction
description: Extraction addendum for documentary / historical subjects — identity fields, paintable identity symbols, no source pollution
---

# Documentary / Historical Subjects: Extraction Addendum

Layered on top of the base extractor specification; where they conflict, this file wins. How to call the tools is described in the tool descriptions — this file only states **what to write**.

## Extraction Order (hard rule)

1. `read_script_for_extraction` to read the whole script, `read_existing_characters` to see the characters the project already has.
2. `read_character_roster` to read this episode's **cast roster**.
   - `usable=true`: the roster is the contract — **follow it as it stands**. Do not decide again who gets a card, do not change the names on it.
   - `usable=false` (no roster yet, or the script changed and the roster went stale): walk the decision procedure below,
     fix the whole cast of this episode in one go and call `save_character_roster` to save a **draft** (status "awaiting review"; a human confirms it on the episode page).
3. Only then research: search only for the key historical figures on the roster (the number of search calls per run is limited — do not look up anyone outside the roster).
4. Finally call `save_dedup_characters`: **every person on the roster gets a card, and nobody outside the roster gets one**.

The roster belongs to the episode — it is a reviewed contract, not a scratch list for one run:

- Names follow the roster. A transliteration or title spelling close to a roster name is folded back onto the roster's name (`renamed_to_roster`);
  a name that cannot be folded back is **not written to the database** and comes back in `not_in_roster`.
- When a usable roster exists, calling `save_character_roster` again **does not change it**: the tool only reports how your proposal differs
  (`proposed_additions` / `proposed_removals`). Put those differences in your final answer so a human can review them in the episode page's
  "Cast roster" — the system never adopts them automatically and you may not work around it.
- After saving, the tool reconciles the roster against the cards that now exist for this episode and returns `missing_from_roster`
  (roster members that still have no card): if it is non-empty, **call `save_dedup_characters` again immediately** with exactly those people.
- Calling `save_dedup_characters` with no roster, or with a roster made stale by a script change, is rejected outright — not a single character is saved.
- When re-extracting a single asset (a human clicked "re-extract" on one existing card): completeness is judged for that person only, the rest of the roster is out of scope;
  that target is saved even if it is not on the roster (its fields were cleared when the run started, so refusing to save would leave the card blank),
  but you must state in your final answer that it is not on the roster so a human can decide whether to add it.

### Roster Decision Procedure (only when no usable roster exists; walk the script in order, mechanically, never from memory)

Read the script from its first line to its last. Every time you meet a **person who is named** (a proper name — not a group such as "soldiers" or "retainers"),
answer these three questions on the spot, in order; register them as soon as any one answer is "yes", and note which one it was:

1. **Decision**: does he make a decision, issue an order, sign an edict or a treaty in this episode?
2. **Action**: does he act in this episode — set out, lead a party, survey, negotiate, deliver, build?
3. **Firsthand experience**: does he live through this episode's events himself, with his situation or his reaction written into the script? (Being merely visible in the background is not enough.)

Skip him only when all three answers are "no" (people the narration merely mentions in passing with no decision and no action, and later historians and relayers of the account).
Unnamed groups (soldiers, retainers, prisoners, boatmen) are never registered — groups go into scenes and storyboards.
A monarch who only issues orders from afar and never appears on screen in this episode is registered under **decision**.

### One Person, One Roster Line (merge rule)

Merge before you register; all of the following are the same person and take **one** line: **transliteration variants** (Volkonsky / Wolkonski),
**aliases and short forms**, **title versus name** (when "the Governor of Siberia" and the man's own name are the same person, register the name),
**a parenthesised qualifier** ("Peter I (Tsar)" and "Peter I"). Use the spelling the script uses most often as the `name`.

- `name`: this is the name of the character card; use it verbatim again when saving. Do not write spaces or `@ / : * ? " < > |` (they are replaced by `_`).
- `basis`: the sentence (or passage) of the script that names him.
- `reason`: which clause — **decision / action / firsthand experience** — qualifies him, and which concrete act it was.

## Characters

**Who gets a character card (hard rule)**: every historical figure named in the narration who makes a **decision or takes action** in this episode's events gets a card —
including a monarch who only issues orders from afar and never appears on screen in this episode (such as the Qing emperor sending troops on the southern front at the same time).
No cards for: people merely mentioned in passing by the narration with no decision and no action, later historians and relayers of the account,
and unnamed groups (soldiers, retainers, prisoners, boatmen) — groups go into scenes and storyboards, they do not take a character card.
This rule is executed mechanically by the **roster decision procedure** above: once the roster exists, it alone defines who gets a card — no further judgement on the fly;
adding to or removing from the roster is done by a human in the episode page's "Cast roster".

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
