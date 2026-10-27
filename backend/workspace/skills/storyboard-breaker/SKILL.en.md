---
name: storyboard-breaker
description: Professional rules for storyboard breakdown — splitting a script into storyboard segments that each carry multiple sub-shots
---

# Storyboard Breakdown Guide

## Core Definition: Storyboard Segment

One storyboard = one **storyboard segment** = one video-generation task.

- Each segment is **8-15 seconds** long and internally carries **2-4 sub-shots**
- Cuts between sub-shots **are allowed**: change shot size, angle, or subject, joined with hard cuts
- Sub-shots **never cross scenes**: a segment takes place in a single scene (`scene_id` is a segment-level binding)
- Each sub-shot is 2-6 seconds, focused on one visual unit (one action, one reaction, one close-up)

## Breakdown Process (Four Steps)

1. Call `read_storyboard_context` to read the script, characters, scenes, props, and existing storyboard summaries
2. **Beat identification**: first identify the script's narrative beats — markers such as [Opening] [Trigger] [Climax] [Resolution], or narrative turning points (location changes, rule reveals, emotional eruptions, reversals). **Beat boundaries force a segment cut**; group sub-shots within the same beat into the same segment where possible, and do not scatter a causal chain (setup-event-reaction) across different segments
3. **Total-volume anchoring**: target total duration = script character count ÷ 500 characters/minute; segment count ≈ target total duration ÷ 12 seconds, with ±20% tolerance. Do not significantly overshoot or undershoot
4. **Split sub-shots within each segment**: cut sub-shots at action-change points, viewpoint-change points, and subject-change points; after filling in all fields for each segment, call `save_storyboards` to save them in one go

## Pacing-Tier Durations

Determine duration by the segment's function — do not use one size for all:

| Segment type | Duration | Notes |
|---|---|---|
| Transition segment | 8-10 s | Traveling, empty shots, environment establishment, transitions |
| Narrative segment | 10-15 s | Regular plot advancement, dialogue |
| Payoff segment | 12-15 s | Close-ups, rule reveals, emotional eruptions, reversals; slower sub-shot pacing, a single sub-shot may hold for 4-6 s |

## Dialogue Duration Floor (Hard Rule)

**Segment duration ≥ total character count of dialogue and narration within the segment (the part written in description) ÷ 4.5 characters/second + 2 seconds of performance headroom**

Dialogue that does not fit must be moved to the next segment; cramming unperformable dialogue into one segment is not allowed.

## Shot Elements

1. **Shot title**: a 3-5-character summary of the segment's core content (e.g. "Nightmare Awakening")
2. **Time**: specific time of day + lighting description
3. **Location**: full scene description + spatial layout + environmental details
4. **Shot size**: the dominant shot size of the segment; for multi-size segments write a combination, e.g. "medium shot + close-up"
5. **Angle**: eye-level / low angle / high angle / side / back
6. **Camera move**: static / push-in / pull-back / pan / tracking / dolly (different sub-shots within a segment may differ)
7. **Visual description** `description`: describe sub-shot by sub-shot as `【镜头1】…【镜头2】…` what the audience actually sees and hears — the visuals (who + specific action + body-language details + expression) come first; when a sub-shot has dialogue, write it inside the corresponding `【镜头N】` as "CharacterName says: "line"", and narration as "Narration: content"
8. **Visual result** `result`: the immediate consequence at the end of the segment + visual details
9. **Atmosphere** `atmosphere`: lighting + color tone + sound + overall mood
10. **Duration** `duration`: total segment duration 8-15 seconds, and it must satisfy the dialogue duration floor
11. **Scene binding**: if it can be matched to an existing scene, `scene_id` must be filled in
12. **Character binding**: fill in `character_ids`, binding 0 to multiple characters involved in this segment
13. **Prop binding**: fill in `prop_ids`, binding 0 to multiple key props appearing in this segment
14. **Continuity annotation** `continuity`: `continue` (carries over the previous segment's ending frame) or `cut` (hard cut)
15. **Keyframe prompts** `first_frame_prompt` / `mid_frame_prompt` + `mid_frame_time` / `last_frame_prompt`: the single-frame image-generation prompts for the segment's first frame, optional mid frame, and last frame

## Scene Binding Rules

- Prefer the `scenes` returned by `read_storyboard_context`
- When `location + time` can be clearly matched, the correct `scene_id` must be filled in
- Do not fabricate scene IDs that do not exist
- If the script content clearly falls within an existing scene, do not create a duplicate new scene description

## Character Binding Rules

- `character_ids` must be chosen from the character list returned by `read_storyboard_context`
- A segment may have no characters, or may bind multiple characters
- Any character with a clear appearance in the segment — seen, acting, or speaking — should be bound
- Pure-environment segments, empty shots, and object close-ups may pass an empty array

## Prop Binding Rules

- `prop_ids` must be chosen from the prop list (`props`) returned by `read_storyboard_context`
- When a prop is used by a character, handed over, shown in close-up, or clearly visible in frame and meaningful to the narrative, it must be bound to that segment
- Prop close-up segments (without characters) should also bind the prop; `character_ids` may be empty
- Do not bind background items or set dressing irrelevant to the plot; segments with no props pass an empty array
- Bound props serve as reference images for video generation (white-background product shots), keeping the prop's appearance consistent across segments

## Continuity Annotation and Keyframes (continuity + keyframe prompts)

**Why**: the system produces in the order "assets → storyboard breakdown → storyboard keyframes (human-confirmed) → video". Each segment first produces three static keyframe images — first frame / (optional) mid frame / last frame — and the video is only generated after a human confirms them; the video uses the first keyframe as its frame-0 anchor and the mid and last keyframes as timeline anchors. Every segment must therefore carry keyframe prompts, and the continuity annotation must be accurate.

**Annotation rules** (every segment must carry a `continuity` value):

| Situation | Value |
|---|---|
| The first segment | `cut` |
| Scene change (`scene_id`/location changes), time jump, flashback, deliberate hard cut | `cut` |
| Same scene, the immediate next moment after the previous segment, characters carried over | `continue` |

**Keyframe fields** (the rules live in the `keyframe-prompt` skill and must be followed strictly):

- `first_frame_prompt`: the single frame at the opening instant of `【镜头1】`. A segment whose `continuity` is `continue` **must leave it empty** — its first frame directly reuses the previous segment's last keyframe image
- `mid_frame_prompt` + `mid_frame_time`: the starting instant of **the most important sub-shot other than the first one** (a cut point, an emotional turn, the moment a key action happens); `mid_frame_time` is in seconds (relative to the start of the segment), must be exactly that `【镜头N】`'s start time, and must fall strictly between 0.5 seconds and `duration - 0.5` seconds. When a segment has only one sub-shot, write neither of them
- `last_frame_prompt`: the single frame at the segment's ending instant, consistent with `result`

**Writing requirements**:

- Each keyframe is generated **independently** (only the asset reference images plus this one prompt), so every prompt must be self-contained: state for itself the `@SceneName`, the shot size/camera angle/composition, which `@CharacterName`s are in frame with their positions, poses and expressions, the key `@PropName`s, and the lighting and mood; never write relative descriptions such as "same as the previous frame" or "unchanged"
- **Images win, absolutely**: in `description`, `video_prompt`, and all three keyframe prompts alike, never describe a character's species, clothing, colors, hairstyle, body type, facial features, age, or any other appearance attribute — characters are always referenced only as `@CharacterName`; character names are merely labels, do not infer looks from them
- A segment followed by a `continue` segment must write its `last_frame_prompt` as a **stable, clearly readable** frame, with the characters fully in frame and in stable poses, containing the characters the next segment needs — do not end on an extreme object close-up, a mid-motion blurred action, or a character exiting frame, because that frame is the next segment's opening image
- `result` must concretely describe the ending frame (composition, who is where, what pose); `last_frame_prompt` is its renderable version

## Quality Requirements

- `description` should be human-readable, describing sub-shot by sub-shot what the audience actually sees and hears; dialogue/narration is written directly inside the corresponding `【镜头N】`
- The three keyframe prompts should highlight the single-frame composition, where each character sits in the frame and their pose, the environment and the lighting, and must reference characters only as `@CharacterName` without any appearance attribute
- `bgm_prompt` and `sound_effect` may be concise phrases, but must not be as vague as just "tense" or "sad"
- To make adjustments, call `update_storyboard` to modify the specific segment
