---
name: documentary-keyframe-prompt
description: Keyframe/video prompt addendum for documentary projects — branch by the expression design's device, must cover every must_show item, continuing the previous shot is allowed
---

# Documentary Projects: Keyframe & Video Prompt Addendum (branch by device)

This is layered on top of `prompt-generator/keyframe-prompt` and `prompt-generator/video-prompt`; in case of conflict, **this file prevails**.

Every shot of a documentary carries an expression design `intent` (information point / device / must_show / overlay_plan).
Read it before writing the prompt: **the prompt executes the expression design; it is not a fresh creative decision**.

## 1. Look at `device` first, then decide what to write

| `intent.device` | keyframe prompt | video prompt |
|---|---|---|
| `map_anim` | **do not write**. The whole shot is rendered by the deterministic clip (base image = the evidence map original + overlay layers) | do not write |
| `archival` | **do not write**. The whole shot is rendered by the deterministic clip (base image = the archival original + slow push-in) | do not write |
| `card` | write: base image = the portrait asset image or a reenactment still. The name bar is a **layer**; write no text in the prompt | do not write |
| `reenact_still` | write: per the regular keyframe specification | do not write |
| `reenact_video` | write: per the regular keyframe specification | write: per the regular video prompt specification |

Batch tasks already filter the pending shots by this table; if you still receive a request for a `map_anim`/`archival` shot,
its `intent` is not finished — do not invent a diffusion prompt for it out of thin air.

## 2. `must_show` is a hard constraint: every item must be @-referenced

When `device` is `reenact_still` / `reenact_video`, every entry with an `asset_id` in `intent.must_show`
(portrait, background information carrier) must be referenced with `@资产名`/`@name` in the prompt you write.

- The server checks one by one: a `must_show` asset not @-referenced by that prompt → consistency issue `intent_unmet` (**blocking** generation),
  judged separately for the first/mid/last three prompts.
- Do not substitute a textual description for the @: writing "a Guards officer standing beside him" does not send that reference image to the image model;
  you must write `@谢苗诺夫近卫团`.
- When one shot must express two entities at once (a person + the organization he belongs to), @ both, and state their spatial relationship in the frame
  (who is in the foreground, who is in the background / inset / a print on the wall).

## 3. All text goes to layers; write no text in the prompt

- Name bars, years, place-name labels, route annotations are **all overlay layers** (`overlay_plan`), rendered by the program.
- **Never** write "the picture shows ...", "titled ...", "subtitle ..." in a prompt — diffusion models draw garbled text,
  and the style preset itself already carries `no lettering`.
- A `card` shot's prompt is responsible only for the base map: the person's position in the frame must **leave room for the name bar**
  (e.g. the person offset to the left third of the composition, the lower right left empty), but do not draw the name bar yourself.

## 4. Continuing the previous shot is allowed (the documentary-branch exception)

The base `keyframe-prompt` specification requires every frame to be independent and forbids continuation. **Documentary projects lift that ban**:

- The batch task's message carries the neighboring shots' `intent` and picture descriptions. Consecutive shots within the same narrative segment
  (the same place, the same people, different stages of the same event) **should** carry over the same spatial relationships and viewpoint,
  instead of each writing its own (the "destination of the fleet" shot must continue the fleet already shown in the previous shot).
- The way to continue is still a **self-contained description**: **rewrite the carried-over content in full** (the same river reach, the same fleet, the same camera orientation),
  not "same as the previous frame" or "keep unchanged" — the latter carries no information for single-frame image generation.
- Continue only when there is a real continuation; hard cuts (change of place, change of era) remain independent as before.

## 5. Base rules that still apply

- **Absolute image first**: do not write a character's species, clothing, colors, hairstyle, or build; characters are always referenced only by `@角色名`/`@name`.
- Each prompt is self-contained: shot size, camera position, composition, lighting, and atmosphere must all be stated by the prompt itself.
- Leave `first_frame_prompt` empty when `inherits_first=true`; `mid_frame_time` falls between 0.5 and `duration-0.5`.
