---
name: extractor
description: Rules and methods for extracting characters, scenes, and props
---

# Character, Scene & Prop Extraction Guide

## Guiding Principle: Everything Serves Visual Continuity

Every asset you extract becomes an image-generation reference that storyboards cite with @. When deciding "should I extract this, and how do I word it", ask only one question: **does this information help the picture stay consistent across different shots?** Descriptions must be definite and unambiguous — writings such as "or", "possibly", "about", "light pink or beige tones" that hand the choice back to the model are forbidden; lock it down once and for all.

## Character Extraction Rules

Extracted character fields (corresponding one-to-one with the `save_dedup_characters` tool parameters):
- **name** (required): the character's full name
- **role**: the character's positioning — protagonist / supporting / extra
- **appearance**: appearance description (200-400 characters) — gender, age impression, facial features, physique, **relative body size** (e.g. "roughly two thirds the height of Papa Pig"); when several characters share a frame this is the key information that prevents proportion drift. Write only **static visible features**; convert personality into one line of permanent bearing (e.g. "a cold gaze, rarely smiling"), do not write behavioural processes ("holds his breath in concentration while training" and similar time-based descriptions are noise for single-frame image generation)
- **styling**: **base styling** — the character's regular hairstyle, regular clothing, regular accessories. Once the base look is established it is never rewritten (the tool preserves existing non-empty fields); it must match the character asset image. If you find the text conflicting with the image, report it to the user in your closing message; do not silently change the field to accommodate the image
- **styling_version**: **per-episode styling version** (optional) — fill this in when the script gives the character a complete new outfit (vacation outfit, snow gear, formal dress, etc.): `name` (a 2-6 character version name, e.g. "Hawaiian Vacation Outfit") + `description` (a definite description of the whole outfit: the cut, colour and pattern of every single item). A complete outfit always goes through a styling version and **never** into styling; hats, glasses, sunglasses, helmets and other accessories that can be put on and taken off separately are not styling versions — extract them as props
- **description**: backstory and character relationships (optional supplement)

## Scene Extraction Rules

Extracted scene fields (corresponding one-to-one with the `save_dedup_scenes` tool parameters):
- **location** (required): the specific place name. **One physical space = one scene**: "at the living room desk" and "in front of the living room sofa" are camera positions inside the living room, not independent scenes — always use "living room"; framing of sub-areas is left to the shot-size and camera-position language of the storyboard
- **time** (required): a concrete time of day — early morning / morning / noon / afternoon / dusk / evening / late night, or the period the script states explicitly. If the script does not say, infer it from the plot; **never leave it empty**. The time of day goes in `time` only — writing it into `lighting` instead does not count; only the same location at a different time period counts as a new scene
- **prompt**: scene description — the space, the fixed furnishings and their **relative positions** (pure background, no characters). Large fixed items the plot will use (TV, desk, sofa, window) must have their positional relationships stated; **movable objects that characters pick up or use (cups, books, newspapers, dumbbells, mats) must never be written into the scene** — they are props, and baking them into the scene image makes them impossible to control separately
- **lighting**: scene light and shadow — light sources, colour tone, brightness, atmosphere; it must match `time` (an "afternoon" scene gets afternoon light, never night-time lamps)

## Prop Extraction Rules

For the detailed decision criteria, category enumeration and description style see the **prop-extraction** skill, which must be followed. Key points:
- Any object the script explicitly describes, that a character holds / uses / wears, that appears across shots, or that is stood on or looked into must be extracted, and there is **no quantity limit** — how many are used per shot is decided at the storyboard layer within the 9-reference-image budget, not compressed at the extraction layer
- A pair of objects (two dumbbells) counts as one prop; a complete outfit is not a prop (it goes through the character styling version)

## Usage Steps

1. Call `read_script_for_extraction` to read the current episode's script
2. Call `read_existing_characters` / `read_existing_scenes` / `read_existing_props` to see the project's existing assets and their links to the current episode
3. Extract only the characters, scenes and props the current episode actually involves
4. Call `save_dedup_characters` / `save_dedup_scenes` / `save_dedup_props` to save them and automatically link them to the current episode

## Current-Episode Rules

- The goal is to complete the assets the "current episode" needs, not to rescan the whole project
- Anything already present in the project but not linked to the current episode should be reused and linked to the current episode
- Deduplication: characters / props match by exact name; scenes match by [location + time period], and when location names contain one another prefer treating them as the same space and reuse it
- Near-name deduplication: when a name carries a parenthesised qualifier or an alias, compare by the main body before the parenthesis; the `normalized_name` / `normalized_location` returned by `read_existing_*` is the normalised result — judge by it
