---
name: documentary-keyframe-prompt
description: Keyframe/video prompt addendum for documentary projects — branch by the design card's segment combination, must @-reference every gen_plan.reference_assets entry, continuing the previous shot is allowed
---

# Documentary Projects: Keyframe & Video Prompt Addendum (branch by the segment combination `combo`)

This is layered on top of `prompt-generator/keyframe-prompt` and `prompt-generator/video-prompt`; in case of conflict, **this file prevails**.

Every shot of a documentary carries a shot design card `design_card` (information points / layer-segment plan / generated-segment plan / budget) and a segment combination `combo` chosen by a human.
Read them before writing the prompt: **the prompt executes the design card; it is not a fresh creative decision**.

## 1. Look at `combo` first, then decide what to write

| `combo` | keyframe prompt | video prompt |
|---|---|---|
| `A` (layer segment ▣ only) | **do not write**. The whole shot is rendered by the layer segment (base image = `layer_plan.base` + planned layers) | **do not write** |
| `B` (generated segment ▶ only) | write: first / mid / last slots per the regular keyframe specification | write: per the regular video prompt specification |
| `C` (layer segment ▣ → generated segment ▶) | the first frame is the **junction frame ◆** (inherited from the layer segment's last frame, locked, not generated): **do not write `first_frame_prompt`**; write mid and last as usual | write |
| `D` (generated segment ▶ → layer segment ▣) | the last frame is the **junction frame ◆** (inherited from the layer segment's first frame, locked, not generated): **do not write `last_frame_prompt`**; write first and mid as usual | write |

Batch tasks already filter the pending shots and slots by this table; if you still receive a request for an `A` shot or for a junction-frame slot,
its design card / segment combination is not finished — do not invent a diffusion prompt for it out of thin air.

## 2. `gen_plan.reference_assets` is a hard constraint: every item must be @-referenced

When a generated segment exists (`combo` is `B` / `C` / `D`), every asset in `design_card.gen_plan.reference_assets`
(portrait, background information carrier) must be referenced with `@资产名`/`@name` in the prompt you write.

- The server checks one by one: a reference asset not @-referenced by that prompt → consistency issue `card_ref_unmet` (**blocking** generation),
  judged separately for the first/mid/last three prompts.
- Do not substitute a textual description for the @: writing "a Guards officer standing beside him" does not send that reference image to the image model;
  you must write `@谢苗诺夫近卫团`.
- When one shot must express two entities at once (a person + the organization he belongs to), @ both, and state their spatial relationship in the frame
  (who is in the foreground, who is in the background / inset / a print on the wall).

`layer_plan.must_mark` holds **semantic entries** (place names, ranges, routes) drawn by the layer segment; **do not put them in the prompt**.
Only the semantic entries are excluded: if their asset also appears in `gen_plan.reference_assets`, it must still be @-referenced.

## 3. All text goes to layers; write no text in the prompt

- Name bars, years, place-name labels, route annotations are **all layers of the layer segment** (`layer_plan.planned_layers`), rendered by the program.
- **Never** write "the picture shows ...", "titled ...", "subtitle ..." in a prompt — diffusion models draw garbled text,
  and the style preset itself already carries `no lettering`.
- When the frame must leave room for a name bar (e.g. the person offset to the left third of the composition, the lower right left empty), just write that composition — but do not draw the name bar yourself.

## 4. Continuing the previous shot is allowed (the documentary-branch exception)

The base `keyframe-prompt` specification requires every frame to be independent and forbids continuation. **Documentary projects lift that ban**:

- The batch task's message carries the neighboring shots' design cards and picture descriptions. Consecutive shots within the same narrative segment
  (the same place, the same people, different stages of the same event) **should** carry over the same spatial relationships and viewpoint,
  instead of each writing its own (the "destination of the fleet" shot must continue the fleet already shown in the previous shot).
- The way to continue is still a **self-contained description**: **rewrite the carried-over content in full** (the same river reach, the same fleet, the same camera orientation),
  not "same as the previous frame" or "keep unchanged" — the latter carries no information for single-frame image generation.
- Continue only when there is a real continuation; hard cuts (change of place, change of era) remain independent as before.

## 5. Base rules that still apply

- **Absolute image first**: do not write a character's species, clothing, colors, hairstyle, or build; characters are always referenced only by `@角色名`/`@name`.
- Each prompt is self-contained: shot size, camera position, composition, lighting, and atmosphere must all be stated by the prompt itself.
- Leave `first_frame_prompt` empty when `inherits_first=true`; `mid_frame_time` falls between 0.5 and the generated segment's duration `-0.5`.
