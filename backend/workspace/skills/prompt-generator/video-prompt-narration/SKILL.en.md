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
