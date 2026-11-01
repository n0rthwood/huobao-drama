---
name: narration
description: Storyboard-side rules when the episode has narration enabled — leave room for the commentary, estimate duration from narration length, keep narration out of description and video_prompt
---

# Storyboard Support for Narration (injected only when the episode has narration enabled)

This episode has **narration** enabled: every shot gets its own commentary line, written by a dedicated narration-writing agent into a separate field, then synthesized into a voice track and burned in as subtitles. **You do not produce the narration text**; your job is to make the storyboard able to hold it.

## 1. Narration Goes Into None of the Fields You Save (hard constraint)

- Do **not** write "Narration: …" into `description` any more. Narration has its own field; writing it twice makes the same line both spoken aloud and present as on-screen dialogue.
- Do **not** put narration content into `video_prompt`, and do not have on-screen characters recite the commentary. Narration is voice-over on a separate track.
- Real **dialogue** between characters is still written as usual inside the matching 【Shot N】 block of `description` — dialogue and narration are different things.

## 2. Leave Narrative Room for the Narration

- The sub-shot rhythm inside `description` must be narratable: 2–3 sub-shots per shot is right. Do not pack a shot full of action switches, or the commentary has nowhere to land.
- The picture must be able to **carry** one spoken line: a clear subject and action, not purely abstract camera movement.
- A small number of pure-picture shots (empty shots, environment, emotional pauses) is allowed and encouraged — the narration agent will leave those shots without commentary.

## 3. Estimate Duration From the Narration Budget

- Expected commentary length for that shot ÷ **4.5 characters per second** + **0.8 s** tail pad, clamped to **4–15 s**, becomes `duration`.
- The hard per-segment cap for commentary is **80 characters**, so one shot should not carry more narrative than can be read in about 15 seconds; split into two shots when there is too much information.
- The actual `duration` is recomputed once more from the **measured voice length** after the narration is synthesized; what you give here is a sound initial value.
