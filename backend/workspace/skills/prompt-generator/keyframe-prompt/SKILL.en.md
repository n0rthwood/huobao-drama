---
name: keyframe-prompt
description: Storyboard keyframe prompt specification — writes the image-generation prompts for the first / mid / last static keyframes of each storyboard segment
---

# Keyframe Prompts (storyboard segment → first/mid/last_frame_prompt)

Before a storyboard segment's video is generated, a set of **static keyframe images** is produced first: the first frame, an (optional) mid frame, and the last frame. During video generation the first keyframe is used as `<Image 1>` and as the frame-0 anchor, the mid/last keyframes act as timeline anchors, and the scene/character/prop reference images are layered on top. The keyframes therefore decide the visual quality and character consistency of the whole video.

A keyframe prompt describes **one frozen instant inside that segment** — not a movement. It never writes time progression, never "then" or "next".

## Definition of the Three Keyframes

| Slot | Field | Corresponding instant |
|---|---|---|
| First frame | `first_frame_prompt` | the opening instant of `【镜头1】` |
| Mid frame | `mid_frame_prompt` + `mid_frame_time` | the starting instant of the sub-shot that begins at `mid_frame_time` seconds |
| Last frame | `last_frame_prompt` | the segment's ending instant, consistent with `result` |

- `mid_frame_time` is in **seconds** (relative to the start of the segment), must be exactly the start time of some `【镜头N】` (N ≥ 2), and must fall strictly between 0.5 seconds and `duration - 0.5` seconds
- Mid-frame selection rule: pick the starting moment of **the most important sub-shot other than the first one** (a cut point, an emotional turn, the moment a key action happens); when a segment has only one sub-shot, write neither `mid_frame_prompt` nor `mid_frame_time`
- Carried-over segments (`continuity` is `continue`, `inherits_first` is `true`): the first frame directly reuses **the previous segment's last keyframe image**, so `first_frame_prompt` must be left empty; in exchange, the previous segment's `last_frame_prompt` must describe a stable, clearly readable frame that can serve as this segment's opening image

## Absolute Rule: Images Win

A character's look is decided entirely by the asset reference images — **the moment the text contradicts the reference image, the generated frame falls apart**.

- **Never** describe a character's species, race, clothing, colors, hairstyle, body type, age, facial features, or any other appearance attribute
- Characters are always referenced only as `@CharacterName`, e.g. "@Xiaoman stands on the left of the frame, turning her head over her shoulder"
- **Character names are only labels** — do not infer looks from a name (a name containing "Cat", "Mouse", or "Old Wang" says nothing about appearance)
- The same applies to scenes and props: reference them as `@SceneName` / `@PropName` and only add the "state at this instant" that the reference image cannot show (who is where, what pose, what lighting)
- What you may write: shot size, camera angle, composition, where each character sits in the frame, pose, body action, expression, eyeline, interaction with props, lighting and mood

## Every Keyframe Prompt Must Be Self-Contained

**Each keyframe is generated independently**: the model only receives the asset reference images plus this one prompt — it cannot see the other keyframes. Therefore:

- Never write relative descriptions such as "same as the previous frame", "unchanged", "continues the earlier composition", or "building on the previous image"
- Each prompt must state for itself: `@SceneName` + shot size/camera angle/composition + which `@CharacterName`s are in frame and where each of them is, with pose and expression + the key `@PropName`s + the lighting and mood taken from `atmosphere`
- Write it as one coherent passage — no bullet points, no numbering

## Writing Structure (Recommended Order)

**@SceneName + time/lighting → shot size and camera angle → composition (who is where in frame) → the main @CharacterName's pose · action instant · expression · eyeline → key @PropName and the interaction → mood and lighting → cinematic still-frame closing phrase**

Always end with the aspect-ratio and texture description: 16:9 landscape cinematic film still, single static frame.

Example (first frame):

```
@Old House Living Room, dusk, 16:9 landscape cinematic film still. Medium shot, eye-level, static camera; @Xiaoman sits in the left third of the frame, standing side-on beside the eight-immortals table, her right hand just touching the @Bronze Bell on the tabletop, shoulders tense, chin slightly tucked, her gaze crossing to the doorway on the right of the frame and out the door. The empty doorway on the right is left open as a visual exit. Dusk light slices in diagonally from the doorway, drawing long strips of light across the floor tiles; the whole frame is warm amber leaning orange with deep shadows. Single static frame, no motion blur.
```

Example (last frame, to be carried over by the next segment):

```
@Old House Living Room, dusk, 16:9 landscape cinematic film still. Medium shot, eye-level, static camera; @Xiaoman stands just left of center in front of the eight-immortals table, holding the @Bronze Bell cupped in both hands at chest height, body facing the camera straight on, head lowered toward the bell in her hands, lips pressed together. The doorway on the right of the frame is empty and the light has already dimmed. The warm amber has faded to grey-blue; outlines are crisp and the composition is stable. Single static frame, the characters fully in frame, no motion blur.
```

## Extra Requirements for the Last Frame

The next segment may use this segment's last frame as its own first frame, so the last frame must be a frame that **can be acted onward from**:

- Characters fully in frame with stable poses — never write "exiting frame", "walking away with her back turned", or "mid-action motion blur"
- Do not end on a pure extreme object close-up (unless the next segment really is a `cut`)
- The frame must contain the characters the next segment needs
- It must be consistent with `result` (`result` states the consequence and details of the ending frame; the last-frame prompt translates that into a renderable single-frame composition)

## Prohibitions

- Any character appearance attribute (species / clothing / colors / hairstyle / body type / facial features / age)
- Relative descriptions ("same as above", "unchanged", "continues"), time progression ("then", "afterwards", "the camera then pushes in")
- Movement description (camera moves, push/pull/pan/dolly, action in progress) — a keyframe is one frozen instant
- Dialogue, narration, subtitles, voice-over
- Scene/character/prop names outside the reference lists
- Abstract psychological description, literary metaphor (write only visible imagery)
- Language that does not match the session language directive

## Saving

Call `update_storyboard` (or `save_storyboards` during storyboard breakdown) to write `first_frame_prompt` / `mid_frame_prompt` / `mid_frame_time` / `last_frame_prompt`. When generating keyframe prompts on their own, pass `update_storyboard` only the `storyboard_id` plus these keyframe fields — do not send back any other field, and do not re-breakdown the whole episode.
