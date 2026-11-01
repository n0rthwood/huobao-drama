---
name: documentary-character-prompt
description: Character final-prompt addendum for documentary / historical subjects — the three-view layout never changes, identity is expressed by what is worn and carried, period accuracy, faithfulness to archival portrait features
---

# Documentary / Historical Subjects: Character Final-Prompt Addendum

This skill is injected only when the project subject is judged to be documentary / historical, and is layered on top of `character-prompt`. **Not one word of the layout rules changes**; this file only specifies what to write inside that layout.

## 1. The Layout Is Immutable (highest priority)

Whatever the subject, the character final prompt must still be:

```
character turnaround reference sheet, a front close-up on the left, and on the right three equal-height full-body views — front, 90-degree profile and back — side by side, … pure white background, soft even light, cinematic quality
```

- It **must not** be turned into a single film still, a bust portrait, an environmental portrait or a historical oil-painting reproduction;
- None of "front close-up", "three equal-height full-body views", "pure white background" may be **omitted**;
- A historical subject is no reason to abandon the reference-sheet layout — a documentary needs a visual anchor just as much.

## 2. Identity May Only Be Expressed by What Is Worn and Carried

Because the background must be pure white, it is **forbidden** to express identity with any environmental element:

- Forbidden: palaces, thrones, battlefields, fleets, maps, banners, drapery, desks, ceremonial processions, architectural silhouettes, scene lighting effects;
- Allowed and required in full detail: crown / headgear / braid form, sashes and orders, cuirass and military dress, court robes and rank badges, robe patterns, belt and sword, sceptre, seals and documents — symbols **worn on the body or held in the hand**.

Every identity symbol recorded in `styling` must **land item by item in the clothing / accessories part of the prompt**; it may not be summarised as "magnificent clothing".

## 3. Period Accuracy

- **The clothing part must carry period qualifiers** (hard rule): write "early-18th-century Russian dark green military coat" rather than "dark green stand-collar officer's long dress coat",
  write "Kangxi-era bright yellow satin court robe" rather than "bright yellow dragon robe". Without a period qualifier the model paints the later, more common form —
  round-2 measurement: the sample with period qualifiers (Peter I) passed blind review with no anachronistic items, while the one without (Likharev) was judged
  "the cut and the curved-hilt sabre belong to 1780–1800". Every coat, hat, boot and carried weapon needs its own period qualifier; writing the period once at the start is not enough.
- Hairstyle, beard shape and accessory forms must match the period given in `description`;
- No element later than that period (modern glasses, zippers, wristwatches, industrial prints, modern military tailoring, later-style sword guards);
- Symbols of different civilisations must not be mixed (a Qing court robe does not get a European sash, and vice versa).

## 4. Faithfulness to Archival Portraits (at text level)

When `read_characters` returns `has_archival_reference: true`, the character already has an archival portrait on file, and its visible features have been turned into text by the extraction step inside `appearance` / `styling`:

- Face shape, hairline, hairstyle, moustache shape, whether a beard is worn, and salient facial features **follow the `appearance` text strictly** — no beautifying, no rejuvenating, no changing the hairstyle, no improvising;
- Do not carry the painting's oil brushwork, frame, background or bust composition into the prompt — **what is faithful is the person, not that painting**;
- The portrait itself does not take part in image generation; do not mention "oil painting", "portrait" or "reference painting" in the prompt.

## 5. No Source Pollution

The prompt must not contain a URL, a domain, "according to Wikipedia", "source" or any other source annotation or citation format.

## 6. Self-check (confirm item by item before saving)

1. Contains all four elements: "character turnaround reference sheet / front close-up / three equal-height full-body views / pure white background";
2. At least 2 wearable or carryable identity symbols, consistent with `styling`;
3. No scene, background, environment or prop-tabletop element whatsoever;
4. No item later than the period;
5. No URL and no source annotation.
