---
name: video-prompt-narration
description: Override rules for video prompts when the episode has narration enabled — narration runs on a separate track and must never enter the dialogue/soundscape part of the video prompt
---

# Video Prompt: Narration Runs on a Separate Track (injected only when the episode has narration enabled)

This episode has **narration** enabled: the commentary lives in a separate storyboard field, is turned into its own track by speech synthesis, and is mixed into the finished shot and burned in as subtitles during composition. Audio produced by the video model is discarded or pushed down to a bed during composition.

Therefore this episode's `video_prompt` **overrides** the rule in the video-prompt skill that says "extract 『Narration: …』 from description into the dialogue part of the video prompt":

1. Do **not** write any commentary, voice-over or narration into `video_prompt`.
2. Do **not** have on-screen characters recite the commentary — otherwise H3 generates mismatched lip movement and speaking gestures.
3. Real **dialogue** between characters (the parts written as 「CharacterName says: 『…』」 inside 【Shot N】 of `description`) is still extracted into the matching 3-second segment as usual; this rule does not affect it.
4. If 「Narration: …」 is still left in `description` (legacy data), **skip it**; do not carry it into `video_prompt`.
5. All other rules — picture, camera movement, shot size, atmosphere, keyframe alignment — are unchanged.

## Unnamed People Must Carry Their Own Visible Markers

When the frame contains **people who have no character asset** (attendants, soldiers, palace servants, clerks, commoners, passers-by, extras and the like):

- **Always** state: how many of them, where they stand (where in the frame / relative to the main subject) and their identity or function; **never** write a bare collective label such as "an attendant", "two people" or "a few soldiers" with no markers
- **Always** give at least two visible markers out of garment colour, garment cut/style, hat/headwear and carried items, and they must differ from **every** `@CharacterName` in the same frame — never the same colour and the same cut as any `@CharacterName`, otherwise the model copies that character's reference-image look straight onto them
- When the same group of unnamed people recurs across several shots, **reuse one and the same marker set**: read the neighbouring shots' saved prompts through `read_storyboard_context` and copy the wording already fixed there; never invent a new description
- This rule applies **only to unnamed people without assets**; a `@CharacterName` that has an asset still follows "Absolute Rule: Images Come First" and gets not one word of appearance
- **Never** create a character asset for unnamed people
- Counter-example: "an attendant on either side holds him up"; correct: "an attendant on either side (unpatterned grey-brown short tunic, no cap, hair in a plain bun, cloth belt at the waist), each with one hand under his arm"

The same rule as in the video-prompt skill; it applies to narrated episodes too. When unnamed people appear in several 3-second segments, repeat the marker set at their first mention in **each** segment; never spell it out only in the first segment and fall back to "the two of them" or "they" afterwards.
