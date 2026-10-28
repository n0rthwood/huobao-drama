---
name: keyframe-prompt
description: Storyboard keyframe prompt specification — writes the image-generation prompts for the first / mid / last static keyframes of each storyboard segment
---

# Keyframe Prompts (storyboard segment → first/mid/last_frame_prompt)

Before a storyboard segment's video is generated, a set of **static keyframe images** is produced first: the first frame, an (optional) mid frame, and the last frame. During video generation the first keyframe is the frame-0 anchor, the mid/last keyframes act as timeline anchors, and the scene/character/prop reference images are layered on top. The keyframes therefore decide the visual quality and character consistency of the whole video.

A keyframe prompt describes **one frozen instant inside that segment** — not a movement. It never writes time progression, never "then" or "next".

## Definition of the Three Keyframes

| Slot | Field | Corresponding instant |
|---|---|---|
| First frame | `first_frame_prompt` | the opening instant of `【镜头1】` |
| Mid frame | `mid_frame_prompt` + `mid_frame_time` | the starting instant of the sub-shot at `mid_frame_time` seconds |
| Last frame | `last_frame_prompt` | the segment's ending instant, consistent with `result` |

- `mid_frame_time` is in **seconds** (relative to the start of the segment), must be exactly the start time of some `【镜头N】` (N ≥ 2), and must fall strictly between 0.5 seconds and `duration - 0.5` seconds
- The mid frame takes the starting moment of **the most important sub-shot other than the first one**; when a segment has only one sub-shot, write neither of them
- Carried-over segments (`continuity` is `continue`, `inherits_first` is `true`): `first_frame_prompt` must be left empty; in exchange, the previous segment's `last_frame_prompt` must be a stable, clearly readable frame that can serve directly as this segment's opening image

## Absolute Rule: Images Come First

A character's look and clothing are decided entirely by the asset reference images (including styling-version images), so **the moment a text description conflicts with a reference image, the render falls apart**.

- **Never** describe a character's species, race, clothing, colors, hairstyle, body type, age or facial features
- Always refer to a character only as `@CharacterName`; **the name is merely a code** — never infer appearance from it
- The same applies to scenes and props: reference them as `@SceneName` / `@PropName` and only add "their state at this instant"
- **Allowed**: relative size ratios ("@MouseMom is about two-thirds the height of @PigDad" — a ratio is not a look); the worn state of wearable props ("@Sunglasses perched on the bridge of the nose", "@PanamaHat held in the left hand" — these are prop references)
- What you may write: shot size, camera angle, composition, character placement, pose, limb action, expression, eyeline, prop interaction, lighting and mood

## Limb-State Checklist (verify every item in every prompt)

For **every** character present in the frame:

1. **Both hands**: where each is and what it does; when holding something, state **which hand**; an empty hand must be written too ("the left hand hangs naturally at the side")
2. **Both legs**: the concrete way they are standing / sitting / crouching / folded and their visibility — for high-risk poses use a positive, exhaustive enumeration: "the left leg is folded over the right, both feet tucked under the body, both soles visible in frame"; **never** write negative instructions like "no third leg" (they do not work)
3. **Occlusion**: never write a limb action fully hidden behind the torso; when "a hand reaches behind the back" is needed, rewrite it as an equivalent pose visible from a side-on angle
4. **Contact**: when two characters touch, write both parties' final limb states and keep the contact point unique ("@MouseMom's right paw presses on @MonkeyBaby's left knee, @MonkeyBaby's hands brace on the chair seat")
5. **Worn state**: hats, glasses, sunglasses and the like are declared in every frame — worn / held in which hand / not in frame
6. **Non-human body types**: do not apply human standard poses to short-limbed round-bodied characters; use the version their body can actually perform (both paws hugged in front of the chest, not "arms hanging at the sides holding a dumbbell")
7. **Asset anchoring (single-frame version of per-segment anchoring)**: every bound asset visible in this frame — including background, blur, mirror images (noted `@Name (in-mirror)`) and off-screen sound sources (noted `@Name (off-screen)`) — is @-referenced, each with a short visibility phrase; the sentence containing `@PropName` must include a functional part / explicit grip point / use action (in a still frame, express it as a part-level state, e.g. "the thumb resting lightly on the channel button of the @RemoteControl"); bare-text references to @-able assets are forbidden, and collective terms (parents / the two / they) must not be the first reference — @-name first, then refer back

## Mirror and Screen Rules

- When the frame contains a full-length mirror or a reflection, a single frame may feature either the **mirror image** or the **real body** as the subject, not both: if shooting the mirror image, the mirror frame is fully in shot and only a partial back view of the real body shows, stated explicitly; if shooting the real body, the mirror sits at the edge of the frame or is thrown out of focus
- Spell out the mirror's contents item by item (who, in what pose, wearing what), and they must match the real body
- A television or screen inside the frame only plays program footage (landscapes, news footage, etc.); **this film's characters must never appear on it**
- Multiple characters plus a mirror is the highest-risk combination — avoid it when you can: prefer splitting into two sub-shots, a "real body shot" and a "mirror reverse shot"

## Reference Image Budget (hard constraint)

- A shot may use at most 9 reference images; during video generation the first keyframe already takes 1, leaving: scene 1 + characters N + props M ≤ 8
- When over budget, drop by priority: scene > characters present > props that are used or shown in close-up > props that are merely visible
- A prop that is dropped loses both its binding and its @ mention — never leave a name that is "@-mentioned but not bound"
- Keyframe prompts may only @ the scene / characters / props bound to this storyboard segment

## Every Keyframe Prompt Must Be Self-Contained

Each keyframe is rendered independently (only the asset reference images plus this one prompt):

- Never write "same as the previous frame", "unchanged", "continues the earlier composition"
- Each prompt must state for itself: `@SceneName` + shot size/camera angle/composition + each `@CharacterName`'s position, pose, limb state and expression + the key `@PropName`s and their worn/held state + the lighting and mood taken from `atmosphere`
- Write it as one coherent passage — no bullet points, no numbering

## Writing Structure (Recommended Order)

**@SceneName + time/lighting → shot size and camera angle → composition (who is where in frame) → the main @CharacterName's pose · limb state · expression · eyeline → key @PropName and the interaction/worn state → mood and lighting → closing phrase**

Always end with: 16:9 landscape cinematic film still, single static frame.

Example (first frame, with props and limb states):

```
@Balcony, early morning, bright warm dawn light spread evenly across the floor, 16:9 landscape cinematic film still. Medium shot, eye-level, static camera; @Gini stands on the @TrainingMat at the center of the frame, both paws hugging one @MiniDumbbell against the chest, the other @MiniDumbbell lying flat on the mat to the front right, legs together and planted, both hind paws clearly visible on the mat, expression focused, gaze resting on the dumbbell in her arms. Open balcony floor is left around the frame, the dawn light soft with no heavy shadows. Single static frame, no motion blur.
```

Example (last frame, to be carried over by the next segment):

```
@LivingRoom, afternoon, light warm natural illumination spread evenly through the space, 16:9 landscape cinematic film still. Medium shot, eye-level, static camera; @MonkeyBaby stands just right of center in front of the @FullLengthMirror, body facing the off-screen sofa, the right hand holding the @Sunglasses at chest height, the left hand hanging naturally at the side, legs together and planted with both soles on the ground and visible, lips slightly pursed, gaze out of frame. The mirror occupies only the right edge of the frame and shows a partial back view of him. The composition is stable, the character fully in frame. Single static frame, no motion blur.
```

## Extra Requirements for the Last Frame

The next segment may use this segment's last frame as its own first frame, so the last frame must be a frame that **can be acted onward from**:

- Characters fully in frame with stable poses — never "exiting frame", "walking away with the back turned", "mid-action motion blur"
- Do not end on a pure extreme object close-up (unless the next segment really is a `cut`)
- The frame must contain the characters the next segment needs, together with the props they **hold or wear** (state consistent with `result`)
- It must be consistent with `result`

## Prohibitions

- Any character appearance attribute (species / clothing / colors / hairstyle / body type / facial features / age)
- Relative descriptions ("same as above", "unchanged"), time progression ("then", "afterwards")
- Movement description (camera moves, action in progress) — a keyframe is one frozen instant
- Negative limb instructions ("no third leg", "do not draw two people") — use a positive, exhaustive enumeration instead
- Bare-text references to @-able assets ("that mirror", "the mirror off-screen"); collective terms (parents / the two / they) as the first reference
- Dialogue, narration, subtitles, voice-over
- Scene / character / prop names outside the reference list
- Abstract psychological description, literary metaphor
- A language that does not match the conversation language instruction

## Saving

Call `update_storyboard` (or `save_storyboards` during storyboard breakdown) to write the keyframe fields. When generating them on their own, pass `update_storyboard` only the `storyboard_id` plus the keyframe fields — do not send back any other field, and do not re-breakdown the whole episode.
