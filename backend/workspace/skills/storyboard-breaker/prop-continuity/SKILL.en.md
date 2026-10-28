---
name: prop-continuity
description: Prop continuity at the storyboard layer — scanning the script sentence by sentence for objects, citing them continuously along the continuity chain, and trading off within the 9-image budget
---

# Prop Continuity (storyboard layer)

## Why

A prop asset only becomes a reference image when a storyboard **binds it (prop_ids) and cites it with @**. Miss the binding on one shot and the model reinvents that object's appearance for that shot. Inherited shots are especially dangerous: the dumbbell still in a character's hand in the previous shot will vanish or deform in the next one if it is not @-mentioned.

## Sentence-by-Sentence Scan Process

For every storyboard segment:

1. Go through the script sentences the segment covers one by one, and list the **objects that will be seen on screen** (including what the character holds, wears, stands on, or looks into)
2. Match them against the `props` list returned by `read_storyboard_context`:
   - Matched → bind into `prop_ids`, and cite with `@prop name` in the description, the three keyframe prompts and video_prompt
   - Not matched → record it in the "missing objects list", list it in your closing message after all saves are complete, and remind the user to extract it first; **do not** substitute a plain-text description (plain text = reinvented every frame)
3. Check the budget (below); if exceeded, cut the bindings and @ mentions of the less important props by priority

## Continuity Chain Rules

- **Held objects**: something a character is holding must be @-mentioned in every segment, every keyframe prompt and every video sub-segment in which it exists, stating **which hand** it is in; the instant of putting it down or handing it over gets its own sub-shot, written out clearly
- **Worn objects** (hats, glasses, sunglasses, helmets): every keyframe and every video segment states the current status — **worn / held in which hand / not in frame**. Taking it off and putting it on are each an independent main action and never run in parallel with another action
- **Handover frames**: `result` and `last_frame_prompt` must state what every character is holding and wearing at the end of the segment — this is the basis for the next shot's inheritance
- **Stationary assets are @-anchored per segment too**: bound props that are present but held by no one (the mirror, the mat, the notebook on the desk) and **the scene itself** are likewise @-referenced in every segment of the description, keyframe prompts and video_prompt (background/blur/off-screen uses the `@Name (off-screen)` note) — a segment that skips the @ drops that asset's reference image for that segment; "resting/leaning/sitting + @Prop" must be upgraded to wording that includes a functional part or grip point (see the video-prompt skill's "Reference Rules")
- Cross-segment state must be self-consistent: if the previous shot's last frame has "the sunglasses held in the right hand", the next shot's first frame (inherited) may not suddenly become "worn on the face"

## Reference-Image Budget and Trade-offs

- Ceiling of 9 per shot, and during video generation the first-frame keyframe takes 1 → **scene 1 + characters N + props M ≤ 8**
- Trade-off priority (from most protected to first dropped):
  1. The scene image
  2. Characters present (including styling-version images; the system picks the version automatically via asset_version_selection)
  3. Props that are used, handed over, shown in close-up or worn
  4. Props merely sitting there visible
- A dropped prop: remove both its `prop_ids` binding and all its `@` citations (an @ without a binding raises ref_issues; a binding without an @ just wastes a slot)
- When there are too many props to fit, first consider splitting the sub-shots into two segments, each citing half of the props
