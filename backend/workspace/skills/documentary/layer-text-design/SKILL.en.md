---
name: layer-text-design
description: Template text-box specification for documentary shots and posters (Issue #96) — screen typography is only "role × layout × per-field capacity": fill role + fields, pick the layout from where the base image subject sits; replaces unanchored label / card in the design-card stage
---

# Template text boxes: role × layout × capacity

Layered on top of `documentary-storyboard`. It only covers **screen typography**: text drawn over the layer
segment that is not pinned to a position on the base image. Place names, routes and extents on a map still use
anchored annotations (`marker` / `label` with `anchor`) and are out of scope here.

## 1. You fill exactly two things: a role and its fields

- Every piece of screen text is one `planned_layers` entry `{ type: 'text', role, fields, at_s }`.
- `role` is copied verbatim from `text_spec.roles` returned by `read_storyboard_context`.
  `fields` keys are copied verbatim from that role's `fields[].key` (list fields take a string array).
- A shot that has text boxes must also set `layer_plan.text_layout`, copied verbatim from `text_spec.layouts[].id`.
- Never write `x/y`, font size, colour, font family or a plate; `card` is no longer accepted; `label` is only for
  text pinned to an annotated element (it must carry `anchor`).
- Read every limit from `text_spec.capacity[text_layout][role]`: `chars_per_line × max_lines` is that field's
  base capacity in this layout, list fields also have `max_items`; `chars_per_line_at_min` is only the fallback at
  the minimum scale — **never treat it as the normal capacity**. Do not estimate lengths from memory and do not
  reuse numbers from another layout or role.
- The same role may repeat across beats (two `heading`s at different times) but never twice inside one beat.

## 2. Role boundaries (pick by information type, confirm by capacity)

- `date` time anchor: one verifiable time coordinate ("207 BC November 14", "1872"). A reign title may accompany
  the Gregorian year. **Pure time goes only into `date`** — never enlarge a year, dynasty or period with `metric` or
  `keyword`. `sub` carries era context only.
- `heading` topic title: a noun phrase or a short verdict; `sub` gives place, category or passage and never repeats
  the title or the date.
- `statement` fact: one self-contained subject-predicate fact; `sub` carries the qualifier.
- `keyword` concept: one short concept (2–8 characters order of magnitude, capacity decides), only when the concept
  must be remembered; never to enlarge an ordinary sentence.
- `quote` quotation: original sentence, source text or question only; `main` keeps the paired quotation marks and
  `sub` gives a verifiable person, book or place. Explanations and summaries are not quotations.
- `metric` data: `main` holds only the number and the unit glued to it (never split the line); object, basis and
  comparison go into `sub`. Do not fake a chart ratio when there is no chart.
- `bullets` list: at most three items, fully parallel grammar, in time or logic order; do not mix in relational
  sentences with a different shape.
- Never on screen: unsourced exact years, long narration, emotional slogans, unverifiable details, or map place names.
- Posters have three extra roles (`poster_project` / `poster_title` / `poster_details`); they belong to poster
  conception and must not appear in a shot design card.

## 3. Writing rules (self-check before saving)

1. Only put on screen what helps the viewer grasp **time order, causality, scale, definition or the pictured
   subject**; details the narration already makes clear are not repeated.
2. Every line has a source: `info_points`, a verified fact, or something directly verifiable in the narration.
   Never invent numbers, dates or places.
3. A `statement.main` containing **two or more `、` / `；`** separators becomes `bullets` or several beats.
4. Different boxes in the same beat must not be identical or share **6 or more consecutive characters** — that blocks
   the card. The same repetition between boxes in adjacent beats is a warning and must be avoided as well. A time
   anchor may stay on screen; otherwise the next beat must add a new angle, change the phrasing, or leave the box empty.
5. When it does not fit, the only order is: **shorten → split the beat (different `at_s`) → switch to a better role**.
   Automatic shrinking is a fallback, never the normal capacity.
6. Numbers never split from their unit (year/month/day, stone, li, tonne, ℃ …); no punctuation at line start.
7. Prefer whitespace, another layout, or one line less over filling the frame with text.

## 4. Choosing the layout: read the base image first

`text_spec.layouts` lists this aspect's layouts; each has slots `{ role, zone }`. Zones mean:

- `context`: `date` only (the time anchor); it may share the beat with one primary box;
- `primary`: `heading` / `statement` / `quote` / `metric` / `bullets` — **mutually exclusive**, one per beat;
- `emphasis`: `keyword`, added only when the concept must land.

Before choosing, read the base image (`read_image` when needed) and note in the shot description: the face and
torso axis of the subject, the main axis of the building, the road or wall line, the chart plotting area, and the
empty areas.

- Subject on the right, space on the left → pick a left-hand layout; subject on the left → pick a right-hand layout.
- Subject centred with space above → pick a top/centre layout; chart or subject in the upper-middle/right-middle →
  pick the lower-left layout.
- Plates, gradients and decorations must never cover a face, the torso axis, the building body or the chart bbox.
- If you cannot tell where the subject sits, read the image; never fall back to a default layout.

## 5. Same-beat and rhythm rules

- A shot defaults to **one primary box per beat**; `date + primary` or `date + primary + keyword` are allowed.
- **A later box in the same zone replaces the earlier one**: a `heading` at 2 s is taken off screen when the
  `statement` at 4 s appears — that is one main narrative line. `date` lives in the `context` zone and is replaced
  only by a later time anchor; `keyword` behaves the same in `emphasis`. So several primary boxes of the same
  narrative line must use different `at_s` values.
- Boxes with the **same `at_s`** appear at the same instant and do not replace each other: two boxes in one zone
  at that instant are blocked — separate them in time or merge them into one line.
- The time anchor appears 0.3–0.8 s before the fact it frames; the title follows the key noun; facts, data and
  quotations appear when the narration says them.
- A single line needs roughly ≥1.2 s, a two-line statement roughly ≥2 s: put `at_s` on the measured voice-over
  timeline so that a later sentence's text never appears before the earlier one.
- `at_s` must not exceed this shot's `budget.layer_s`.

## 6. Submission flow

1. `read_storyboard_context`: read `text_spec` (`layouts` / `roles` / `capacity`), this shot's narration, the base
   image and the asset semantics.
2. Decide the information points this shot must deliver (`info_points`), then decide which of them become screen
   text, which the generated segment acts out, and which the narration alone carries.
3. Pick the layout per section 4, the roles per section 2, and write the fields per section 3 and `capacity`.
4. Run the self-checks of sections 3 and 5 (capacity, parallel lists, repetition, timing).
5. Call `update_storyboard` to save the whole design card. The tool re-checks the same rules; a rejection lists the
   per-field capacity numbers of that layout and role, so correct against those numbers and retry.

## 7. Failure handling

- Does not fit: shorten → split the beat → move to a wider layout → change the role. If all four fail, the
  information does not belong on screen: give it back to the narration or the generated segment.
- No usable slot (for example the subject fills the frame): do not force text; use an expression that needs no screen
  typography and say why in `rationale`.
- Missing fact, source or bbox: do not invent; cut down to what is verifiable, or drop the line.
- The tool reports text-box problems (`text_plan_issues`, overflow, missing field, same-beat conflict): fix the named
  field against the returned capacity and retry. Do not delete the text boxes back into `label` / `card` and do not
  route the information to the narration to sneak past the check.

## 8. Examples

Good:

- The base image has a figure on the right and open space on the left → pick the left-hand layout;
  `date.main = "1872"`, `heading.main = "轮船招商局创办"` (within capacity).
- Narration "条石为基、青砖包砌、顶宽五马并行" → three parallel `bullets.items`, not one crowded `statement.main`.
- The single number "5730 years" → `metric.main = "5730年"` with the basis in `sub`.

Bad:

- A `card` reading "序章", or an unanchored `label` as the screen title — the tool rejects it outright.
- `date.main = "同治十一年（1872年）·轮船招商局创办"` — the time anchor holds time only; the topic goes into `heading`.
- Two adjacent beats both saying "轮船招商局" — adjacent-beat repetition; the second beat needs new information.
- Copying a long stretch of narration into `statement.main` — shorten it first; if it still does not fit, split the beat.
- Two `heading` boxes in one beat — same slot, same beat.
