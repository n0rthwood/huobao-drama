---
name: documentary-storyboard
description: Storyboard break-down addendum for documentary projects — two-column script (narration column copied verbatim / picture column describes only the picture), one information point per shot, expression design (device / must_show / overlay_plan), no dialogue-style writing
---

# Documentary Projects: Storyboard Break-down Addendum (two-column script + expression design)

This is layered on top of the `storyboard-breaker` base specification; in case of conflict, **this file prevails**.

A documentary storyboard is a **two-column script**: the left column is narration (what is said), the right column is picture (what is seen). The two columns correspond one to one; within the same shot both must be about the same thing.

## 1. Narration column = the script body copied verbatim (hard rules)

In this project the script body **is the narration draft**. When breaking down into shots, cut the body into segments in order and write each segment **verbatim** into `narration_text`:

- **Copy word for word**: punctuation, years, personal names, place names and numbers all match the source exactly. No rewriting, no polishing, no abbreviating, no added words.
- **Cut at sentence boundaries**: you may cut only after a period / question mark / exclamation mark / semicolon; never break mid-sentence.
- **Add nothing, drop nothing**: every paragraph of the body must land in some shot; the concatenation of all shots' `narration_text`, in order, must equal the script body.
- Each shot is **≤80 characters** (a hard per-segment limit of the speech synthesizer). If a source paragraph exceeds 80 characters, split it into two adjacent shots at a sentence boundary.
- Picture-only shots (empty scenes, transitions, map establishing shots) may have no narration: leave `narration_text` empty; do not invent a narration line for them.
- The tool validates this: each `narration_text` must be found verbatim in the script body, in the same order as the body; rewritten text is **rejected on save**.

## 2. Picture column = `description` describes only the picture (hard rules)

- Do **not** write narration text in `description`, and do not write "Narration: ...". Narration has its own field; writing it twice means it gets read twice.
- A documentary has **no dialogue**: `CharacterName: "line"` is forbidden, and characters in the picture must not be shown speaking the narration.
- `description` states what the viewer actually sees: the subject, the action, changes within the frame (a map being unfolded, a column on the march, documents being leafed through).

## 3. One information point per shot

The boundaries of the break-down are determined by **information points**, not by duration: one shot makes one point clear, and cuts when the point is made.

Every shot states its information point in one sentence in `title` ("额尔齐斯河 (the Irtysh) is the only waterway", "the Guards background decided command"),
and the same sentence goes into `intent.info_point`. The picture must **be able to show that information point**.

If the information point and the picture do not match, **change the picture**, not the narration.

## 4. Expression design `intent` (required for every shot)

This is the biggest difference between documentary storyboards and drama storyboards: **decide how to express first, then write the picture**.
Before writing `description`, walk through the following chain and record the conclusions in `intent`:

```
What must the viewer understand from this shot (info_point, exactly one)
  → by what means to express it (device)
  → what concrete things must therefore be visible in the picture (must_show)
  → which layers draw those things, and in what order they appear (overlay_plan)
  → why these choices (rationale)
```

### 4.1 `device`: five expression devices, chosen by the nature of the narration

| device | applied to what kind of narration | what the picture is |
|---|---|---|
| `map_anim` | geography, routes, ranges, two simultaneous storylines | evidence map + highlights/arrows/labels appearing layer by layer |
| `archival` | treaties, documents, prints, original artifacts | the archival original itself + slow push-in + labels |
| `card` | a person's first appearance, years, chapter turns | portrait / still frame + name bar (name / title / years) |
| `reenact_still` | static states, scenes, objects | generated reenactment still + slow push-in |
| `reenact_video` | events with process, with motion | generated model video |

Criterion: **does the narration say "where" or "what happened"**. Anything saying "where / how wide a range / which route" is always `map_anim`;
"such-and-such a year such a person did such a thing" is `reenact_video` only when the action must actually be visible in the picture; identity, origins, or numbers alone use `card` or `archival`.

Do not use `reenact_*` to act out geographic relationships: a man walking in an empty field cannot express "sailing up the 额尔齐斯河 (Irtysh) northward".

### 4.2 `must_show`: every concrete noun in the narration must land on the picture

- Every **place name / water system / lake / fortress / regime range / route** appearing in the narration must be found in the
  **semantic annotations** (`props[].semantics` of `read_storyboard_context`) of some evidence asset, and written into `must_show`:
  - region → `{kind:'region', asset_id, semantic:'准噶尔汗国'}`
  - river / boundary / route lines → `{kind:'line', asset_id, semantic:'额尔齐斯河'}`
  - city / place → `{kind:'point'|'label', asset_id, semantic:'斋桑湖'}`
  - march route → `{kind:'route', asset_id, from:'西宁', to:'拉萨'}` (both ends must be place names already annotated on that map)
- `semantic` must be taken **verbatim** from the `name` in the `semantics` list (or its `id`). Inventing a name yourself gets it marked
  `unresolved`, shown in red on the expression-design page — as good as not writing it.
- When the map **does not** have that item, do not force it: state in `rationale` that "the narration mentions X, but asset N's annotations contain no X",
  and downgrade the shot (change device or change asset). If necessary, open the original with `read_image` to confirm whether it is really there.
- **First appearance of a person** → `device='card'`, `must_show` carries `{kind:'portrait', asset_id:<character id>}`,
  and `overlay_plan` holds a `card` layer (fields: name / title / years).
- **Organizations mentioned but not appearing in this shot / people elsewhere / events elsewhere** → reference the
  `exposition_assets` of `read_storyboard_context`: `{kind:'exposition', asset_id:<that carrier asset>}`.
  Example: when the narration says "he came from the 谢苗诺夫近卫团 (Semyonovsky Guards), a regiment personally founded by 彼得一世 (Peter I)",
  the picture must simultaneously carry the Guards' visual carrier and Peter I's portrait — not one man standing in an empty parade ground.

### 4.3 `overlay_plan`: the overlay layers of map shots must not be empty

- When `device='map_anim'`, `overlay_plan` **must be non-empty**. Flatly pushing and panning a map is not a map animation —
  that is exactly the error this project aims to eliminate.
- Layer types may only be `polygon` (range highlight), `polyline` (river / route / arrow), `marker` (place),
  `label` (place-name / year text), `card` (name bar / year card), `image` (embedded inset image).
- Each layer should carry `anchor:{asset_id, semantic_id}` (pointing at the same semantic entry as `must_show`),
  then use `reveal_at` (seconds) to order the appearances: whichever the narration mentions first appears first.
- Parallel relations like "simultaneously" or "in two columns" are expressed by **two layers appearing at the same moment**; "first ... then ..." is separated by `reveal_at`.
- When the view must push from the whole map to a detail, use `viewport:[x,y,w,h]` (normalized 0–1).

### 4.4 `deterministic`: do not set your own defaults

Clip position is decided by the program looking up a table by device (`map_anim/archival/card/reenact_still` → `replace`,
`reenact_video` → `none`). Only `reenact_video` lets you suggest `pre`/`post` (splicing a short deterministic clip
before/after the model video). In all other cases **do not write this field**; out-of-scope values are dropped by the server and fall back to the default.

### 4.5 Narrative-segment context

- When calling `read_storyboard_context`, also read the neighboring shots' `intent`. Shots within the same narrative segment (consecutive shots on the same base map)
  must **share the same evidence asset**, changing only the layer states: S01 shows the three-power ranges, S04 the rivers, S07 the route —
  not a different map per shot.
- When a later shot continues the previous one, state in `rationale` what is being continued ("continuing the fleet already shown in the previous shot, this shot only marks the destination").

## 5. Duration and beats

- `duration` = narration character count of the shot ÷ **4.5 characters/second** + **0.8 seconds** of tail padding, clamped to **4–15 seconds**; picture-only shots without narration take 4–6 seconds.
- `【beat name】` markers in the script are hard cut boundaries: one shot must not span beats.
- Do not stuff two information points into one shot to fill time, and do not split one sentence across two shots to be read.
