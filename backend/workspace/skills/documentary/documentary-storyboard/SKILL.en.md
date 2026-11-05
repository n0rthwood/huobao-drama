---
name: documentary-storyboard
description: Storyboard break-down addendum for documentary projects — two-column script (narration column copied verbatim / picture column describes only the picture), one information point per shot, the shot design card (info_points / layer_plan / gen_plan / budget), no dialogue-style writing
---

# Documentary Projects: Storyboard Break-down Addendum (two-column script + shot design card)

This is layered on top of the `storyboard-breaker` base specification; in case of conflict, **this file prevails**.

A documentary storyboard is a **two-column script**: the left column is narration (what is said), the right column is picture (what is seen). The two columns correspond one to one; within the same shot both must be about the same thing.

## 1. Narration column = the script body copied verbatim (hard rules)

In this project the script body **is the narration draft**. When breaking down into shots, cut the body into segments in order and write each segment **verbatim** into `narration_text`:

- **Copy word for word**: punctuation, years, personal names, place names and numbers all match the source exactly. No rewriting, no polishing, no abbreviating, no added words.
- **Cut at sentence boundaries**: you may cut only after a period / question mark / exclamation mark / semicolon; never break mid-sentence.
- **Add nothing, drop nothing**: every paragraph of the body must land in some shot; the concatenation of all shots' `narration_text`, in order, must equal the script body.
  `save_storyboards` returns `script_coverage.gaps` and `must_fix` each time: **as long as gaps remain, keep adding shots**,
  inserting new `shot_number`s at sentence boundaries and cutting the missed sentences in verbatim. Finishing with gaps outstanding fails the entire break-down task.
- Each shot is **≤80 characters** (a hard per-segment limit of the speech synthesizer). If a source paragraph exceeds 80 characters, split it into two adjacent shots at a sentence boundary.
- The tool validates this: each `narration_text` must be found verbatim in the script body, in the same order as the body; rewritten text is **rejected on save**.

### 1.1 Three rejection rules enforced by the server

Violating shots are not silently fixed — they are **rejected on save** and listed in `rejected[]` (with a reason). When you see `rejected[]`, rewrite per the reason and save again.

1. **Hard cap on the episode's shot count**: `cap = min(ceil(narration paragraph count × 1.5), narration paragraph count + 3)`,
   where "narration paragraph count" = the number of non-empty paragraphs obtained by splitting the script body on blank lines. Shots beyond `cap` are rejected.
   If you want finer cutting, merge adjacent short sentences instead of adding shots.
2. **Every shot must carry a piece of narration**: an empty `narration_text` is rejected. A documentary has no deliberately silent visual shot;
   empty scenes, transitions and map establishing shots must take a narration segment too.
3. **The same narration segment must not be claimed by two shots**: two shots claiming the same sentence (or overlapping) are rejected.

## 2. Picture column = `description` describes only the picture (hard rules)

- Do **not** write narration text in `description`, and do not write "Narration: ...". Narration has its own field; writing it twice means it gets read twice.
- A documentary has **no dialogue**: `CharacterName: "line"` is forbidden, and characters in the picture must not be shown speaking the narration.
- `description` states what the viewer actually sees: the subject, the action, changes within the frame (a map being unfolded, a column on the march, documents being leafed through).

## 3. One information point per shot

The boundaries of the break-down are determined by **information points**, not by duration: one shot makes one point clear, and cuts when the point is made.

Every shot states its main information point in one sentence in `title` ("额尔齐斯河 (the Irtysh) is the only waterway", "the Guards background decided command"),
and the same sentence becomes `design_card.info_points[0].text`. The picture must **be able to show that information point**.

If the information point and the picture do not match, **change the picture**, not the narration.

## 4. The shot design card `design_card` (required for every shot)

This is the biggest difference between documentary storyboards and drama storyboards: **work out how this shot is actually produced first, then write the picture**.
Before writing `description`, walk through the following chain and record the conclusions in `design_card`:

```
What information must this shot deliver (info_points[], ≤12)
  → which of it is drawn by the layer segment (layer_plan: base + must_mark[] + planned_layers[])
  → which of it is acted out by the generated segment (gen_plan: reference_assets[] + first/mid/last frames)
  → how many seconds each segment gets (budget: layer_s / gen_s)
  → why this arrangement (rationale, ≤600 characters)
```

### 4.1 `info_points[]`: what the shot delivers, each with its carrier

Each entry is `{ id, text, via }`, at most 12:

- `id`: a short identifier unique within the shot (`p1`, `p2`, ...), referable from `planned_layers` and `rationale`.
- `text`: one sentence stating the information ("the Dzungar range reaches Lake Balkhash").
- `via ∈ layer | generated | narration_only`:
  - `layer` — marked out on the base image by the layer segment (ranges, routes, places, name bars, years).
  - `generated` — acted out by the generated segment (setting out, marching, exchanging fire, an audience — events with a process).
  - `narration_only` — carried by the narration alone, the picture takes no part; use sparingly, too many of these means the picture is idle.

Every information point needs a carrier. Entries without one are flagged `info_point_unassigned` (warning).

### 4.2 `layer_plan`: the layer segment plan

- `base`: the base image of the layer segment. Either `{kind:'asset', asset_kind, asset_id, version_task_id}` pointing at a concrete version of an existing asset,
  or `{kind:'inherit_prev'}` to carry over the previous shot's base image (consecutive shots in the same narrative segment **should share the same evidence asset**,
  changing only the layer states: S01 shows the three-power ranges, S04 the rivers, S07 the route — not a different map per shot).
- `must_mark[]`: the semantic entries that must be marked on the base image, each `{ asset_id, semantic_id, name }`,
  copied **verbatim** from the `semantics` list returned by `read_storyboard_context` (`asset_id` + `id` + `name` must all match).
  Inventing a name yourself gets it marked `unresolved`, shown in red on the design-card page — as good as not writing it.
  Every place name / water system / lake / fortress / regime range / route in the narration should find its entry here;
  when the map truly lacks it, do not force it: state in `rationale` that "the narration mentions X, but asset N's annotations contain no X", and switch asset or hand it to the generated segment.
  If necessary, open the original with `read_image` to confirm whether it is really there.
- `planned_layers[]`: which layers to draw and in what order they appear. Each entry is
  `{ type, text?, anchor?: {asset_id, semantic_id, name}, at_s }`:
  - `type ∈ polygon | polyline | marker | label | card | image`
    (range highlight / river·route·arrow / place / place-name·year text / name bar·year card / embedded inset image).
  - `anchor` points at the same semantic entry as `must_mark`; text layers put the displayed text in `text`.
  - `at_s`: at which second within the layer segment the layer appears. Whatever the narration mentions first appears first;
    "simultaneously" / "in two columns" is expressed by **two layers at the same `at_s`**, "first ... then ..." by different `at_s`.
- Every `must_mark` entry should have at least one `planned_layers` layer drawing it; missing ones are flagged `must_mark_not_planned` (warning).
- A shot with a layer segment (combos A / C / D) must provide `base`, otherwise it blocks with `missing_base`.

### 4.3 `gen_plan`: the generated segment plan

- `reference_assets[]`: the reference assets the generated segment must use (`{kind, id, name}`, asset level).
  The prompt-writing step checks them one by one: a reference asset not referenced with `@name` blocks generation.
  For an organization / a person elsewhere / an event elsewhere that the narration mentions but that does not appear in this shot, use the visual carrier asset from `exposition_assets` of `read_storyboard_context`.
  Example: when the narration says "he came from the 谢苗诺夫近卫团 (Semyonovsky Guards), a regiment personally founded by 彼得一世 (Peter I)",
  the picture must simultaneously carry the Guards' visual carrier and Peter I's portrait — not one man standing in an empty parade ground.
- `first` / `mid` / `last`: one-sentence picture descriptions for the three slots (the formal prompts are written by a later step).
  The junction frame is inherited from the layer segment and locked, so **do not write it**: combo C omits `first`, combo D omits `last`.
- Do not use the generated segment to act out geographic relationships: a man walking in an empty field cannot express "sailing up the 额尔齐斯河 (Irtysh) northward" — that is the layer segment's job.

### 4.4 `suggested_combo`: you suggest, you do not decide

- You write only `suggested_combo ∈ A | B | C | D`. **Do not write `combo`**: the server ignores any `combo` the model sends;
  the segment combination must be chosen by a human. State in one sentence in `rationale` why you suggest it.
- Criteria for the four combinations (judge exactly by these):
  - **A** 「地图/原件上标注与推拉：讲『在哪里·是谁·哪一年』」 (annotate and push on a map / original: tell "where · who · which year")
  - **B** 「AI 生成镜头：讲『发生了什么』」 (an AI-generated shot: tell "what happened")
  - **C** 「先定位再入戏」 (locate first, then enter the scene)
  - **D** 「先入戏再落到地图/档案」 (enter the scene first, then land on the map / archive)
- A is layer segment ▣ only; B is generated segment ▶ only; C = layer segment ▣ → generated segment ▶; D = generated segment ▶ → layer segment ▣.
  The generated segment's first frame in C and its last frame in D is the **junction frame ◆**, inherited and locked from the adjacent layer-segment frame.

### 4.5 `budget`: how many seconds each segment gets

- `layer_s ≤ 30` and `gen_s ≤ 15` are hard caps; a design card exceeding them is **refused on write** by the server.
- Fill per the suggested combination: A writes only `layer_s` (`gen_s` null); B only `gen_s`; C / D write both.
- Their sum must be **≥ the narration estimate**: narration character count ÷ **4.5 characters/second** + **0.8 seconds** of tail padding.
  If it does not fit, split the narration into two adjacent shots at a sentence boundary; do not squeeze the budget.

### 4.6 `rationale`

≤600 characters, stating: why the information points are allocated this way, why this combination is suggested, what is carried over from the previous shot
("continuing the fleet already shown in the previous shot, this shot only marks the destination"), and any missing asset / missing annotation.

## 5. Duration and beats

- `duration` = `budget.layer_s` + `budget.gen_s` (a missing segment counts as 0), and must be ≥ the narration estimate
  (narration character count ÷ 4.5 characters/second + 0.8 seconds of tail padding).
- The per-segment caps are hard: layer segment ≤30 seconds, generated segment ≤15 seconds. If one shot cannot hold it, cut at a sentence boundary (mind the shot-count cap in §1.1).
- `【beat name】` markers in the script are hard cut boundaries: one shot must not span beats.
- Do not stuff two main information points into one shot to fill time, and do not split one sentence across two shots to be read.
