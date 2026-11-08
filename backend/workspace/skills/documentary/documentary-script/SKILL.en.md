---
name: documentary-script
description: Screenplay-preparation addendum for documentary projects — the script body IS the narration draft (narration-first), dialogue-style rewriting is forbidden, years/names/attribution kept verbatim
---

# Documentary Projects: Screenplay-Preparation Addendum (narration-first)

This is layered on top of the `script-rewriter` base specification; in case of conflict, **this file prevails**.

In a documentary project the "script" is not a dramatic screenplay but a **narration draft**: the saved body text is taken segment by segment, verbatim, by the storyboard break-down,
and becomes each shot's narration (`narration_text`), which is then synthesized into voice-over and subtitles. Every word you prepare will ultimately be read aloud.

## Non-narration content (hard rule)

Identify and remove source blocks, copyright and licence notices, URLs and permanent links, contributors and editing history, bibliographies and citation notes (including ISBNs and publishers), templates, editorial notes and statements that material is not to be read aloud. For example, `Reference: a book, ISBN 123` must not appear in the body; spoken attribution such as “According to the travel account” must remain.

## 1. Three base-specification rules that fail for documentaries (hard rules)

- **No "dialogue-driven" writing**: the base rule "use dialogue to drive the plot, minimize narration" is **inverted** here — a documentary advances through narration,
  and the narration is the body text, not a supplement.
- **No dialogue lines**: any `CharacterName: (state) line` format is forbidden, as are attributed lines like "So-and-so said: '...'". A historical figure's actual words may appear only as **narration paraphrase**
  ("He wrote in his memorial that ..."), never as a separate dialogue line.
- **No scene headers**: do not write dramatic scene headers like `## S01 | INT · Café | Dusk`.
  The instruction returned by the `rewrite_to_screenplay` tool includes short-drama formatting guidance; documentary projects **ignore that formatting section** and follow this file's layout instead.

## 2. Fidelity (hard rules)

- **Add no facts**: no new characters, no invented dialogue, no psychological interiority, no invented detail scenes. If the source does not have it, do not add a single word.
- **Years, numbers, personal names, place names, official titles, treaty names and quotations are preserved verbatim** — no rewriting, no approximating, no unit conversion, no translation into modern names.
- **Author attribution and source phrasing are copied as-is** ("According to the Yiyu lu", "Tulishen wrote this on the return journey"); do not delete them into subject-less sentences.
- If you are unsure of a fact, or the source lacks it, it is better to omit a sentence than to fabricate.

## 3. Layout (prepare, do not rewrite)

The only permitted actions are four: **re-paragraphing, removing filler, fixing punctuation, and unifying proper-noun spellings**. Order always follows the source; the narrative sequence must not be rearranged.

```
【Opening】
In the autumn of 1715, the Winter Palace in Saint Petersburg was not yet complete, yet Tsar Peter I had already turned his gaze to the East.

Between the Dzungars on the northern line and the Qing on the southern line, the Irtysh was the only waterway that could carry an army into the interior.

【Expedition】
That winter, Buchholz was ordered to lead nearly three thousand men upstream from Tobolsk along the river.
```

- Use `【beat name】` markers to delimit narrative beats (opening / background / turning point / climax / closing, etc.); the storyboard cuts segments at beat boundaries.
- Every paragraph outside the beat markers is a **directly readable narration paragraph**:
  - each paragraph carries **exactly one complete idea**, kept within **80 characters or fewer** (a hard per-segment limit of the speech synthesizer; overly long segments are rejected by the storyboard);
  - paragraphs end at a period / question mark / exclamation mark; do not break a paragraph mid-sentence;
  - no parenthetical asides, no shot language (framing / angle / camera movement), no picture directions inside a paragraph — the picture is written by the storyboard.
- Output volume stays **essentially level** with the source (±5%); noticeably longer means you are expanding, noticeably shorter means you are deleting facts — both are regressions.

## 4. Steps

1. `read_episode_script` to read the original content.
2. `rewrite_to_screenplay` to fetch the source (use only `source_content`; ignore its short-drama format instruction).
3. Prepare the narration draft according to this file.
4. Self-check: no dialogue lines, no scene headers, no added facts, every paragraph ≤80 characters, years and names verbatim-identical to the source.
5. `save_script` to save.
