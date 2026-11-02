---
name: narration-script
description: Narration (commentary) writing standard — episode-wide narrative spine, shot-to-shot linkage, matching the picture, length and rhythm budget, documentary fidelity to the source, opening and close
---

# Narration Writing (episode → per-shot narration_text)

## 0. What Narration Is

Narration is the **only narrating voice** the audience hears, and it is also the subtitle burned onto the picture. It does not restate the image; it supplies what the image cannot give: time, place, identity, motive, cost, consequence, scale, causation. An episode's narration, read end to end, must work as a commentary piece that stands on its own without the picture.

## 1. Episode Structure (fix the spine, then write shots)

After reading the script and all shots, settle three things in your head before writing:

1. **What this episode is about**: the trunk event, statable in one sentence.
2. **The beats of the spine**: opening (establish the stakes) → escalation (cost and resistance) → turn → close (result or aftertaste). Assign every shot to one beat.
3. **Which shots stay silent**: empty shots, pure atmosphere, shots where the previous line's tail is still ringing. These get `narration_enabled: false`; they are part of the rhythm, not an omission. No more than a quarter of the episode's shots.

## 2. Writing a Single Shot

- **1–2 sentences per shot**, usually no more than 2. At a key turn a single short sentence is enough; let the picture hold a beat by itself.
- **Match this shot's picture**: what a shot says must be what it shows. March on screen → do not discuss a treaty; a map → talk bearings and distances; a face → talk about that person's situation and choice.
- **Shot-to-shot linkage**: a shot must pick up the question, turn or suspense left by the previous one; they must not talk past each other. Where `continuity_boundary` is `continue`, the narration continues the previous line (the second half of the same sentence, or the same thought pushed forward) — do not start over, do not repeat what was already said.
- **Opening shot**: establish time, place and the stakes within one sentence. Do not lay out background first and ease in.
- **Closing shot**: return to the spine, give the result or an aftertaste. Do not cut off abruptly, and no "and that is the story of …" style summation.

## 3. Length and Rhythm Budget (hard constraints)

- Pace is reckoned at **3.8–5.1 characters per second** (documentary commentary standard).
- Target band: `duration × 3.8 ~ duration × 5.1` characters. A shot's duration is recomputed automatically from what you write and clamped to 4–15 seconds, so **let the content decide the length**.
- **At most 80 characters of the target content language per shot** — the hard per-segment cap of the speech synthesis service; longer text is rejected by the save tool. A 15-second shot at the top of the pace band is about 77 characters, which fits.
- Alternate long and short sentences. Do not fill every shot to the cap; uniformly long sentences sound like reading from a page.

## 4. Fidelity to the Source (documentary standard, hard constraint)

- State only facts **already present** in the script. Do not add people, place names, numbers, dates, causation or judgements.
- Anything the script treats as the author's conjecture, legend, single-source or disputed must **keep its attribution** in the narration: "according to …", "by … account", "the records are silent". Never turn conjecture into settled fact.
- When a detail is uncertain, leave it out. Omission is not an error; invention is.

## 5. Language

- One idea per sentence. Avoid clause nested in clause — this is to be spoken, not read.
- On a proper noun's first appearance, give the minimum identification needed (who, which side, what it is); afterwards use it bare.
- **No picture-direction language**: "in the frame", "the camera", "we see", "at this moment" are all forbidden.
- **Restraint**: no lyricism, no sentimentality, no verdicts handed to the audience. Delete every adjective you can. Emotion is carried by the facts and the picture.
- Write numbers the way they are spoken ("seventeen twenty" rather than "1720"), so synthesis and subtitles agree.

## 6. Self-Check (run every item before saving)

1. Stitch the whole episode's narration in shot order and read it once: is it a coherent commentary piece? Any break, repetition or self-contradiction?
2. Does each shot's narration talk about the same thing as that shot's `description`?
3. Do the `continue` shots really continue the previous line?
4. Is there any statement that is not a fact from the script? Is conjecture still attributed?
5. Is any shot over 80 characters? Is any shot far below `duration × 3.8` characters (meaning it should be merged or left silent)?
6. Does the first shot establish the stakes? Does the last shot return to the spine?
