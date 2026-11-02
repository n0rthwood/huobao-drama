---
name: documentary-prop-prompt
description: Prop final-prompt addendum for documentary / historical subjects — period / use / material and craft, no modern machining traces
---

# Documentary / Historical Subjects: Prop Final-Prompt Addendum

This skill is injected only when the project subject is judged to be documentary / historical, and is layered on top of `prop-prompt`. The base layout (single object on white, standard product-photography viewpoint, accurate proportions, complete edges, background carrying no narrative) all remains in force.

## 1. Period / Use / Material and Craft (all three must appear)

The prompt must let the reader deduce:

1. **Period**: which era the object's form belongs to (e.g. "late 17th century", "Kangxi era") — write the concrete form, not "ancient style";
2. **Use**: what it was used for at the time (boundary-demarcation document, surveying instrument, tally, seal, weapon); the use determines the shape details;
3. **Material and craft**: hand-forging, casting, joinery, parchment, mulberry paper, lacquer, gilding, chasing, wax sealing, and so on, together with traces of use (wear, oxidation, creases, worm holes) — all pinned down.

## 2. White Background and Structural Completeness (hard rules added after round-2 blind review)

- **Background**: the prompt must explicitly say "pure white shadowless background, no gradient, no cast shadow". Two of the three round-2 samples were judged in blind review as
  "near white but with a cast shadow and a grey gradient" — writing only "white background" is not enough.
- **Structural completeness**: the load-bearing and fastening structures of the object must be written out item by item, otherwise the model generates an assemblage with missing parts.
  A long gun must state "the forestock covers the full length of the barrel, a ramrod and its channel sit beneath the barrel, barrel bands hold it in place";
  the round-2 musket sample, lacking these, produced the impossible structure "the barrel entirely bare behind the lock, no forestock and no ramrod".
- **The mechanism is pinned to the period**: for a matchlock write "a serpentine on the side holding a slow match, a touch hole and a priming pan" — **do not** write a flint cock and frizzen;
  conversely, a flintlock gets no match cord. Get the mechanism words wrong and the image will show a lock from the wrong era.
- **Accessories**: the base specification is a single object on white; it is allowed, and only allowed, to write accessories that are inseparable from that object (drumsticks, scabbard, pen),
  stating that the accessory belongs to the same object and placing it in frame with the main body.

## 3. Period Accuracy (prohibitions)

- No modern machining traces: laser-cut edges, machine screws and standard parts, injection-moulded parts, bright electroplating, printed barcodes;
- No materials later than the period (plastic, stainless steel, synthetic rubber, the bleached whiteness of modern paper);
- Describe the appearance of writing on the object in the script and language of the time — **do not** write it as readable modern text.

## 4. Consistency with the Sources

Form details in the prop's `description` that come from verified research must land item by item and must not be replaced with improvisations; where the form is uncertain, write nothing rather than inventing patterns and inscriptions.

## 5. No Source Pollution

The prompt must not contain a URL, a domain, "according to Wikipedia", "source" or any other source annotation.
