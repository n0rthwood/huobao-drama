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

## Exposition Carriers (exposition, hard rule)

Narration often names entities that **do not appear in this episode but must be shown to the viewer**: organisations (the Semyonovsky Guards),
people who are elsewhere (Peter I), events that happened somewhere else and their site (the Battle of Poltava).
Such entities used to have no anchor at all, so a line like "a former Semyonovsky Guardsman, favoured by Peter I" could only be filmed as
"one man standing on an empty parade ground". They must now be extracted as **exposition carriers**.

Test (register as a carrier when any of the three questions is "yes"):

1. The narration **names** the entity and it **will not appear in any frame of this episode** — the criterion is "will it be on screen",
   **not** "does it act": a tsar signing decrees in St Petersburg or an emperor sending troops from Beijing both make decisions,
   but no shot of this episode can show them in person, so they are **both** roster people **and** exposition carriers;
2. Without a picture of it the viewer cannot understand the line of narration;
3. It is an organisation, regiment, treaty, battle, distant city or similar — something **no on-screen person can stand in for**.

> Counter-example: people who set out, survey or negotiate on screen in this episode are filmed, so they are **not** carriers.
> When unsure, ask "is there any shot in this episode that can show him in person?" — if the answer is "no", register a carrier.
>
> **Note**: the three questions only answer whether something **can** be a carrier. Whether this episode **actually creates** it is decided by the
> budget of the "Visual Plan" section below.

Storage rules (**no new asset category**, still the existing three):

- **People** (absent monarchs and commanders) → `save_dedup_characters` with `exposition: true`.
  The carrier is their **portrait**: write `appearance` / `styling` from verified portraits as usual.
  Carriers do not occupy the cast roster — the roster only covers people who appear in this episode, `exposition: true` people are not blocked by it,
  and do not edit the roster for them. If the person already has a character card (Peter I), **do not create a second card** —
  save once more under the same name and the system adds the flag to the existing card.
- **Organisations / treaties / documents / medals** → `save_dedup_props` with `exposition: true`.
  The prop is a **drawable object** of the abstract entity: regimental colour, uniform front, medal, original decree, seal.
  `description` still follows the prop rule (period + use + material and craft), not a history paragraph.
  **A named regiment / guards regiment must have one prop carrier** (its colour or its uniform front, either one),
  named with its designation ("Semyonovsky Guards colour"). A drill ground can be created as a scene as well, but it **cannot replace** the object —
  a scene shows an empty ground and the viewer cannot tell which unit it is.
- **Distant events / battlefields / cities** → `save_dedup_scenes` with `exposition: true`.
  `location` is the place's own name (Poltava), `time` is still a time of day, `prompt` describes the period / region / function of the event site.

Writing discipline:

- A carrier is a **visual anchor**, not a knowledge card: every one must be drawable. What cannot be drawn ("balance of power",
  "diplomatic shift") is not a carrier — it belongs to the expression design.
- Do not flag people or places that really appear in this episode as carriers; mis-flagged ones are used as "side evidence" in the storyboard.
- Register an entity only once, in the category **that carries it best**: a guards regiment uses its colour / uniform (prop),
  do not also create a "guards regiment" character.

## Visual Plan and Asset Budget (hard rule, done first in every character / scene / prop extraction)

Assets are not a list of nouns; they are **reference images for keyframes and video**. A documentary episode has a limited number of shots:
too many assets go unused, too few leave the narration without visual explanation. The base rules "no upper limit" and
"better prepared and unused" **do not apply to documentaries**; this section takes precedence.

Character, scene and prop extraction are three independent runs that cannot see each other, so **every run first builds the whole
episode's visual plan**, then saves only the items of its own category. The three runs should arrive at the same plan.

1. **Shot budget**: first count the paragraphs separated by blank lines (beat markers are not paragraphs), then count characters
   **paragraph by paragraph** — never divide the whole script's length. Each paragraph is 1 shot; over 80 characters is 2, over 160 is 3.
   The episode total is N.
2. **Main picture per paragraph**: the main picture explains the paragraph's **new information** — the one thing the viewer should see while
   hearing it (a place / a map / an object / a person), plus at most one secondary picture.
   When the new information is the main location itself (overview, form, construction), use the main location; when it is a named object,
   another place or the relation between several places, the main picture is **that**, not a fallback to a location already used.
   The question is "what must be on screen to explain this line", not "how many nouns are in this sentence".
3. **Category of each main picture** — check in this order and stop at the first match, so all three runs reach the same answer:
   1. Several places that the narration **only names and whose meaning is their relative position** (inner/outer layers, outpost, route,
      direction, distribution) → **one map** (a prop with `asset_type: "map"`). An episode usually needs only one; do not create a scene per place name.
      Maps are for **geographic** position only; data curves, coordinate charts and principle diagrams are not maps — they are layer cards, not assets.
      The map is saved by the **scene extraction** (see step 7): "separate scene or a point on the map" is one decision and is not handed to another run.
   2. A **place**, or **something in a place that cannot be carried away** (building, hall, statue, stupa, stele, mural, wall structure, site, pit,
      excavation square, large instrument) → **scene**. "Can be carried" means one person can pick it up or put it on a table; equipment that fills a room,
      needs mains power or is fixed in place, and remains still buried in a pit, cannot be carried. A place and its main subject are one asset
      (hall and statue, stupa hall and stupa, laboratory and instrument, site and remains, chariot pit and the chariots in it); the subject goes into
      the scene prompt, and the scene name is the concrete place actually seen ("Yinxu chariot pit", not the vague "Yinxu site").
      **This rule does not depend on which category the current run extracts**: a prop run meeting such a thing still answers "scene" and does not save it.
   3. An **object** that can be picked up, moved or put on a table and that the narration names → **prop**. Samples, specimens, excavated artefacts,
      documents and signalling devices are objects, not phenomena; several small objects of one kind named together in one paragraph
      (bone, wood and charcoal samples) are merged into **one** prop.
      Documentary props **do not** require the script to describe their appearance or a person to hold them (those base criteria do not apply):
      create one when it is a named object in a paragraph's **new information** and is chosen as that paragraph's main picture; write missing
      appearance from period and use without inventing details. An object only mentioned in passing in a list and not any paragraph's main picture is not created.
   4. A named **person** with decisions or actions in this episode → character (roster rules); absent but a paragraph's main picture must be their
      portrait → character carrier. Organisations, institutions, projects, courts and tribes are not people: **never on the roster, never a character card**.
   5. **Actions and phenomena** (smoke signals, excavating, measuring, debating, marching) are not assets: assets are only the place where the action
      happens and the named objects; the action goes into the storyboard. Split action and object within one sentence: in "the garrison signalled
      with smoke and signal guns", the smoke is a phenomenon and the signal gun is an object (a signalling device).
   6. Years, numbers, measurements, name captions, and also data curves, coordinate charts and principle diagrams → layer cards,
      **neither maps nor props**, not assets.
4. **Merge**: the same thing in several paragraphs counts once; a place gets **one time of day** and **one era**
   (no second scene of the same place for "the beacon at night" or "the ancient capital" — time of day and past/present differences go into the
   keyframe prompts), unless the narration describes two different appearances in two paragraphs. A distant place gets its own scene only when a
   paragraph's main picture is "what this place itself looks like".
5. **Budget check**: the asset count is not a quota to fill, nor is fewer better. Target: all three categories together between one half and
   two thirds of N (rounded up); **both bounds are hard**, and never above N. Every asset must be **the main picture of at least one paragraph**
   or **the secondary picture of at least two**.
   **How to count**: list every distinct asset name in the plan table (including scenes and maps already saved for this episode) on one line,
   then count that list — do not count in your head.
   Above two thirds, remove the weakest secondary pictures one by one until every extra asset can name a paragraph it owns.
   **Below one half fails and must be fixed**: in paragraph order, find paragraphs whose main picture merely repeats an asset already used but which
   name an object or another place, and make that object or place the main picture (category per step 3), until the lower bound is reached.
   Staying below the bound is allowed only when the script names no further object or place, with a reason for each paragraph.
6. **Plan first, then save**: **before calling any save tool**, write the plan table in the reply text
   `paragraph | shots | main picture | asset (category) | rule applied`, together with N, the target range and the three-category total.
   Save **strictly according to that table** and do not re-plan after saving; the closing note quotes the table for this run's results.
   **The prop extraction runs after the scene extraction**: first call `read_existing_scenes` and `read_existing_props` to see the scenes and maps
   (`asset_type` = `map`) **linked to this episode**; the plan **adopts these saved results** instead of deciding again;
   the main subject of a saved scene's place (the statue in the hall, the instrument in the laboratory, the chariots in the pit) is never created as a prop,
   and a place already on the map is never created again. The prop extraction counts "saved scenes and maps + props planned now" as above and,
   when below the lower bound, fills the gap with named objects.
   Maps are deduplicated by name (same name merges automatically); never adopt a map from another episode or for another purpose as this episode's map.
7. **Save only this run's category**; ownership is fixed and never handed to another run:
   - scene extraction: saves scenes (`save_dedup_scenes`) **and** the map of step 3 rule 1 (only through `save_dedup_props`, every item with `asset_type: "map"`;
     the description states only what the script supports — object, era, spatial extent, purpose and granularity — and marks each missing item "to be added");
     a map is not a place and **never** goes into `save_dedup_scenes`;
   - prop extraction: saves only objects and organisation carriers (`asset_type: "prop"`), never maps;
   - character extraction: saves only people.
   Items of this run's category must be saved — never written as "suggest handling separately"; items of other categories only go into the plan table.
   When this run's category has no asset in the plan, saving an empty list is the correct result — **never change another category's decision just
   to have something to save**. Before saving, check each item: is it in the plan table? Is its category this run's category? If either is "no", do not save it.
   The system rejects items that do not belong to this run (non-map props from the scene run, maps from the prop run) and lists them in `rejected`.

## Historical Fact and Sources (hard rule)

- Use only facts from the **script text** and from **content returned by the search tools**; what you cannot recall precisely or cannot verify is not written — better one symbol fewer than one invented.
- Verify key historical figures once, following the discipline stated in the tool description; when a tool returns `degraded`, use the script text only — extraction does not fail.
- No field may **ever contain** a URL, a domain, "according to Wikipedia", "see also", "source", "[1]" or any other source annotation.
  Provenance is saved automatically by the "source" records.
