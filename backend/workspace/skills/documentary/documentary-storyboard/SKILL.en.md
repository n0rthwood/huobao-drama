---
name: documentary-storyboard
description: Storyboard addendum for documentary projects — two stages: (1) the narration skeleton (verbatim cutting, one information point per shot, no visual design at all); (2) the shot design card built on the MEASURED voice-over duration (info_points / layer_plan / gen_plan / budget); no dialogue-style writing
---

# Documentary Projects: Storyboard Addendum (narration skeleton → measured voice-over → design card)

This is layered on top of the `storyboard-breaker` base specification; in case of conflict, **this file prevails**.

A documentary break-down happens in **two consecutive stages**, separated by a real voice-over run:

```
final script body
  → [Stage 1] narration skeleton: cut verbatim into per-shot narration_text + title (save_storyboards)
  → human confirms the skeleton
  → batch TTS: every shot gets a MEASURED audio duration
  → [Stage 2] design card: info points / layer segment / generated segment / budget, planned on the measured duration (update_storyboard)
```

**Stage 1 never produces visual design**: without a measured duration, any segment budget is a guess.
**Stage 2 never edits narration text**: the narration boundaries were fixed in stage 1 and already voiced; changing a character invalidates the audio.

Which stage you are in is visible from the tools and the instruction: calling `save_storyboards` = stage 1;
an instruction asking you to fill the design card, with only `update_storyboard(storyboard_id, design_card)` allowed = stage 2.

---

# Stage 1: the narration skeleton

## 1.1 Narration column = the script body copied verbatim (hard rules)

In this project the script body **is the narration draft**. Cut the body into segments in order and write each segment **verbatim** into `narration_text`:

- **Copy word for word**: punctuation, years, personal names, place names and numbers all match the source exactly. No rewriting, no polishing, no abbreviating, no added words.
- **Cut at sentence boundaries**: you may cut only after a period / question mark / exclamation mark / semicolon; never break mid-sentence.
- **Add nothing, drop nothing**: every paragraph of the body must land in some shot; the concatenation of all shots' `narration_text`, in order, must equal the script body.
  `save_storyboards` returns `script_coverage.gaps` and `must_fix` each time: **as long as gaps remain, keep adding shots**,
  inserting new `shot_number`s at sentence boundaries and cutting the missed sentences in verbatim. Finishing with gaps outstanding fails the entire task.
- Each shot is **≤80 characters** (a hard per-segment limit of the speech synthesizer). If a source paragraph exceeds 80 characters, split it into two adjacent shots at a sentence boundary.
- The tool validates this: each `narration_text` must be found verbatim in the script body, in the same order as the body; rewritten text is **rejected on save**.

## 1.2 Three rejection rules enforced by the server

Violating shots are not silently fixed — they are **rejected on save** and listed in `rejected[]` (with a reason). When you see `rejected[]`, rewrite per the reason and save again.

1. **Hard cap on the episode's shot count**: `cap = max( min(ceil(narration paragraph count × 1.5), narration paragraph count + 3), sum over paragraphs of ceil(paragraph characters / 80) )`,
   where "narration paragraph count" = the number of non-empty paragraphs obtained by splitting the script body on blank lines. Shots beyond `cap` are rejected.
   When a long paragraph must be split across several shots to respect the 80-character limit, the cap rises accordingly (by character count only — it does not guarantee that a sentence-boundary split always fits).
   If you want finer cutting for pacing, merge adjacent short sentences instead of adding shots.
2. **Every shot must carry narration**: an empty `narration_text` is rejected. Documentaries have no silent picture-only shots;
   empty beats, transitions and map establishing shots all take a stretch of narration too.
3. **No stretch of narration may be claimed twice**: two shots taking the same sentence (or overlapping each other) are rejected.

## 1.3 This stage writes exactly four fields

The documentary schema of `save_storyboards` accepts only:

- `shot_number`: the shot number.
- `narration_text`: this shot's narration (verbatim, see 1.1).
- `title`: one sentence naming this shot's main information point ("the Irtysh is the only waterway", "his Guards background decided the command").
- `continuity`: `continue` / `cut`, the relation to the previous shot; omit it when unsure.

**Do not write design cards, picture descriptions, keyframe prompts, video prompts, durations or asset bindings** — all of those belong to
stage 2, and stage 2 only starts once this shot has actually been voiced and a measured duration exists. Any number of seconds you
could write now would be an estimate, and **this workflow does not accept estimates**.

## 1.4 One information point per shot

Shot boundaries are decided by **information points**, not by duration: one shot explains one thing, then cuts.
The sentence in `title` becomes `design_card.info_points[0].text` in stage 2.

If an information point and the picture do not match, **change the picture in stage 2** — never go back and change the narration.

---

# Stage 2: the design card, planned on the measured voice-over duration

## 2.1 Preconditions (enforced by the server, not bypassable)

- The episode's **narration skeleton has been confirmed by a human**;
- This shot **has currently valid audio**: text, pronunciation markup and the currently effective voice parameters all match the audio,
  the audio file exists, and a finite positive duration was measured from it.

The instruction states this shot's **measured voice-over duration in seconds**. That is a fact probed from the file, not a figure
estimated from the character count: **the budget must follow it**. The "4.5 spoken characters per second" estimate does not apply here.

## 2.2 The design card `design_card` (required for every shot)

Before writing picture content, walk this chain and record the conclusions in `design_card`:

```
which pieces of information the viewer must receive (info_points[], ≤12)
  → which of them the layer segment draws (layer_plan: base image, must_mark[], planned_layers[])
  → which of them the generated segment acts out (gen_plan: reference_assets[], first / mid / last frame descriptions)
  → how many seconds each segment takes (budget: layer_s / gen_s); their sum must be ≥ the measured voice-over duration
  → why it is arranged this way (rationale, ≤600 characters)
```

### 2.2.1 `info_points[]`: the information this shot delivers, each with an owner

Each entry `{ id, text, via }`, at most 12:

- `id`: a short identifier unique within this shot (`p1`, `p2`…), referenceable from `planned_layers` and `rationale`.
- `text`: one sentence stating the piece of information ("Dzungar control reached Lake Balkhash").
- `via ∈ layer | generated | narration_only`:
  - `layer` — marked on the base image by the layer segment (extents, routes, places, name bars, years).
  - `generated` — acted out by the generated segment (departures, marches, engagements, audiences: events with a process).
  - `narration_only` — carried by the narration alone, with no picture duty; use sparingly, too many of these means the picture is idle.

Every information point needs an owner. Entries without one are flagged `info_point_unassigned` (warning).

### 2.2.2 `layer_plan`: the layer segment plan

- `base`: the base image of the layer segment. Either `{kind:'asset', asset_kind, asset_id, version_task_id}` pointing at a concrete version
  of an existing asset, or `{kind:'inherit_prev'}` to continue the previous shot's base image (consecutive shots in the same narrative
  passage **should share one piece of evidence**, changing only the layer state: S01 shows the three extents, S04 the river, S07 the route,
  rather than a different map every shot).
- `must_mark[]`: the annotated elements this shot must mark on the base image, each `{ asset_id, semantic_id, name }`,
  **copied verbatim** from the `semantics` list returned by `read_storyboard_context` (`asset_id` + `id` + `name` must all match).
  Inventing a name gets it flagged `unresolved`, shown in red on the design card page — the same as not writing it.
  Every place, river, lake, fort, polity extent or route spoken in the narration should find a match here;
  when semantics are missing, preserve the planned annotation layer, leave its anchor semantic_id and name empty,
  and state in `rationale` that annotation is pending. Never invent an entry or downgrade the layer.
- `planned_layers[]`: which layers to draw and in which order they appear. Each entry
  `{ type, text?, anchor?: {asset_id, semantic_id, name}, at_s }`:
  - `type ∈ polygon | polyline | marker | label | card | image`
    (extent highlight / river·route·arrow / place / place-name·year text / name bar·year card / inset image).
  - `anchor` points at the same semantic entry as `must_mark`; text layers carry their text in `text`.
  - `at_s`: at which second inside the layer segment this layer appears. **Lay it out on the measured audio timeline**: whatever the narration
    says first appears first; "simultaneously" / "in two columns" is expressed by **two layers with the same `at_s`**, "first … then …" by
    different `at_s` values. `at_s` must not exceed this segment's `layer_s`.
- Every `must_mark` entry should be drawn by at least one `planned_layers` entry; missing ones are flagged `must_mark_not_planned` (warning).
- Shots that have a layer segment (combos A / C / D) must provide `base`, otherwise `missing_base` blocks.

### 2.2.3 `gen_plan`: the generated segment plan

- `reference_assets[]`: the assets the generated segment must use (`{kind, id, name}`, asset level).
  The prompt-writing stage checks them one by one: a reference asset not referenced with `@assetname` blocks generation.
  For organisations / distant people / distant events the narration mentions but that do not appear in this shot, use the visual carrier asset
  from `exposition_assets` in `read_storyboard_context`.
  Example: the narration says "he came from the Semyonovsky Guards, founded by Peter I himself" — the picture must show both the Guards'
  visual carrier and Peter I's portrait, not one man standing on an empty parade ground.
- `first` / `mid` / `last`: one-sentence picture descriptions for the three slots (formal prompts are written later).
  Junction frames are inherited and locked by the layer segment — **do not write them**: combo C omits `first`, combo D omits `last`.
- Do not use the generated segment to act out geography: a man walking on open ground cannot express "upstream along the Irtysh" — that is the
  layer segment's job.

### 2.2.4 Segment combination `combo`

- Write `combo ∈ A | B | C | D`; optionally also write `suggested_combo`. Existing choices are preserved for human review or modification.
  Explain the choice in one sentence in `rationale`.
- Criteria for the four combinations:
  - **A** "annotation and pans over a map / original document: telling where · who · which year"
  - **B** "AI-generated shot: telling what happened"
  - **C** "locate first, then enter the scene"
  - **D** "enter the scene first, then land on the map / archive"
- A has only the layer segment ▣; B only the generated segment ▶; C = layer ▣ → generated ▶; D = generated ▶ → layer ▣.
  The first frame of C's generated segment and the last frame of D's are **junction frames ◆**, inherited and locked from the adjacent layer frame.

### 2.2.5 `budget`: seconds per segment (driven by the measured audio)

- `layer_s ≤ 30`, `gen_s ≤ 15` are hard limits; a design card exceeding them is **refused on save**.
- Fill according to the suggested combination: A writes only `layer_s` (`gen_s` null); B only `gen_s`; C / D write both.
- **Their sum must be ≥ the measured voice-over seconds given in the instruction.** When it does not fit:
  - you may lengthen the picture, within the per-segment limits;
  - you may **never** truncate, compress or rewrite the narration to fit the budget — it has already been voiced, and changing a
    character invalidates the audio;
  - if it genuinely cannot fit (e.g. 40 measured seconds against the combination's limits), state the conflict in `rationale` so a human
    can go back to the skeleton stage and re-cut the shot.

### 2.2.6 `rationale`

≤600 characters covering: why the information points are split this way, why you suggest this combination, what it carries over from the
previous shot ("continuing the flotilla already shown, this shot only marks the destination"), and any missing asset / missing annotation /
budget conflict.

## 2.3 Picture discipline

- Picture descriptions **never contain narration text** and never "Narration: …". Narration has its own field; writing it twice makes it read twice.
- Documentaries have **no dialogue**: no `Name: "line"`, and never let a person in the picture speak the commentary.
- Describe what the viewer actually sees: the subject, the action, the change inside the shot (an unfolding map, a marching column, documents being turned).

## 2.4 Duration and beats

- This shot's duration = `budget.layer_s` + `budget.gen_s` (a missing segment counts as 0) and must be ≥ the measured voice-over duration.
- The per-segment limits are hard: layer segment ≤30 s, generated segment ≤15 s.
- `【beat name】` markers in the script are hard-cut boundaries: a shot may not span two beats (already enforced while cutting in stage 1).
- Do not cram two main information points into one shot to fill time, and do not split one sentence across two shots.
