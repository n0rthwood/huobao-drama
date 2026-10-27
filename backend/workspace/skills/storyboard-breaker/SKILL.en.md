---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **segment** = one video generation task.

- Each segment lasts **8-15 seconds** and carries **2-4 sub-shots** inside it
- Sub-shots **may cut**: change the shot size, the angle, the subject, joined by hard cuts
- Sub-shots **never cross scenes**: one segment happens in a single scene (`scene_id` is bound at segment level)
- Each sub-shot is 2-6 seconds and focuses on one picture unit (**one main action**, one reaction, one close-up)

## Breakdown Process (five steps)

1. Call `read_storyboard_context` to read the script, characters, scenes, props and the summary of existing storyboards
2. **Beat identification**: identify markers such as [opening] [trigger] [climax] [closing] or narrative turning points; beat boundaries force a segment break; sub-shots within the same beat preferably stay in one segment, do not cut the causal chain apart
3. **Per-shot object scan**: scan the script sentence by sentence for each segment, list the objects visible on screen → map them to the prop list and bind `prop_ids` → mention `@prop name` in the three keyframes and in video_prompt; continuously cite held and worn objects along the continuity chain (see the `prop-continuity` skill); objects that exist in the script but not in the prop list go into the list in your closing message
4. **Total-length anchoring**: target total duration = script character count ÷ 500 characters per minute; number of segments ≈ target total duration ÷ 12 seconds, ±20%
5. **Split sub-shots within a segment**: cut at action, viewpoint and subject switch points, complete all fields and then call `save_storyboards` to save in batches

## Rhythm-Tiered Durations

| Segment type | Duration | Notes |
|---|---|---|
| Transition segment | 8-10 s | Travelling, empty shots, establishing the environment, scene transitions |
| Narrative segment | 10-15 s | Regular plot progression, dialogue |
| Peak segment | 12-15 s | Close-ups, rule reveals, emotional outbursts, reversals; a single sub-shot may hold for 4-6 s |

Hard rules: a 15-second segment needs at least 3 sub-shots; no sub-shot exceeds 5 seconds; at most 1 pure close-up sub-shot per segment and it must not end the segment — ending on a close-up makes the second half of the video collapse into an ever-closer giant face.

## Dialogue Duration Floor (hard rule)

**Segment duration ≥ total character count of dialogue and narration in the segment ÷ 4.5 characters per second + 2 seconds of performance headroom**; dialogue that does not fit moves to the next segment.

## Action and Limbs (hard rules)

- **One main action per sub-shot**: do not stuff an action chain such as "lowers legs — twists around — folds them back" into one sub-shot; split it or drop part of it
- **High-risk actions must state where the limbs go**: cross-legged sitting / crouching / standing on one leg / crossing legs / turning around / two characters touching / looking into a mirror — the description must state how both hands and both legs are tucked away and whether they are visible ("legs drawn in and crossed in front of the body, feet tucked underneath, both hands hugging the knees")
- **Rewrite occluded actions**: an action hidden by the torso, such as reaching a hand behind the back, must be rewritten as an equivalent action visible from the side ("turned side-on to camera, the right hand reaching around to the side of the waist, the elbow visible") — the model cannot draw limbs it cannot see, it will only attach them wrongly
- **Contact interactions are declared on both sides**: when A touches B, the final limb state of both characters must be written, with a single point of contact
- **Rewrite for non-human body feasibility**: for characters with short limbs and round bodies, hooved feet, or identical hands and feet, first rewrite the human action into a version that body can actually perform (a guinea pig lifting a dumbbell → both paws wrapped around the bar at the chest; tree pose → one hind paw lifted slightly off the ground)
- **Multiple characters in frame**: with ≥3 characters, or two characters less than half a body width apart, give each character its own sentence stating position and posture; do not merge the descriptions

## Shot Elements

1. **Shot title**: a 3-5 character summary
2. **Time**: the specific hour and minute + a description of the light
3. **Place**: the full scene description + spatial layout
4. **Shot size**: the dominant shot size; write the combination if multiple
5. **Angle**: eye level / low angle / high angle / side / back
6. **Camera movement**: fixed / push in / pull out / pan / follow / track
7. **Picture description** `description`: described sub-shot by sub-shot under [Shot N], picture first, dialogue inside (rules above)
8. **Picture result** `result`: the immediate consequence at the end of the segment + visual details + **what each character is holding / wearing** at that moment
9. **Atmosphere** `atmosphere`: light + colour tone + sound + overall mood
10. **Duration** `duration`: 8-15 seconds and satisfying the dialogue floor
11. **Scene link** `scene_id`, 12. **Character links** `character_ids`, 13. **Prop links** `prop_ids`
14. **Continuity marking** `continuity`
15. **Keyframe prompts**: `first_frame_prompt` / `mid_frame_prompt` + `mid_frame_time` / `last_frame_prompt`

## Scene Linking Rules

- Prefer the `scenes` returned by `read_storyboard_context`; when `location + time` matches unambiguously you must fill in the correct `scene_id`
- Do not invent scene IDs that do not exist; do not treat one physical space as several scenes

## Character Binding Rules

- `character_ids` must come from the returned character list; bind every character who clearly appears, is seen, acts or speaks; pass an empty array for empty shots

## Prop Binding and Reference-Image Budget

- `prop_ids` must come from the returned prop list (`props`)
- When a prop is used, handed over, shown in close-up, worn, or is clearly visible on screen and meaningful to the narrative, it must be bound and mentioned with @ in the prompts
- Budget: at most 9 reference images per shot, the video side's first frame takes 1 → scene 1 + characters N + props M ≤ 8
- Over-budget priority: scene > characters present > props used / in close-up > props merely visible; a prop that gets squeezed out loses both its binding and its @ — never leave a name that is "@-mentioned but not bound" (it raises ref_issues)
- Background items unrelated to the plot are not bound; segments with no props pass an empty array

## Continuity Marking and Keyframes

**Marking rules** (every segment needs a `continuity`):

| Situation | Value |
|---|---|
| The first segment | `cut` |
| Scene change (`scene_id` / location changes), time jump, flashback, deliberate hard cut | `cut` (**never use `continue` across scenes** — the inherited first frame would anchor to an image of the wrong scene) |
| Same scene, the very next moment following the previous segment, characters continuing | `continue` |

**Keyframe fields** (the rules are detailed in the `keyframe-prompt` skill and must be followed strictly):

- `first_frame_prompt`: the opening instant of [Shot 1]; must be left empty for `continue` segments
- `mid_frame_prompt` + `mid_frame_time`: the starting instant of the most important sub-shot other than the first one; `mid_frame_time` must be exactly that [Shot N]'s start time and must fall strictly between 0.5 and `duration - 0.5`; omit it when there is only one sub-shot
- `last_frame_prompt`: the closing instant of the segment, consistent with `result`

**Writing requirements**:

- Every keyframe prompt must be self-sufficient: @scene name, shot size / camera position / composition, the position / posture / **state of both hands and both legs** / expression of each @character name, the key @prop names and their **worn or held state**, the light and atmosphere; relative descriptions are forbidden
- **Absolute image priority**: never describe a character's species, clothing, colour, hairstyle, build, facial features or age; refer to characters only by `@character name`. You may write relative body proportions and the worn state of wearable props (these are not appearance descriptions); clothing is decided by the styling version reference image
- For a segment followed by a `continue`, the `last_frame_prompt` must be stable, clear in information, with characters fully inside the frame, and must include the characters the next segment needs together with the props they hold or wear
- Mirrors and screens: within one frame make either the "mirror image" or the "real body" the subject, not both; a TV inside the picture only plays a programme — characters of this film must never appear on it

## Quality Requirements

- `description` should read well for a human, describing sub-shot by sub-shot what the audience actually sees and hears
- The three keyframe prompts emphasise the single-frame composition, character positions and postures, limb states, and the environmental light
- `bgm_prompt` and `sound_effect` use concise phrases, but must not be so vague as to say only "tense" or "sad", and must not be left empty
- If adjustments are needed, call `update_storyboard` to modify the specific segment
