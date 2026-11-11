---
name: documentary-scene-prompt
description: Scene final-prompt addendum for documentary / historical subjects — the period / region / function triad, period accuracy, no modern objects
---

# Documentary / Historical Subjects: Scene Final-Prompt Addendum

This skill is injected only when the project subject is judged to be documentary / historical, and is layered on top of `scene-prompt`. The base layout (fixed-camera wide establishing shot, foreground / middle-ground / background layering, no people, `time` written out verbatim, the `{aspect_ratio} {composition}` returned by `read_scenes` written out verbatim) all remains in force.

The aspect ratio is a hard rule: the scene image is rendered at the project aspect. In a portrait project (9:16 / 3:4) the establishing shot is organized along the height — a gate tower, pagoda, gatehouse or courtyard must be **fully in frame with its top not cut off**, with sky and roof depth above and ground, steps and foreground dressing below; in landscape (16:9) keep the existing left-to-right plus depth spread. A wrong orientation or a missing aspect phrase is rejected by `saveSceneFinalPrompt`.

## 1. The Period / Region / Function Triad (all three must appear)

The prompt must let the reader deduce:

1. **Period**: the era to which the architectural form, structural materials, craft and furnishing styles belong (e.g. "late-17th-century Russian log construction", "Qing official timber frame") — write the concrete form, not "ancient style";
2. **Region**: geography, climate, vegetation, soil or urban fabric (e.g. "the edge of the Siberian taiga, frozen ground and remnant snow");
3. **Function**: what the space is used for (negotiation hall / post station / workshop / army tent / archive); the function determines the core furnishings and their fixed relative positions.

## 2. Period Accuracy (prohibitions)

No element later than that period may appear:

- Power lines, electric lamps, air conditioners, metal window frames, glass curtain walls, asphalt paving, concrete kerbs, zebra crossings;
- Plastic, stainless steel, modern hardware, machine-made standard parts;
- Modern-typeface signage, printed posters, modern vehicles.

Materials and craft must match the period: hand-forged ironwork, hand-planed timber, rammed earth and stone masonry, period light sources such as oil lamps / candlelight / hearth fire.

**Traces of use are a hard rule**: buildings and furnishings must have their weathering and wear written out — grey-weathered cracked logs, axe-hewn rather than sawn faces,
moss and water stains, mud and ruts, soot marks, polished thresholds and handles. Without these the model paints a brand-new reconstruction site:
the round-2 "Lake Yamysh fort" sample was judged in blind review as "the wall logs are far too fresh, the sawn faces are straight, there is no weathering or moss,
which contrasts in age with the weathered boat beside them — it looks like a reconstruction site rather than a period location".

## 3. Light Sources and Atmosphere

Describe `lighting` with the **light sources actually available in that period**: daylight, moonlight, candlelight, oil lamp, hearth fire, torch. Modern fixtures and artificial coloured light are forbidden. The light must still agree with `time`.

## 4. Prohibitions (layered on the base specification)

- Any person (including backs, silhouettes, reflections, figures in pictures) — the base specification's highest-priority rule stays in force;
- Readable modern text, watermarks, signatures;
- URLs, domains, source annotations.
