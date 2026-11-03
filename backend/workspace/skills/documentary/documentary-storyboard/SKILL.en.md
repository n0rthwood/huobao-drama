---
name: documentary-storyboard
description: Storyboard break-down addendum for documentary projects — two-column script (narration column copied verbatim / picture column describes only the picture), one information point per shot, no dialogue-style writing
---

# Documentary Projects: Storyboard Break-down Addendum (two-column script)

This is layered on top of the `storyboard-breaker` base specification; in case of conflict, **this file prevails**.

A documentary storyboard is a **two-column script**: the left column is narration (what is said), the right column is picture (what is seen). The two columns correspond one to one; within the same shot both must be about the same thing.

## 1. Narration column = the script body copied verbatim (hard rules)

In this project the script body **is the narration draft**. When breaking down into shots, cut the body into segments in order and write each segment **verbatim** into `narration_text`:

- **Copy word for word**: punctuation, years, personal names, place names and numbers all match the source exactly. No rewriting, no polishing, no abbreviating, no added words.
- **Cut at sentence boundaries**: you may cut only after a period / question mark / exclamation mark / semicolon; never break mid-sentence.
- **Add nothing, drop nothing**: every paragraph of the body must land in some shot; the concatenation of all shots' `narration_text`, in order, must equal the script body.
- Each shot is **≤80 characters** (a hard per-segment limit of the speech synthesizer). If a source paragraph exceeds 80 characters, split it into two adjacent shots at a sentence boundary.
- Picture-only shots (empty scenes, transitions, map establishing shots) may have no narration: leave `narration_text` empty; do not invent a narration line for them.
- The tool validates this: each `narration_text` must be found verbatim in the script body, in the same order as the body; rewritten text is **rejected on save**.

## 2. Picture column = `description` describes only the picture (hard rules)

- Do **not** write narration text in `description`, and do not write "Narration: ...". Narration has its own field; writing it twice means it gets read twice.
- A documentary has **no dialogue**: `CharacterName: "line"` is forbidden, and characters in the picture must not be shown speaking the narration.
- `description` states what the viewer actually sees: the subject, the action, changes within the frame (a map being unfolded, a column on the march, documents being leafed through).

## 3. One information point per shot

The boundaries of the break-down are determined by **information points**, not by duration: one shot makes one point clear, and cuts when the point is made.

Every shot states its information point in one sentence in `title` ("the Irtysh is the only waterway", "the Guards background decided command"),
and the picture must **be able to show that information point**:

- Geography / routes / ranges → the picture is a map, stating what must appear on it (rivers, lakes, fortresses, direction of march);
- A person's identity / origins → the picture carries identity symbols (uniform, sash, seal, regalia), not one man standing in an empty courtyard;
- Years / numbers / treaty names → the picture has a readable physical carrier (documents, inscriptions, artifacts) or an object that can be graphically emphasized;
- The course of an event → the picture is one moment of concrete action, not an abstract camera move.

If the information point and the picture do not match, **change the picture**, not the narration.

> This section is the skeleton. The full expression design (device enumeration, `must_show` validation, the overlay plan `overlay_plan`,
> deterministic clips) will be completed in a later version; until then, put the information point in `title` and the content to be shown in `description`.

## 4. Duration and beats

- `duration` = narration character count of the shot ÷ **4.5 characters/second** + **0.8 seconds** of tail padding, clamped to **4–15 seconds**; picture-only shots without narration take 4–6 seconds.
- `【beat name】` markers in the script are hard cut boundaries: one shot must not span beats.
- Do not stuff two information points into one shot to fill time, and do not split one sentence across two shots to be read.
