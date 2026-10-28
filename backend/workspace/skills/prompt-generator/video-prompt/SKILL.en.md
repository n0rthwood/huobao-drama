---
name: video-prompt
description: Video prompt specification — produces video-generation prompts split by time, allowing cuts inside a segment, with the limb state written out segment by segment
---

# Video Prompts (storyboard segment → video_prompt)

From a single storyboard segment's description (containing the `【镜头N】` sub-shot structure plus dialogue/narration), `atmosphere` and `duration`, produce the `video_prompt` that drives AI video generation. **One storyboard segment = one 8–15 second video, cuts allowed inside**; but it **never crosses scenes** and never flashes back.

## Format

**The first line of `video_prompt` is an information header**: first introduce which characters and scene this video contains, then the time-split lines follow. Characters, scenes and props are always referenced with @.

```
Characters: @XiaoMing, @XiaoHong; scene: @Cafe; props: @Letter.
0-3s: @Cafe, close shot, static camera, @XiaoMing sits in the window booth, his right hand pinching the @Letter resting on the table, his left hand on the rim of the cup, both legs naturally together under the table, head lowered reading the letter, brow slightly furrowed.
3-6s: cut to a wide shot of the doorway, the doorbell rings, @XiaoHong pushes the door and walks in, her right hand on the door frame, her left hand carrying a bag, both legs stepping into the shop.
6-9s: cut back to a medium shot, @XiaoHong walks to the table and sits down, both hands on the tabletop, @XiaoMing raises his head, his right hand still pinching the @Letter, and says: "You finally came."
```

Information-header rules:
- List only the characters actually appearing in this storyboard segment and the scene and props bound to it
- The header is its own line ending with a period; the time splits follow after it

Split into 3-second segments, one per line, separated by line breaks, with continuous time ranges (no overlap, no gap).

## Opening Transition Segment (works together with the transition-prompt skill)

A carried-over shot (`inherits_first` is true) may carry an **opening transition segment** (produced by the transition-prompt skill, written at the start of the video prompt; submitted duration = min(content duration + transition duration T, 15s)):

- **Do not delete it and do not rewrite its structure**; the transition text stays at the start according to the transition-prompt skill's rules
- This skill's limb-state and one-action-per-segment rules **apply segment by segment starting from the first content segment after the transition segment**
- The transition segment likewise follows the Reference Rules' per-segment asset anchoring: the scene and every asset present in that segment (beyond held/worn items, including stationary ones) are @-referenced per segment
- When there is no transition segment, the first segment continues from the first keyframe image (see "Keyframe Alignment")

## Mapping to the Storyboard Description

`description` is the only content source for video_prompt:

- Each `【镜头N】` maps to **1–2 consecutive 3-second segments**, in the same order, none omitted, none merged, no sub-shots invented
- Dialogue/narration is taken from the matching `【镜头N】` and assigned to the segments that sub-shot maps to; **never write new dialogue**
- On-screen action follows `description`; `atmosphere` is used only to add lighting, color and mood

## Structure Inside a Segment

Organize every segment in this order (items with no content may be omitted, but the action/image must be there):

**time range ＋ scene @reference (required in every segment; cuts/close-ups get no exemption) ＋ shot size/camera move ＋ character @reference ＋ main action · limb state · expression ＋ prop @reference and its state ＋ dialogue/narration ＋ mood and lighting**
- **Prop distinctive element**: the sentence containing @PropName must include a distinctive element (functional part / explicit grip point / use action — see "Reference Rules"); a bare weak stative verb ("resting/leaning/sitting") is non-compliant; stationary props are written as position + part state (e.g. "the @RemoteControl on the coffee table, buttons facing up")

- **One main action per segment**: only one character may change one limb state per segment; verbs are concrete and visible (walk, turn around, raise the head, clench). Never stuff an action chain (put down — twist around — fold back up) into one segment
- **Limb state**: for every character present, write both hands in each segment (including which hand holds what) and the current pose of both legs; high-risk poses (cross-legged, crouched, one-legged stance, legs crossed, turning around) use a positive, exhaustive enumeration: "both legs drawn up and folded in front of the body, both feet tucked under, both hands hugging the knees"; **negative instructions are forbidden** ("no third leg" does not work)
- **Rewrite occluded actions**: actions behind the body or hidden by the torso become equivalent actions visible from a side-on angle
- **Contact interaction**: when two characters touch, write both parties' final limb states, with a unique contact point
- **Worn state**: hats, glasses and sunglasses are declared in every segment (worn / held in which hand / not in frame); putting on and taking off each occupy a main action of their own
- **Cuts**: a cut segment starts with "cut to / cut back to" and re-establishes shot size and subject; cut points align with `【镜头N】`; no more than 1 consecutive pure close-up segment, and a close-up segment must be flanked by a full-body/medium anchoring segment
- **Turn emotion into visible description**: do not write "he is very sad", write "he lowers his head, both hands clenching the rim of the cup"

## Keyframe Alignment (hard rule)

`read_storyboard_context` returns `first_frame_prompt`, `mid_frame_prompt`, `mid_frame_time`, `last_frame_prompt` and `inherits_first`, and you must align to them:

- **First frame**: with no transition segment, the first segment continues from the first keyframe image (when `inherits_first` is true, that is the previous storyboard's last keyframe; read the previous shot's `last_frame_prompt` / `result` to understand the image), keeping the same camera position and character placement, without re-establishing the space and without cutting at second 0; with a transition segment, the transition handles the spatial join and the first content segment after it continues from the transition's end image
- **Mid frame**: when `mid_frame_time` has a value, some segment's **start must land exactly on that second**, and that segment's opening image must match `mid_frame_prompt`
- **Last frame**: the final segment lands on the `last_frame_prompt` image, with the characters' held/worn states matching it
- Keyframe prompts describe frozen instants; the video prompt writes the movement and performance between two frames — do not copy them verbatim

## Absolute Rule: Images Come First

- **Never** describe a character's species, race, clothing, colors, hairstyle, body type, age or facial features; a character is referred to only as `@CharacterName`; clothing is decided by the styling-version reference image, so never write clothing in text
- **Allowed**: relative size ratios ("@MouseMom is about two-thirds the height of @PigDad"); the worn state of wearable props ("@Sunglasses perched on the bridge of the nose")
- Write only visible position, pose, limb state, action, expression, eyeline and prop interaction, plus shot size, camera movement, lighting and mood

## Reference Rules (per-segment asset anchoring)

- `@SceneName` / `@CharacterName` / `@PropName` must match the lists returned by read_storyboard_context exactly (they are automatically replaced with reference-image markers — never abbreviate them or add symbols); only reference assets bound to this storyboard segment. The info header lists the full set of bound assets; each time segment lists **the subset present in that segment** — the two do not substitute for each other
- **Scene @-referenced in every segment (hard rule)**: the body of every time segment — including the opening transition segment, cut segments and pure close-up segments — must contain this shot's bound `@SceneName`, preferably as the segment's first reference. A change of shot size is not a change of scene: cuts, push-ins and close-ups get no exemption; @-referencing the scene tells the model "we are still here"
- **Every on-screen asset @-referenced per segment (hard rule)**: any bound character/prop visible in the segment — including background, foreground blur, mirror images and stationary objects — is @-referenced in every segment, each with a short visibility phrase (position + pose is enough, it need not be an action). The segment in which an asset leaves the frame states the exit via @Name; afterwards segments either stop mentioning it or mention it as `@Name (off-screen)` per the bypass ban — an asset must never silently vanish and later silently return
- **Props appear only inside holding/using/wearing sentences, and with a distinctive element**: the sentence containing `@PropName` must state who, with which body part, and how it is held/used/worn, with at least one distinctive element — a **functional part** (channel button, lens, hat brim), an **explicit grip point** (right thumb, bridge of the nose), or a **use action** (press, raise and point, put on). A bare weak stative verb (resting, sitting, leaning, holding, touching) + @Prop = non-compliant — "both hands resting on a black rectangle" is the shared prior of remote/gamepad/phone. Bridge to "one main action per segment": prefer expressing the distinctive element as a part-level **state** ("right hand holding the @RemoteControl, thumb resting lightly on the channel button" is a state and does not consume the main-action slot); write it as a use action only when the segment's main action is the prop operation itself
- **Bypass references forbidden (bare text)**: an @-able asset may only appear as `@Name`. Non-subject mentions — off-screen, in-mirror, blurred, sound sources — are written `@Name (off-screen)` / `@Name (in-mirror)`, with the parenthetical **following** the @ reference, never replacing it. Bare-text references like "the mirror off-screen", "that mirror", "the remote on the table" are forbidden: bare text bypasses the asset's reference image and the model reinvents its look from words
- **Collective-term ban**: collective terms (parents, mom and dad, the two, they, the family, everyone) must not be the **first** reference to a member within a segment; @-name each member first, then later references may use "the two / they". This does not carry across segments: every new segment starts from @ names again
- Mirror images: a single segment features either the mirror image or the real body as subject; the mirror's contents are written out and match the real body; a television inside the frame only plays program footage and this film's characters must never appear on it

## Reference Image Budget (hard constraint)

- A shot may use at most 9 reference images; during video generation the first keyframe already takes 1, leaving: scene 1 + characters N + props M ≤ 8
- When over budget, drop by priority: scene > characters present > props that are used or shown in close-up > props that are merely visible
- A prop that is dropped loses both its binding and its @ mention — never leave a name that is "@-mentioned but not bound"
- Only @ assets bound to this storyboard segment

## Timeline Rules

- Number of content segments = the storyboard segment's duration ÷ 3 seconds (rounded up), and the segments' time ranges add up to the segment's total duration; when there is a transition segment, the content timeline starts after the transition segment ends and the total follows the submitted duration
- Content rhythm: the first content segment continues from the anchor-frame image → the middle segments push the action forward (aligning to the mid keyframe at `mid_frame_time`) → the final segment lands on the last-frame image

## Prohibitions

- Scene changes, flashbacks
- Names outside the reference lists; character appearance description; negative limb instructions
- Bare-text references to @-able assets ("the mirror off-screen", "that mirror", "the remote on the table"); collective terms (parents/the two/they) as a segment's first reference
- More than one main action in a segment; two or more consecutive pure close-up segments driving the action
- Abstract psychological description, literary metaphor
- Deleting or rewriting the structure of the opening transition segment
- A language that does not match the conversation language instruction

## Saving

Call `update_storyboard` to update only this storyboard segment's `video_prompt` field — do not touch other fields and do not re-breakdown the whole episode.
