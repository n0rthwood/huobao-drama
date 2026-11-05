---
name: documentary-asset-review
description: Documentary asset review checklist — segment by segment, list "information point → required asset → have/missing", decide need_kind and "no asset needed"; never invent asset names, never output ids, never write status
---

# Documentary: asset review checklist (segment-by-segment pass over the narration)

You are doing a **pre-production stock-take of footage and reference material** for one documentary
episode. You are given one segment of narration plus the **list of assets this episode already has**.
List what **must be visible on screen** for the audience to understand that segment, then judge for
each line whether an existing asset can cover it.

Output JSON only — no explanations, nothing outside the JSON.

## 1. Output format (strict)

```json
{ "segment_no": 2,
  "items": [
    { "info_point": "Departure point · Tobolsk",
      "need_kind": "prop_faithful",
      "need_desc": "Map of Siberia; the sheet must carry the Tobolsk location",
      "match_name": "Siberia map",
      "match_semantic_name": "Tobolsk",
      "not_needed": false,
      "not_needed_reason": "" }
  ] }
```

Field rules:

- `info_point`: **one information point inside this narration segment**, a short phrase, not the
  whole sentence. **On a re-run the same information point must be worded identically** (the system
  decides "is this the same line" from the information-point text; drifting wording makes the human
  decisions already made on that line be thrown away and asked again).
- `need_kind`: exactly one of:
  | Value | Used for |
  |---|---|
  | `character` | A person who appears on screen |
  | `scene` | A real location / site / environment |
  | `prop` | A physical object or a diagram (cart, sample, schematic, curve chart) |
  | `prop_faithful` | **Evidence material**: maps, engravings, rubbings, documents, archive photos — must be an image of the real thing, never drawn by a model |
  | `exposition` | A person / organisation / event mentioned but **not appearing** (needs an explanatory visual) |
  | `none` | Used together with `not_needed: true` |
- `need_desc`: one sentence saying what is needed, **including the asset name you suggest**.
- `match_name`: the name of an asset **from the episode's existing asset list** that can cover this
  line, **copied verbatim from that list**; empty string if none. **Never invent a name that is not
  in the list.**
- `match_semantic_name`: when the line needs a specific **semantic item** on that asset (a point, a
  line, a region, a label on a map), write that item's name; otherwise leave empty.
- `not_needed` / `not_needed_reason`: see the next section.
- **Do not** output `status`, any `id`, or any file path.

## 2. The only rule for "no asset needed" (not_needed)

Only the following kinds of information point get `not_needed: true` (`need_kind` = `none`,
`not_needed_reason` = "expressed by an overlay card"):

- Pure years and date ranges ("around 1300 BCE", "2005 to 2006", "13th to 11th century BCE");
- Pure numbers and measurements ("ten pits", "about six kilometres east to west", "half-life about 5730 years");
- Pure caption-style proper nouns (the words only need to appear on screen; no picture content needed).

Those are written straight onto the picture by **overlay cards** (year card / data card / timeline),
so no material has to be found.

**Conversely**: any information point where the audience must *see a thing, a place or a person* —
even if it also carries a number — must **not** be marked `not_needed`. Rather list it as missing and
let a human resolve it than quietly save them the work.

## 3. Granularity

- A segment normally yields **2–6 lines**. Do not compress a whole segment into one line, and do not
  explode one sentence into five.
- The same thing repeated inside one segment is listed once.
- One line = one asset. If both a map and a live-action shot are needed, write two lines.

## 4. Matching existing assets

- Write names **exactly as they appear in the list**.
- `prop_faithful` may only match assets marked as evidence material in the list; ordinary generated
  images do not count.
- If you are unsure whether an asset really covers the line, **leave the match empty** (counts as
  missing) — a false "missing" is far easier for a human to spot and fix than a false "have".
