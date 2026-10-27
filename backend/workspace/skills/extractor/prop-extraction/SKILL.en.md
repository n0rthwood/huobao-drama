---
name: prop-extraction
description: Prop decision criteria, the enumeration of must-extract categories, and how to write descriptions — guaranteeing an object stays visually consistent across shots
---

# Prop Extraction Details

## Why Extract Props

Without prop assets, a storyboard prompt that mentions an object can only describe it in plain text, and the object's look gets reinvented in every frame (three different dumbbell designs in one shot, a newspaper whose layout changes every frame — both have actually happened). The prop image is the only anchor that keeps an object consistent across shots.

## Decision Criteria (extract if any one is met)

1. **The script explicitly describes how it looks** (spends half a sentence or more on its appearance)
2. **A character picks it up, uses it, wears it, puts it on or takes it off** (holding, using, wearing, handing over)
3. **A character stands on it, sits on it, or looks into it** (interactable large furnishings such as yoga mats, training mats, full-length mirrors)
4. **It appears in more than two shots, or gets a close-up**
5. It belongs to the "must-extract categories" below

**There is no quantity limit.** The extraction layer only cares about "does this object need a fixed appearance"; how many reference images each shot uses is decided by the storyboard layer within its budget of 9. Better to have it and not use it than to need it and not have it.

## Must-Extract Categories (explicit enumeration)

| Category | Examples | Requirement |
|---|---|---|
| Sports equipment | Dumbbells, yoga mats, training mats, ski helmets, sleds, snowboards, ski poles | Extract as soon as the script mentions them; a pair (two dumbbells) counts as one prop, and a name like "Mini Dumbbells (pair)" is not acceptable — use "Mini Dumbbell" and state in the description that there are "two of them, a pair, completely identical" |
| Worn accessories | Glasses, sunglasses, hats (Panama hat, etc.), helmets, scarves, watches | Anything that can be put on and taken off separately counts as a prop (even if the character wears it throughout); **a complete outfit is not a prop** — snow gear, vacation sets and other full-body clothing go through the character's "styling version", see the extractor skill |
| Everyday objects | Cups, teacups, books, notebooks, pencils, homework books, newspapers, remote controls, phones | Extract as long as a character uses it or it is clearly visible on screen; there is no "everyday items are exempt" rule |
| Interactable large furnishings | Full-length mirrors, yoga mats, training mats, children's seats | Large items a character stands on / sits on / looks into are taken out of the scene and made into props; pure background furniture (fixed tables and chairs, lamps, doors and windows, wall paintings) still belongs to the scene |

## When Not to Extract

- Pure background furnishings: fixed furniture and decoration nobody touches, that is not described and never gets a close-up (they belong to the scene prompt)
- Objects mentioned once and never visible on screen (things only talked about in dialogue)

## Naming Rules

- 2-6 characters, matching the script's wording (if the script says "Panama hat", call it "Panama hat", do not rename it "straw hat")
- No parentheses, no aliases, no episode numbers; the same object across episodes keeps the same name and reuses the existing prop
- The name is matched exactly by the storyboard via `@prop name` (longest match wins), so it must be stable and unambiguous

## How to Write `description` (definiteness requirement)

Write only the object's own physical appearance, item by item: **material, colour, shape, size (relative to the character's palm / body), how new or old it is, marks of wear**.

- No "or", "possibly", "about": lock the colour and style down once
- No plot usage or ownership ("Gini's dumbbell", "used for working out" — neither belongs)
- Relative size matters: write executable ratios such as "the bar is about twice the length of a guinea pig's front paw" to stop the prop from ballooning in close-ups
- For paired objects, state "two of them, a pair, completely identical"

Props **do not need an image prompt** — the final white-background single-item prompt is produced by the prompt-generation Agent following the prop-prompt skill.

## Saving

Call `save_dedup_props` to save and automatically link to the current episode; if there really are no props, pass an empty array — do not pad the list.
