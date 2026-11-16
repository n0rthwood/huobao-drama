---
name: documentary-bridge
description: Documentary narration bridge pass — audit every adjacent paragraph boundary and add at most one constrained bridge sentence, only when it can be written with zero new facts
---

# Documentary narration: bridge pass (stage 2)

You receive the **narration draft already produced by the faithful rewrite stage**, plus the raw source material frozen for this run.
Your only job: **go through every adjacent paragraph boundary and decide whether a connecting sentence is missing, and write one only when it is safe**.

You do not rewrite the body. The server inserts only the bridges you declare at computed offsets of the predecessor text,
which is preserved byte for byte; you return the JSON of section 4 only, never body text.

## 1. Hard limits

- **Never edit, delete or reorder** stage-1 body text. Tidying, polishing, merging or re-splitting is not part of this stage.
- **Zero new facts**: a bridge may only express a relation **already supported by the two adjacent paragraphs**.
  Never import a fact that exists in the raw material but not in those two paragraphs (names, years, numbers, places, actions, causal conclusions).
  Operational facts such as "samples were taken", "measurements were made", "then he ordered" are new facts, not relations.
- **At most one sentence per boundary.** A sentence-final mark (。 ！ ？ ! ? or an English full stop .) may appear only at the very end; a second sentence fails the stage. A decimal point is not sentence-final; avoid ambiguous abbreviations.
  A semicolon does not count as sentence-final, but do not use one to staple two statements together.
- A bridge is **not exempt** from the 80-character sentence limit: **a bridge longer than 80 characters fails the stage**; a bridge without a sentence-final mark continues the host's edge sentence, and if that combined sentence exceeds 80 characters it fails as well.
- A bridge can only land in one of the two adjacent paragraphs: the **end of the left paragraph** (summarising, closing → belongs to the left group) or the **start of the right paragraph** (introducing the next point → belongs to the right group).
  A bridge **never forms its own paragraph**: that would invent an extra logical group, and reporting `standalone` is a contract violation that is sent back for correction.
- Keep it within **25 spoken characters** where possible (spoken characters = characters left after removing whitespace and punctuation). Exceeding 25 only raises a warning; it never fails the stage.
- Sources, licences, permalinks, contributors and usage notes must **never** appear in a bridge, even though they may appear in the raw material you can see
  (such content was stripped from the body automatically before stage 1, but remains in the raw material). The raw material is for fact-checking only; it is not material you may copy back,
  and **a bridge that carries it back fails the stage outright**.

## 2. When to bridge, when not to

**Bridge** when a relation is **supported by the adjacent content itself, left unsaid, and its absence hurts comprehension** —
typically "phenomenon → why we now look at it differently" or "method → which question its result answers".

**Do not bridge** (default — the vast majority of boundaries belong here) when:
- the two paragraphs are two logical groups the author already separated, and **most boundaries are a natural topic progression** that viewers follow without a cue;
- the move is only chronological or a section/heading change;
- the paragraphs form a clear parallel or enumeration;
- the relation is already stated by the existing wording — **do not restate it with another template**.

Every extra bridge adds seconds of narration with no new information. Bridging every boundary ("back to Yermak", "so who exactly were…?") is failed polishing, not diligence.

**Needed but unsafe**: when a real gap exists but cannot be expressed reliably with zero new facts,
report `needed_but_unsafe` honestly. Never downgrade it to `no_bridge` to look complete, and never invent a relation to fill it.

## 3. Shot attribution

- Introduces the next point → `next_head` (head of the next shot; the bridge goes at the start of the right paragraph);
- Summarises, limits or closes → `previous_tail` (tail of the previous shot; the bridge goes at the end of the left paragraph);
- These are the only two: whichever paragraph the bridge joins, it belongs to that paragraph's logical group. There is no stand-alone bridge.

Attribution is advice for the later narration skeleton; it does not edit the storyboard.

## 4. Output format (strict JSON, no code fence, no commentary)

```json
{
  "boundaries": [
    {
      "boundary_id": "B01",
      "left_paragraph": "P01",
      "right_paragraph": "P02",
      "relation": "phenomenon → principle (relation unstated)",
      "decision": "inserted",
      "reason": "The left paragraph describes the remains; the right jumps straight to dating principles, so the shift from object to date is missing",
      "bridge_text": "These remains do not announce their own age.",
      "placement": "start_of_right",
      "shot_attribution": "next_head"
    }
  ]
}
```

- `boundaries` must cover **B01…Bn−1 in the given order, none missing, none extra**, with the exact `left_paragraph` / `right_paragraph` IDs supplied to you.
- `decision` is one of `no_bridge | inserted | needed_but_unsafe`.
- `placement` is one of `end_of_left | start_of_right`, matching `previous_tail` / `next_head` in section 3; it is required for `inserted`, and there is no third value.
- `shot_attribution` is one of `previous_tail | next_head`.
- `relation` and `reason` are required on every entry; `reason` must be a **checkable editorial justification** (what each side says, what relation is missing), not a replay of your thinking.
- When nothing is inserted, `bridge_text` and `placement` are `null`; `shot_attribution` is `null` for `no_bridge`,
  while `needed_but_unsafe` may keep an attribution suggestion for the later human pass.
