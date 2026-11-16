---
name: design-group-plan
description: The first pass of documentary storyboard design — plans per logical group (one natural paragraph of the narration draft) which image each shot in the group uses, when the image is fully presented, when only a brief hint is given, and when the shot goes to the generated segment
---

# Documentary storyboard design: group-level visual planning

What you receive is **one logical group**: one natural paragraph of the final narration draft. The original author uses one paragraph to express one idea,
and this paragraph has already been cut into several shots (each shot is one sentence or a few sentences of narration, the audio is done, and the durations are measured values).

Your task: **make one visual plan for the whole group first**; the per-shot design-card step then writes according to your plan.
You do not write design cards or prompts, only the JSON in section 5.

## 1. Why plan per group

The finished film is spliced by shot number with **hard cuts**. Every shot's layer segment starts again from a **clean, full-frame base image**, and layers drawn in the previous shot do not carry over.
If every shot goes "map first, then live action", what the audience sees is: the same map → live action → the same map → live action……
cutting back and forth, marking time. This is not a problem with the assets, it is a problem of **not coordinating per group**.

## 2. What each of the two picture types does (criteria)

- **Layer segment = visual aid and memory anchor.** Things that narration alone cannot make the audience remember — where a place is, how a river runs, how large an extent is, who is who, which year — are
  marked on the base image (map / archival original / object plate) with explanatory text, helping the audience understand and remember.
  - On the **first mention** of a geographic location / extent / route / object: **fully establish** it in one shot — mark it on the base image and add explanatory text
    (an anchored place-name label, or a template text box).
  - On the **immediately following re-mention** the audience already has the concept: only a **brief hint** is needed, or no hint at all. The means of a brief hint:
    ① picture-in-picture (place a small image on another base image, `pip`); ② combo D: act out live action first and land on the picture at the end to pin the result;
    ③ narration alone (no layer in this shot). **Never** put the same picture full-frame again in every shot.
- **Generated segment = imagined scenes, atmosphere, immersion.** The process of an event, people's actions, the texture of the environment. Do not use the generated segment to act out geography.
- "This happened somewhere" is **not** a reason to put a map up — almost everything happens somewhere.

## 3. Segment combinations

- **A** layer segment only: locating, inventory, genealogy, years, a paragraph's closing frame. Measured ≤30 s.
- **B** generated segment only: telling what happened; the first choice when this shot has no new entry that must land on the picture. Measured ≤15 s.
- **C** layer segment → generated segment: locate first, then enter the scene. Use it **only when** this shot has new entries that must land on the picture. Measured ≤45 s.
- **D** generated segment → layer segment: enter the scene first, then pin the result back onto the picture at the end (capture, victory, casualties, years),
  or set up an "image → image" junction for the next shot (when the next shot opens on the same image, this shot uses D and stops on the image, so the cut is not "live action → image"). Measured ≤45 s.

## 4. Layout rules (verified one by one by the server; failures come back to you)

1. **Exactly one** `shots` entry per shot in this group, no more and no fewer. A shot marked "locked" (edited by a human or already confirmed) must **copy** the given combination and base image as they are.
2. **The combination must hold the measured voice-over**: B ≤15 s, A ≤30 s, C/D ≤45 s.
   A shot over 15 s with no new entries: use a **non-map base image** (archival picture, scene still, object plate) with a text box in C or D, and do not return to the map.
3. Shots with a layer segment (A/C/D) must give `base`, and `mode` cannot be `no_layer`; B has `base` null, `mode` `no_layer`, and no picture-in-picture.
   The base image and the picture-in-picture may only use assets in the asset inventory that **have an image**; the picture-in-picture cannot be the same image as the base.
4. **Cut-backs**: the previous shot did not end on a layer segment of the same image, yet this shot opens on a base image that **has already appeared** (A or C). A cut-back must satisfy one of:
   - this shot is assigned new entries (written into `geo_additions`, assigned to this shot);
   - **re-entry**: at least 3 shots have passed since this image last appeared (a longer gap, or the narration returns from another thread and needs to re-locate).
   Otherwise switch to B, D or a non-map base image, or give the hint as a picture-in-picture on another base image.
5. **At most 2 consecutive shots may open as a cut-back on the same base image** (counted across groups: the "earlier shots" listed under the asset inventory also count). The 3rd shot must change technique.
6. Two consecutive shots both on the same image's layer segment, the previous one ending on the layer and this one opening on the same image (A→A, D→A, A→C, D→C):
   this is **one continuous map scene**, not a cut-back; this shot continues from the state already drawn in the previous shot (carry-over) and does not redraw from scratch.
7. Groups that are inventories, genealogies or parallel enumerations may have longer pure-layer runs (consecutive A).
8. New entries (`geo_additions`): place names / water systems / extents / route advances / years / person or object descriptions that appear for the **first time** in this group's narration
   and must land on the picture; each is assigned to **exactly one shot**, and that shot must have a layer segment. Entries already established earlier do not count as new.
9. When a map asset carries `map_pip`: talk about overall trend / extent / orientation with the **overview**, and focus on one geographic feature with the matching **detail**;
   a detail needs the overview alongside it (an adjacent shot in the same group establishes the position on the overview, or the overview is used as a picture-in-picture on the detail base image).

## 5. Output (strict JSON, no code block, no explanation)

```json
{
  "task": "One sentence: what the audience should understand / remember after this group",
  "geo_additions": [{ "text": "Confluence of the Tura and Tobol (ambush site)", "storyboard_id": 997 }],
  "asset_roles": [
    { "asset_kind": "prop", "asset_id": 259, "name": "Siberian advance strongpoint network map", "role": "establish",
      "establish_storyboard_id": 991, "exit_after_storyboard_id": 997, "note": "Main expedition route map: #61 establishes the southward leg, #62 points out the ambush site, then exits" }
  ],
  "shots": [
    { "storyboard_id": 991, "combo": "C", "base": { "asset_kind": "prop", "asset_id": 259 }, "pip": [],
      "mode": "new_items", "task": "Carry over the drawn route, add the new southward leg from the Tagil to the Tura mouth" },
    { "storyboard_id": 992, "combo": "C", "base": { "asset_kind": "prop", "asset_id": 269 }, "pip": [],
      "mode": "carry_only", "task": "Measured 15.7 s, no new geography: fleet engraving plus a text box, transitioning into the night ambush live action" }
  ],
  "junction": "Seam with the previous group: the previous group ends on #60's live action, this group's first shot returns to the route map and advances a new leg; the cut works"
}
```

- `role`: `establish` (fully established in one shot of this group) / `hint` (a brief hint only: picture-in-picture, a D ending that lands on the picture, text) / `background` (scene setting).
- `mode`: `new_items` (this shot adds entries to the picture) / `carry_only` (only carries over the existing state or serves as background, adding nothing) / `no_layer` (no layer segment).
- `storyboard_id` always uses the storyboard IDs given to you, never shot numbers.

## 6. Example (ep 27 expedition passage, excerpt)

Not acceptable: #59–#75 are all C and all open full-frame on "Siberian advance strongpoint network map" — #60 tells of discipline and of men drowned in the river, #63–#65 tell the course of the same ambush site,
#70 tells of finding grain in the town; none of the narration carries new geographic information, yet every shot cuts back to the map once and the state resets to zero every time.

Acceptable: #59 C establishes the mountain-crossing route and the winter camp on the route map for the first time; #60 B (discipline, no new geography); #61 C carries over and adds the southward leg;
#62 C points out the ambush site (consecutive cut-backs at the limit); #63 (15.7 s, no additions) C with a fleet engraving plus a text box; #64, #65 B;
#66 C adds the advance toward Kashlyk; #67 D acts out the standoff first and lands on the picture at the end to pin the decisive battle site; #68 B; #69 D lands the result on the picture and lights up Kashlyk;
#70–#72 B; #74 C adds the return route; #75 A closes with "about 90 km from the starting point".
