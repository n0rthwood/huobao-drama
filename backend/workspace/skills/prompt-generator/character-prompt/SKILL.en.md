---
name: character-prompt
description: Character final prompt specification — a frontal face close-up plus a three-view sheet (front / 90° side / back) as the base-look anchor, and the rules for rendering styling-version images
---

# Character Final Prompt (frontal face close-up on the left + three views on the right)

What is generated is a character reference sheet with a fixed composition:

- **Left: a frontal face close-up** — a frontal close shot of the head and shoulders, with facial features, hairstyle and skin texture clearly visible, serving as the anchor for face recognizability
- **Right: the front, the 90° side and the back shown side by side as three equal-height full-body views** — three full-body views of the same character side by side at equal height, with the tops of the heads and the soles of the feet aligned

**Core principle: consistency > beauty.** This image is the look anchor for every later character image and video reference, so it must be neutral, clear and reusable.

## Base Look vs. Styling Version

- This three-view sheet shows the character's **base look**: the regular hairstyle, regular clothing and regular accessories, consistent with `styling` (the base styling). **Single-episode outfits (holiday wear, snow gear and other complete outfits) do not go into the base-look image**
- The base look must match the appearance/styling text exactly; when the text is found to be ambiguous ("light pink or beige"), report to the user first and never pick one of the two yourself and render it
- Single-episode outfits go through a **styling-version image** (see the end of this document), which storyboards reference automatically via the version-selection mechanism

## Output Structure (assemble one coherent passage in this order; language follows the conversation language instruction)

```
character reference sheet, a frontal face close-up on the left, the front, 90° side and back shown side by side as three equal-height full-body views on the right,
the close-up and the full-body views are the same character, full body in frame, neutral A-pose, the three full-body views side by side at equal height with tops of heads and soles of feet aligned,
[sense of age + sense of gender + build], [facial features], [hairstyle], [clothing + accessories],
the face, hairstyle and clothing of the frontal close-up and the three views are completely identical,
pure white background, soft even light, cinematic quality
```

## Description Order Rules

Put **the most recognizable features first**, rendering every key element of `appearance` and `styling` in this order, omitting none:

1. Identity anchor: sense of age, sense of gender, build
2. Facial features: face shape, eyes, other distinctive traits — the frontal close-up depends on this part above all
3. Hairstyle: color, length, style
4. Clothing: cut, color, material, condition
5. Accessories: only the recognizable ones, never piled on

Rules:
- **Definiteness**: indefinite phrasings such as "or" and "possibly" are forbidden; every color and cut is settled once and for all
- A character's personality is turned into outward bearing and demeanor description; personality words never appear directly
- Write out the hand and foot morphology of non-human characters clearly (toe count, whether hands and feet share the same form) — this is the source information for later limb stability

## Composition and Consistency

- The frontal close-up on the left: facing the camera straight on, neutral expression, from the top of the head down to the shoulders fully in frame
- The three full-body views on the right: front, 90° side, back, **side by side at equal height with even spacing**, tops of heads and soles of feet on the same horizontal line
- State explicitly that "the face, hairstyle and clothing of the frontal close-up and the three full-body views are completely identical"
- Neutral stance, natural expression; soft even studio light, no dramatic lighting
- Output in the target language specified by the conversation language instruction

## Prohibitions

- Dynamic poses, exaggerated expressions, holding props, sharing the frame with someone else
- Cropping the body (full-body views must run from the top of the head to the soles of the feet; the close-up must include head and shoulders in full)
- Text, labels, watermarks, signatures
- Heavy shadows, colored background light, background props

## Styling-Version Images (image_edit outfit change)

When an episode registers a styling version (styling_version) for a character, use image editing on the **base-look image** to produce one character image "wearing that outfit":

- Core prompt phrasing: "keep the character's face, facial features, fur/skin color, body type and hairstyle completely identical to the reference image, and only change the clothing to: [every item of the styling version's description rendered out]"
- Full body in frame, neutral stance, pure white background, soft even light — the same spec as the base-look image
- Change only the clothing: do not change the face, do not change the body type, do not add accessories (hats, glasses and the like are props and do not go into the styling-version image)
- After rendering, a human confirms on the image that "the outfit matches the description and the face has not drifted" before it is used in storyboards

## Reference Image Budget (hard constraint)

- Character images (including styling-version images) are the source of the storyboard's reference images: a shot may use at most 9 reference images, the first keyframe already takes 1 during video generation, leaving scene 1 + characters N + props M ≤ 8
- When over budget, the storyboard layer drops by priority: scene > characters present > props that are used or shown in close-up > props that are merely visible; a dropped prop loses both its binding and its @ mention, so never leave a name that is "@-mentioned but not bound"
- One character occupies only one reference image: the system automatically picks the version according to `asset_version_selection`, so never bind the base look and a styling version at the same time

## Saving

Call `save_character_final_prompt`: the prompt argument contains no style words — **the project's visual style is automatically injected by the tool at the very front of the final prompt**.
