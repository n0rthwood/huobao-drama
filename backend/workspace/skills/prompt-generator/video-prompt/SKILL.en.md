---
name: video-prompt
description: Video prompt specification — generates a time-segmented video-generation prompt from storyboard-segment content, with cuts allowed within a segment
---

# Video Prompt (storyboard segment → video_prompt)

From a single storyboard segment's description (containing the 【镜头N】 sub-shot structure and dialogue/narration) / atmosphere / duration, generate the `video_prompt` that drives AI video generation. **One storyboard segment = one 8-15-second video, with cuts allowed inside it**: consecutive segments may be different shots (change of shot size/angle/subject), joined with hard cuts; but the whole segment **never crosses scenes** and never uses flashbacks.

## Format

The **first line of the `video_prompt` is the header**: first introduce which characters and scene appear in this video, then follow with the time segments. Characters and scenes are always referenced with @ (during generation they are replaced with the corresponding reference-image markers, so the video model first locks onto "who" and "where").

```
Characters: @Xiaoming, @Xiaohong; Scene: @Coffee Shop.
0-3s: @Coffee Shop, close shot, static camera; @Xiaoming looks down at his phone, fingers repeatedly tapping the table, expression anxious.
3-6s: Cut to a wide shot of the doorway; the doorbell rings as @Xiaohong pushes the door open and walks in, bringing in a gust of cold air.
6-9s: Cut back to a medium shot; @Xiaohong walks over with a smile and sits down across from Xiaoming; Xiaoming says: "You finally made it."
```

Header rules:
- Only list the characters who actually appear in this storyboard segment and the bound scene — do not list those who do not appear
- When a prop has a notable appearance, it may be appended to the header (e.g. `; Props: @Letter`)
- The header is its own line, ending with a period, followed by the time segments

Split into 3-second segments, each segment on its own line separated by newlines, with time ranges continuous and adjoining (no overlaps, no gaps).

## Mapping to the Storyboard Description

The `description` is the sole content source of the video_prompt (visuals, actions, dialogue, and narration are all in it). Conversion rules:

- Each `【镜头N】` in the `description` maps to **1-2 consecutive 3-second segments** — same order, no omissions, no merging, no new sub-shots
- Dialogue/narration is extracted from the "CharacterName says: "..."" / "Narration: ..." entries inside the corresponding `【镜头N】` and assigned to that sub-shot's mapped segments; **do not invent new dialogue beyond the description**
- Visual actions follow the `description`; `atmosphere` is only used to supplement each segment's lighting, color tone, and mood descriptions

## Within-Segment Structure

Organize each segment's content in this order (items with no content may be omitted, but action/visuals are mandatory):

**Time range + scene @reference + shot size/camera move + character @reference + main action·expression + dialogue/narration + mood and lighting**

- **First segment**: the video's frame 0 *is* the storyboard's **first keyframe image** (for a carried-over segment, the previous segment's last keyframe). The first segment must carry on from the state that image already shows — keep the same camera position and the same character positions and poses; do not re-establish the space and do not cut at 0 seconds; cuts start from the second segment at the earliest
  - When a carried-over shot already has an opening-transition block: the first segment follows the opening transition — carry on from this shot's opening picture as it settles when the transition ends; the transition itself is owned by the transition description and must not be repeated in the video prompt
- **Cuts**: start a post-cut segment with a transition word such as "cut to / cut back", and restate the shot size and subject; cut points should align with the `【镜头N】` structure in the storyboard `description`
- **Shot size/camera move**: one camera state per segment (close shot / medium shot / wide shot / close-up; static / push / pull / pan / tracking); the camera move is continuous within a single sub-shot and may change after a cut
- **Action**: one main action per segment, with concrete visible verbs (walk, turn around, look up, clench, pause)
- **All emotion must become visible description**: no abstract words like "he is very sad / the mood is tense" — write it as "he lowers his head, fingers clench the rim of the cup, breathing grows heavier"
- **Dialogue/narration**: write "CharacterName says: "line""; narration as "Narration: content"; a long line that cannot be spoken within 3 seconds is split across multiple segments; a segment without dialogue may note ambient/action sounds (e.g. "machines keep roaring")

## Keyframe Alignment (Hard Rule)

Before the video is generated, each storyboard segment has already had its three static keyframe images confirmed — first frame / (optional) mid frame / last frame. The video uses the first keyframe as its frame-0 anchor and the mid and last keyframes as timeline anchors. `read_storyboard_context` returns `first_frame_prompt`, `mid_frame_prompt`, `mid_frame_time`, `last_frame_prompt`, and `inherits_first`; align to them:

- **First frame**: the first segment carries on from the first keyframe image. When `inherits_first` is `true` the first frame is the previous segment's last keyframe (read that segment's `last_frame_prompt` / `result` to learn what the image shows); again, do not re-establish the space
- **Mid frame**: when `mid_frame_time` has a value, the **start of one time segment must land exactly on that second**, and the visuals at that segment's opening must match `mid_frame_prompt` (usually this is a cut)
- **Last frame**: the final segment must land on the frame described by `last_frame_prompt`
- Keyframe prompts describe only frozen instants; the video prompt is responsible for writing the movement and performance *between* two keyframes — do not copy the keyframe prompts verbatim

## Absolute Rule: Images Win

A character's look is decided entirely by the reference images and the keyframes; the moment the text contradicts the images, the frame falls apart:

- **Never** describe a character's species, race, clothing, colors, hairstyle, body type, age, facial features, or any other appearance attribute
- Characters are always referenced only as `@CharacterName`; **character names are merely labels** — do not infer looks from a name
- Write only the visible position, pose, action, expression, eyeline, and prop interaction, plus shot size, camera move, lighting and mood

## Reference Rules

- `@SceneName` — scene reference; the name must exactly match the location in the scene list
- `@CharacterName` — character reference; the name must exactly match the name in the character list
- `@PropName` — prop reference; the name must exactly match the name in the prop list; reference a prop when it is clearly visible in frame, used, or shown in close-up
- During generation, each `@name` is automatically replaced with the corresponding reference-image marker (e.g. `@Xiaoming` → `@Image1Xiaoming`), so names must match exactly — do not abbreviate or add extra symbols
- **Every segment must have at least one @ reference anchoring the frame**; any segment in which a character appears must @ that character; only reference scenes/characters/props already bound to this storyboard segment

## Timeline Rules

- Number of segments = storyboard-segment duration ÷ 3 seconds (rounded up); the segment time ranges must add up exactly to the total segment duration
- Content pacing: the first segment carries on from the first keyframe image → middle segments advance the action/conflict (aligning with the mid keyframe at `mid_frame_time`) → the final segment lands on the last keyframe's image

## Prohibitions

- Cross-scene switching, flashbacks (a segment takes place in a single scene only)
- Referencing scene/character names outside the lists; any appearance description of a character (species/clothing/colors/hairstyle/body type/facial features/age)
- Abstract psychological description, literary metaphor (the model only recognizes visible imagery)
- Language that does not match the session language directive

## Saving

Call `update_storyboard` to update only this storyboard segment's `video_prompt` field; do not modify any other field, and do not re-breakdown the whole episode.
