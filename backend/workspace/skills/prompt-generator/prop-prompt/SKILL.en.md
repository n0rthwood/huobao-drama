---
name: prop-prompt
description: Prop final prompt specification — a single object on white, shot from a standard product-photography angle: accurate proportions, complete edges, a background that carries no narrative
---

# Prop Final Prompt (single object on white · standard product photography)

What is generated is a single-object shot on a white background (product shot): **use a standard product-photography angle**, with only the prop itself in frame, isolated on a pure white background, **mixed with nothing else** — no other objects, no characters, no scene environment, no hand holding it.

Three hard requirements:
1. **The proportions of every part of the object are accurate** — no exaggeration, deformation or stylized stretching; the prop's relative size relationships must be true to life
2. **Complete edges** — the prop is fully in frame with margins all around, and no part of it may be cropped by the frame edge
3. **The background carries no narrative content** — the pure white background is only a backdrop, with no sense of place, no plot hint, no decorative elements

## Output Structure (assemble one coherent passage in this order; language follows the conversation language instruction)

```
single-object product shot, standard product-photography angle, [prop name + material/color/shape/size + degree of wear and tear details],
the proportions of every part of the object accurate, isolated on a pure white background, centered and fully in frame, edges complete and uncropped,
background clean and carrying no narrative content, no other objects, no characters, no scene,
soft even studio light, light shadows, high detail
```

## Generation Rules

- Build around the prop's `name` and `description`: material, color, shape, size, newness, marks of wear are all **rendered item by item**; relative size information in the description (e.g. "the bell body is about twice the length of a guinea pig's forepaw") is converted into a real proportion visible inside this image
- Standard product-photography angle: a slightly high 3/4 angle (so the top and the side are both readable); flat props (paper, documents, photos, newspapers) are laid flat and shot straight from above
- **Paired props** (where the description states "a pair of two, completely identical"): both pieces side by side in the same frame, evenly spaced, identically oriented and completely identical — this image is the appearance anchor for "a pair", so never draw only one
- **Wearable props** (hats, glasses, sunglasses, helmets): use a 3/4 angle that shows the front and the side structure at once (temples, the inside of a hat brim and other wear-related structures must be visible) so that shots of a character wearing it have a reference
- The single object is centered and fully presented with margins all around, with accurate proportions and complete edges
- Soft even studio light, light shadows, high detail
- Describe only the object itself — never mention the plot, characters or purpose
- Output in the target language specified by the conversation language instruction; **never** use "cinematic" style vocabulary (a prop image is a product shot, not a film still)

## Reference Image Budget (hard constraint)

- Prop images are the source of the storyboard's reference images: a shot may use at most 9 reference images, the first keyframe already takes 1 during video generation, leaving scene 1 + characters N + props M ≤ 8
- When over budget, the storyboard layer drops by priority: scene > characters present > props that are used or shown in close-up > props that are merely visible; a dropped prop loses both its binding and its @ mention
- The selection happens at the storyboard layer — this skill never reduces the number of props; better to have an image and not need it than to need it and not have it

## Prohibitions

- A hand holding it, characters, other objects or a scene environment in frame
- Packaging, bases, display stands (unless they are part of the prop itself)
- Text, watermarks, signatures (printed text and patterns on the prop itself may be kept and described)
- Environmental reflections, colored light
- Exaggerated perspective, deformation, distorted proportions, cropped edges

## Saving

Call `save_prop_final_prompt`: the prompt argument contains no style words — **the project's visual style is automatically injected by the tool at the very front of the final prompt**.
