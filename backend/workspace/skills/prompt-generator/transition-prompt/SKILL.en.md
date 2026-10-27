# SKILL — In-Shot Transition Prompt System (EN)

> English mirror of SKILL.md for huobao-drama Issue #11. The single legal source of `technique_id` is `catalog.json` (32 techniques). This document reproduces all 32, with templates identical to `template_en`.

## 0. Principles

- **P1 — Transitions live inside the shot.** Every transition occupies the fixed window **0–T seconds** at the head of the current shot's clip. The `transition_prompt` itself carries **no prefix** such as "Opening transition (0–Ts):" — the system prepends it.
- **P2 — No editing bay.** Each shot is generated as a single clip. Every technique must be written as an **in-shot filmable continuous event** (camera move, occlusion, light, focus, speed, subject action) or a **model-simulable optical effect** (dissolve, fade, flash, soft-focus ripple). Pure editorial vocabulary (match cut, jump cut, insert) is second choice and has already been rewritten as in-shot executable description.
- **P3 — Image wins.** Reference pictures are the sole source of truth for appearance. Never describe wardrobe or appearance changes; never invent props (clocks, calendars, occluders…) absent from the scene reference and bound props.
- **P4 — Asset discipline.** @-mention only assets **bound to the current shot**. Content from the previous shot is described in plain words, without @ handles, unless the same asset is also bound here.
- **P5 — Hands are stated.** Every bridge action states what **each paw or hand** does and where it lands.
- **P6 — Timing defaults.** Scene-time transition default T = **3.0s**; continuity bridge T = **1.0–3.0s**; absolute minimum **1.0s**; clip total cap **15s**; initial hold **0.5s**. T moves in **0.5s steps** and must sit inside the chosen technique's seconds range.
- **P7 — Mid-frame rule.** `E = min(T, max(0, 15 − duration))`; when a `mid_frame_time` exists, require `mid_frame_time + E ≥ T + 0.5`.
- **P8 — Shrink rule.** If the constraint fails, lower T to `mid_frame_time + E − 0.5` (floored to a 0.5 multiple, minimum 1.0) and reselect an `is_fast` technique from the fast fallback. If it still fails at T = 1.0, the system drops the transition — the agent outputs as usual and notes "duration constraint too tight" in `reason`.
- **P9 — End settled.** By second T the frame must be settled on **this shot's scripted opening state**, so the remainder of the shot prompt continues seamlessly from T.

## 1. Slots

| Slot | Meaning / fill rule |
|---|---|
| `{T}` | Transition end time in seconds; 0.5 steps; inside the technique's seconds range |
| `<Picture 1>` | The first-frame conditioning image = the **previous shot's final frame**; the prompt must open exactly on it |
| `{PREV_END}` | One-sentence description of the previous shot's ending frame (plain words; no @ unless that asset is bound to this shot) |
| `{THIS_START}` | This shot's opening frame: position, pose, state of both paws/hands, light |
| `{@CHARACTER}` | The acting character; the @ handle must be bound to this shot |
| `{DIRECTION}` | Screen direction (left / right / up / down / toward the doorway…) |
| `{OCCLUDER}` | Credible foreground justified by the scene reference (leaf shadow, figure, furniture edge, door frame) |
| `{ANCHOR}` | Push-through anchor: door/window, lamp, dark area, texture |
| `{LIGHT_SOURCE}` | Motivated light source for a flash (sun, lamp, screen) |
| `{BEAT_SOUND}` | One crisp beat (snap, clap, click), as a sound effect |
| `{MATCH_A}` / `{MATCH_B}` | Shape/color-matched objects in the old and new frames |
| `{BRIDGE_ACTION}` | The unbroken action carrying the switch (sitting down, turning, reaching) |
| `{LIGHT_PATH}` / `{OLD_LIGHT}` / `{NEW_LIGHT}` | Timelapse light trajectory; light state before / after |
| `{TIME_PROP}` / `{OLD_TIME}` / `{NEW_TIME}` | An **existing** timepiece and its readings |
| `{SEASON_SHIFT}` | Item-by-item seasonal morph description |
| `{VIGNETTE_1..3}` / `{SPAN_OR_PROCESS}` | Micro-vignettes (0.5–0.8s each, bound scenes only); the span or process conveyed |
| `{STILL_OBJECT}` | Still object belonging to this shot's scene (or a generic empty shot such as sky) |
| `{NEXT_AMBIENCE}` | This shot's ambience/sound entering early (audio-capable models) |
| `{SUBJECT_A}` / `{SUBJECT_B}` | Focus-pull subjects (character ↔ foreground/background object) |
| `{DOORWAY_OR_PASSAGE}` | A real connecting passage between the two spaces |
| `{GAZE_TARGET}` / `{GAZE_DIR}` | POV target; gaze direction |
| `{OLD_PROP}` / `{NEW_PROP}` | Props to release / acquire; must exist per images and bindings |
| `{PLACE}` / `{FROM_POS}` / `{USE_POS}` / `{TARGET_POS}` / `{SUPPORT}` / `{ORIENTATION}` | Put-down spot; hand's origin; in-use position; destination; what the idle paw/hand steadies; final facing |

Enum legend — time span: `none · minutes · hours · day-night · days · season · years`; location: `none · adjacent · far · indoor↔outdoor`; narrative: `normal · memory · dream · emotion`; `action-only: yes` = works purely on subject action/focus within the same scene (continuity-grade); `fast` = `is_fast: true`, eligible for fast fallback.

## 2. Technique Catalog

Demo storyline used by all examples: **#1** @Balcony, early morning, @Gini lifts mini dumbbells → **#2** @Balcony, late morning, yoga tree pose → **#3** @Study, night, reading a book → **#4** @Study, night, writing in a notebook.

### 2.1 Short-Video Techniques

#### whip_pan ｜ Whip Pan / 甩镜转场 ｜ short_video ｜ 1.0–2.0s ｜ H3 high / MiniMax high
- **Applicable**: span minutes · hours · day-night · days ｜ location any ｜ narrative normal, emotion ｜ action-only no ｜ fast **yes**. Brisk, upbeat time-space changes of any kind; one of the first fast picks when T is squeezed — directional motion blur naturally masks the spatial switch.
- **Not applicable**: calm, sorrowful, gaze-lingering slow passages; already used across several consecutive shots (avoid dizziness and formula fatigue).
- **Template (EN)**: [0-{T}s] Open exactly on <Picture 1>: {PREV_END}. Hold about 0.5s, then the camera whips {DIRECTION} at high speed; heavy directional motion blur floods the frame and erases all spatial detail. The whip decelerates, the blur clears, and the frame settles on {THIS_START}; the camera is fully static by {T} seconds.
- **Example (#2→#3)**: [0-2s] Open exactly on <Picture 1>: bright late-morning balcony — @Gini stands steady at the center of the yoga mat in tree pose, one small paw pressed against her leg. Hold about 0.5s, then the camera whips right at high speed; heavy directional motion blur erases the balcony railing and plants. The whip decelerates, the blur clears, and the frame settles on @Study at night — a warm desk-lamp glow bathes the small desk, @Gini sits at the desk with both forepaws resting on either side of an open book; the camera is fully static by 2 seconds.

#### occlusion_wipe ｜ Occlusion Wipe / 遮挡转场 ｜ short_video ｜ 1.5–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span minutes · hours · day-night · days ｜ location any ｜ narrative normal ｜ action-only no. When a credible foreground (leaf shadow, a passing figure, furniture edge) can sweep right past the lens; the full-occlusion instant naturally masks any state switch — also a strong fallback for continuity residue.
- **Not applicable**: no credible foreground occluder in frame and the character does not move.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. After about 0.5s, {OCCLUDER} enters from {DIRECTION} and sweeps right past the lens, filling the frame completely for an instant; as it clears, the revealed frame is already {THIS_START}; the occluder fully exits and the camera steadies by {T} seconds.
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose on the yoga mat. After about 0.5s, a deep-green potted-plant leaf shadow enters from the left and sweeps right past the lens, filling the frame for an instant; as it clears to the right, the revealed frame is already @Study at night — warm desk-lamp glow over the small desk, @Gini seated with both forepaws on either side of the open book; the leaf fully exits and the camera steadies by 3 seconds.

#### zoom_through ｜ Zoom Through / 推拉穿越 ｜ short_video ｜ 2.0–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span hours · day-night · days ｜ location adjacent · far · indoor↔outdoor ｜ narrative normal, emotion ｜ action-only no. When a door/window, light, dark area or texture can serve as a push-through anchor; push in to full fill, then pull out — the spatial switch hides in the filled instant.
- **Not applicable**: T < 2s; no door/window/light/dark-area anchor in frame.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. The camera accelerates and pushes in toward {ANCHOR} until its light or texture fills the whole frame; the camera then pulls back out of that same fill, and the frame is now {THIS_START}; the pull-out completes and the camera locks by {T} seconds.
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: late-morning balcony — @Gini steady in tree pose on the yoga mat. The camera accelerates and pushes in toward the sunlit bright patch of white wall behind her until the warm white fill floods the whole frame; the camera then pulls back out of a ball of warm yellow glow — the desk lamp of @Study at night, its glow bathing the small desk, @Gini seated with both forepaws on either side of the open book; the pull-out completes and the camera locks by 3 seconds.

#### roll_spin ｜ Roll Spin / 旋转转场 ｜ short_video ｜ 1.5–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span minutes · hours · day-night ｜ location none · adjacent · far ｜ narrative normal, emotion ｜ action-only no. Excitement, dizziness, world-flipping beats; circular blur masks the spatial switch.
- **Not applicable**: calm, solemn passages; T < 1.5s; shots demanding high frame stability (roll distortion risk).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. Hold about 0.5s, then the camera rolls rapidly around the lens axis; circular motion blur churns away spatial detail. As the roll decelerates back to level, the frame is now {THIS_START}; the horizon settles and locks by {T} seconds.
- **Example (#2→#3)**: [0-2.5s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose. Hold about 0.5s, then the camera rolls clockwise rapidly; circular motion blur churns away the balcony's light and shadow. As the roll decelerates back to level, the frame is now @Study at night — under the warm desk lamp @Gini sits at the desk, both forepaws on either side of the open book; the horizon settles and locks by 2.5 seconds.

#### motion_follow ｜ Follow-Motion Transition / 跟随动作转场 ｜ short_video ｜ 2.0–3.0s ｜ H3 high / MiniMax medium
- **Applicable**: span none · minutes · hours ｜ location adjacent ｜ narrative normal ｜ action-only no. Adjacent spaces the character can plausibly walk between; tracking plus a passing foreground completes the scene change.
- **Not applicable**: long distance or cross-city (cannot walk there); day-night flip with no light-gradient motivation; character does not move.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} turns and sets off {DIRECTION} (state which paw or foot moves first and how the body turns); the camera tracks the move while a foreground {OCCLUDER} briefly wipes the lens along the way; as {@CHARACTER} arrives and settles, the camera locks onto {THIS_START} by {T} seconds.
- **Example (hypothetical #2 → adjacent living room, same morning)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini releases tree pose onto all four paws. Her right forepaw steps first, the body turning toward the left doorway as she trots off; the camera tracks the move while the door-frame edge briefly wipes the lens along the way; @Gini trots into @LivingRoom and settles seated at the rug center; action and camera lock together by 3 seconds.

#### object_to_lens ｜ Object-to-Lens Wipe / 贴镜遮挡转场 ｜ short_video ｜ 1.5–2.5s ｜ H3 high / MiniMax high
- **Applicable**: span minutes · hours · day-night ｜ location none · adjacent · far ｜ narrative normal, emotion ｜ action-only no. Playful, character-forward beats; the switch lands in the instant a pad or object covers the lens.
- **Not applicable**: grave, heavy scenes; character too far from the lens with no motivation to approach.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} raises one forepaw or hand toward the lens (state what the other paw or hand is holding and where it stays); the pad closes in until it fully covers the lens and the frame goes dark. The instant it withdraws, the frame is {THIS_START}; fully clear and steady by {T} seconds.
- **Example (#2→#3)**: [0-2.5s] Open on <Picture 1>: late-morning balcony — @Gini lowers the small paw from her leg and stands on all fours, then raises her right forepaw toward the lens (left forepaw braced on the mat to steady her body); the pink pad closes in until it fully covers the lens and the frame goes dark. The instant it withdraws, the frame is @Study at night — @Gini at the lamp-lit desk, both forepaws resting on either side of the open book; fully clear and steady by 2.5 seconds.

#### light_flash ｜ Light Flash / 闪白光效转场 ｜ short_video ｜ 1.0–1.5s ｜ H3 high / MiniMax high
- **Applicable**: span minutes · hours · day-night · days · season · years ｜ location any ｜ narrative normal, emotion ｜ action-only no ｜ fast **yes**. Universal fast device: the overexposure instant wipes both spatial and prop residue; first choice when T is squeezed to 1–1.5s.
- **Not applicable**: oppressive or horror moods that need darkening (use fade_black); repeated across consecutive shots (flash fatigue).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. The brightness of {LIGHT_SOURCE} swells rapidly until the frame overexposes to pure white within about 0.3s; the white immediately falls away to reveal {THIS_START}; exposure normalizes and the camera is steady by {T} seconds.
- **Example (#2→#3, fast substitute when T is squeezed)**: [0-1.2s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose. The brightness of the sunlight swells rapidly until the frame overexposes to pure white within about 0.3s; the white immediately falls away to reveal @Study at night — warm desk-lamp glow, @Gini seated at the desk with both forepaws on either side of the open book; exposure normalizes and the camera is steady by 1.2 seconds.

#### speed_ramp ｜ Speed Ramp / 变速转场 ｜ short_video ｜ 2.0–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span minutes · hours ｜ location none · adjacent ｜ narrative normal, emotion ｜ action-only no. Ramped linkage when the previous shot ends mid-action; bridge actions (put down, pick up) can run at ramp speed for extra dynamism.
- **Not applicable**: both the previous shot's end and this shot's opening are fully static (no speed to ramp).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. The action {@CHARACTER} is finishing suddenly accelerates (state what each paw or hand does), dragging heavy motion blur; at the blur peak the motion snaps to a stop and the frame locks sharp on {THIS_START}; speed returns to normal and the frame is steady by {T} seconds.
- **Example (dynamic alternative for #1→#2)**: [0-3s] Open on <Picture 1>: early-morning @Balcony — @Gini holds a mini dumbbell in each forepaw raised at chest height. Her putting-down action suddenly accelerates — right paw, then left paw, sets its dumbbell at the mat edge, dragging heavy motion blur; at the blur peak the motion snaps to a stop and the frame locks sharp: @Gini already empty-pawed, crouched at the center of the yoga mat, about to rise slowly; speed returns to normal and the frame is steady by 3 seconds.

#### beat_snap ｜ Beat-Synced Snap / 卡点骤变转场 ｜ short_video ｜ 1.0–2.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span hours · day-night · days · season ｜ location none · adjacent · far ｜ narrative normal, emotion ｜ action-only no ｜ fast **yes**. Musical, punchy beats: the subject stays in the same screen region while environment, light and pose snap on one beat.
- **Not applicable**: costume or appearance changes (image wins — never describe them); soft lyrical passages.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}; {@CHARACTER} holds the pose for about 0.5s. On a crisp {BEAT_SOUND} (sound effect), the frame snaps within 2-3 frames to {THIS_START} — camera and framing stay as close as possible, {@CHARACTER} remains in the same screen region, while environment, light and pose have switched; the snap completes and holds by {T} seconds.
- **Example (#2→#3)**: [0-1.5s] Open on <Picture 1>: bright late-morning balcony — @Gini holds tree pose for about 0.5s. On a crisp finger-snap-like beat (sound effect), the frame snaps within 2-3 frames — camera and framing unchanged, the environment is now @Study at night: warm desk-lamp glow replaces sunlight, @Gini already seated at the desk, both forepaws on either side of the open book; the snap completes and holds by 1.5 seconds.

### 2.2 Cinematic Techniques

#### dissolve ｜ Cross Dissolve / 叠化 ｜ cinematic ｜ 2.0–3.0s ｜ H3 high / MiniMax medium
- **Applicable**: span hours · day-night · days · season · years ｜ location any ｜ narrative normal, memory, emotion ｜ action-only no. The most universal cinematic fallback — lyric moods, time passage and space change alike.
- **Not applicable**: punchy beats needing strong rhythmic impact; T < 2s.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. The image gradually turns translucent while {THIS_START} fades up within the same frame; the two images briefly overlap mid-way, then the old image vanishes and the new one holds sharp and steady; the dissolve completes by {T} seconds.
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose on the yoga mat. The image gradually turns translucent while @Study at night fades up within the same frame — warm desk-lamp glow over the small desk, @Gini seated with both forepaws on either side of the open book; the two images briefly overlap mid-way, then the old image vanishes; the dissolve completes, sharp and steady, by 3 seconds.

#### fade_black ｜ Fade Through Black / 经黑渐隐渐显 ｜ cinematic ｜ 2.0–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span day-night · days · season · years ｜ location any ｜ narrative normal ｜ action-only no. First choice into night or darker scenes, larger time spans, chapter-like closure; black naturally wipes all residue.
- **Not applicable**: both ends bright and high-key with pace that must stay fast; T < 2s.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. Brightness falls smoothly, sinking to full black in the first half of the transition; in the black, {NEXT_AMBIENCE} enters first; the image then fades up from black into {THIS_START}, reaching normal exposure and locking by {T} seconds.
- **Example (#2→#3, model answer)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose, eyes sparkling. Brightness falls smoothly, sinking to full black in about 1.5s; in the black, the quiet night-room ambience and a faint rustle of pages enter first; the image then fades up from black into @Study at night — warm desk-lamp glow bathing the small desk, @Gini seated at the desk with both forepaws resting on either side of the open book — reaching normal exposure and locking by 3 seconds.

#### fade_white ｜ Fade Through White / 经白渐隐渐显 ｜ cinematic ｜ 2.0–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span hours · day-night · days ｜ location any ｜ narrative normal, memory, dream, emotion ｜ action-only no. Soft lyric moods, memory/dream entry, time jumps between bright scenes.
- **Not applicable**: entering a dark scene (jarring contrast); thriller or oppressive moods.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. A soft white glow gradually floods the frame, turning it fully white in the first half; the white then recedes to reveal {THIS_START}; exposure normalizes and the frame steadies by {T} seconds.
- **Example (hypothetical #4 → next-morning return to the balcony)**: [0-3s] Open on <Picture 1>: the night study under warm lamplight — @Gini, pen in right paw, left paw pressing the paper, finishes the last line. A soft white glow gradually floods the frame, fully white in about 1.5s; the white then recedes to reveal next morning on @Balcony — @Gini standing empty-pawed in the morning light beside the training mat; exposure normalizes and the frame steadies by 3 seconds.

#### match_cut ｜ Shape Match Cut / 形状匹配转场 ｜ cinematic ｜ 2.0–3.0s ｜ H3 medium / MiniMax low
- **Applicable**: span hours · day-night · days · season · years ｜ location any ｜ narrative normal, emotion ｜ action-only no. When the two shots share a shape/color/composition anchor (round light patch ↔ lamp glow, etc.); editorial device as second choice, rewritten as an in-shot morph.
- **Not applicable**: no credible shape or color match pair across the two shots; rushed pacing.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. The camera slowly pushes in on {MATCH_A} until its shape holds the center of frame; keeping that shape in place, its color, texture and surroundings gradually morph into {MATCH_B}; the camera then pulls back to reveal {THIS_START}; the pull-back completes and steadies by {T} seconds.
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose. The camera slowly pushes in on a round bright patch of sunlight on the floor beside her until its shape holds the center of frame; keeping that circle in place, its color temperature shifts from bright white to warm yellow while the surroundings darken into night — it becomes the desk-lamp glow of @Study; the camera then pulls back to reveal @Gini seated at the desk, both forepaws on either side of the open book; the pull-back completes and steadies by 3 seconds.

#### match_on_action ｜ Match on Action / 动作匹配转场 ｜ cinematic ｜ 1.5–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span none · minutes · hours · day-night ｜ location none · adjacent · far ｜ narrative normal ｜ action-only **yes**. Same character, with the previous end action and this opening action of the same type or direction; the motion never stops while the environment switches mid-action.
- **Not applicable**: the two actions conflict in direction and cannot be rewritten to match; different characters.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} begins {BRIDGE_ACTION} (state the acting paw or hand and where the other stays); halfway through the motion, the surrounding environment and light cross-dissolve into the new scene while the motion continues unbroken, landing exactly on {THIS_START}; the action completes and the frame steadies by {T} seconds.
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose, then lowers the paw from her leg and leans forward to sit down (right forepaw bracing first toward the ground ahead); halfway through the sitting motion, the surroundings cross-dissolve quickly into the warm lamp light and desk of @Study at night while the motion continues unbroken — @Gini settles seated at the desk, both forepaws landing naturally on either side of the open book; the action completes and the frame steadies by 3 seconds.

#### jump_cut_lapse ｜ Jump-Cut Time Lapse / 跳切时间流逝 ｜ cinematic ｜ 2.0–3.0s ｜ H3 medium / MiniMax low
- **Applicable**: span hours · day-night · days ｜ location none ｜ narrative normal ｜ action-only no. Same-camera, same-scene time passage (repeated labor, waiting); editorial second choice realized as two crisp in-shot jumps.
- **Not applicable**: cross-scene; T < 2s.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. With camera and framing locked, the frame makes two crisp micro jump cuts; at each jump, the pose of {@CHARACTER} and the environment details (light angle, prop positions) advance a visible step, showing time quietly passing; after the second jump the frame is {THIS_START}, holding still until {T} seconds.
- **Example (#3→#4)**: [0-2.5s] Open on <Picture 1>: @Study at night — @Gini reading head-down, both forepaws pressing either side of the open book; hold about 0.5s. With camera and framing locked, two crisp micro jump cuts — after the first, most of the pages have been turned and her head is lower; after the second, the notebook lies open before her, right paw gripping the pencil, left paw lightly pressing the page, pencil tip on the paper; holding still until 2.5 seconds.

#### timelapse_light ｜ Timelapse Light Sweep / 光影流转 ｜ cinematic ｜ 2.0–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span hours · day-night ｜ location none ｜ narrative normal ｜ action-only no. First choice for time jumps inside one space: a timelapse-speed light sweep reads most naturally; the character relocates in softly blurred fast-motion.
- **Not applicable**: cross-space; virtually no time passes.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. With the camera locked, light sweeps at timelapse speed: {LIGHT_PATH}; within the moving light, {@CHARACTER} shifts in softly blurred fast-motion to this shot's position and pose (state the final state of both paws or hands); as the light settles into {NEW_LIGHT}, the frame is {THIS_START}; light and character lock together by {T} seconds.
- **Example (#1→#2, alternative conveying a short passage of time)**: [0-3s] Open on <Picture 1>: early-morning @Balcony — @Gini holds a mini dumbbell in each forepaw at chest height. With the camera locked, sunlight sweeps at timelapse speed: light patches slide across the floor, shadows shorten, the color turns from dawn gold to late-morning bright white; within the moving light, @Gini's figure shifts in softly blurred fast-motion — setting the dumbbells down side by side at the mat edge and moving to the yoga-mat center; as the light settles into bright late-morning sun, @Gini is already crouched empty-pawed at the mat center, about to rise slowly; light and character lock together by 3 seconds.

#### clock_calendar ｜ Clock or Calendar Insert / 时钟日历指示 ｜ cinematic ｜ 2.0–3.0s ｜ H3 medium / MiniMax low
- **Applicable**: span hours · days ｜ location none ｜ narrative normal ｜ action-only no. When a clock, calendar or screen actually exists in the scene reference or bound props, its rapid change states the time jump explicitly.
- **Not applicable**: no timepiece in the scene reference or bound props (never invent one — image wins); cross-scene.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. Cut in to a close-up of {TIME_PROP} in the scene (it must already exist in the scene reference or bound props); its hands, page or digits visibly race from {OLD_TIME} to {NEW_TIME} while the ambient light shifts in sync; cutting back, the frame is {THIS_START}; steady by {T} seconds.
- **Example (#3→#4, assuming a small alarm clock exists in the @Study reference)**: [0-3s] Open on <Picture 1>: @Study at night — @Gini reading head-down, both paws pressing the open book; hold about 0.5s. Cut in to a close-up of the small alarm clock on the desk; its hands race from 21:00 to 21:20 while the lamp glow sways faintly; cutting back to the medium shot, @Gini's right paw already grips the pencil, left paw lightly pressing the open notebook, pencil tip descending to the page; steady by 3 seconds.

#### season_change ｜ Season Change / 季节更替 ｜ cinematic ｜ 2.5–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span season · years ｜ location none · adjacent ｜ narrative normal ｜ action-only no. Outdoor or windowed spaces with visible plants: locked camera, item-by-item morph of plants and light completes the season.
- **Not applicable**: enclosed windowless spaces; time spans below hour level.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. With the camera locked, the environment morphs steadily through a season change: {SEASON_SHIFT} (plants, sky and light quality shifting item by item); {@CHARACTER} may be briefly occluded by foreground or softly blurred to mask the state switch; when the morph completes the frame is {THIS_START}; steady by {T} seconds.
- **Example (hypothetical: the #2 balcony passes from spring into summer)**: [0-3s] Open on <Picture 1>: @Balcony — @Gini steady in tree pose. With the camera locked, the plants by the railing steadily grow taller and denser, small flowers open in the pots, and the sunlight turns from soft to high-summer brightness with crisp hard shadows; @Gini's figure is briefly occluded by a green leaf sweeping the foreground; when the morph completes it is midsummer noon on @Balcony, @Gini empty-pawed at the yoga-mat center, ready to begin a new pose; steady by 3 seconds.

#### montage_flash ｜ Micro-Montage / 微蒙太奇 ｜ cinematic ｜ 2.5–3.0s ｜ H3 low / MiniMax low
- **Applicable**: span days · season · years ｜ location none ｜ narrative normal, emotion ｜ action-only no. Large spans with process narration ("practiced for many days"); 2–3 micro vignettes in quick dissolves within one frame, all inside this or the previous shot's scene. **Last resort.**
- **Not applicable**: ordinary links (when a simpler device exists); vignettes would require an unbound scene; T < 2.5s.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. Within the same frame, two or three very short vignettes flash by in quick dissolves (about 0.5-0.8s each, all inside this shot's scene or the previous shot's scene): {VIGNETTE_1}; {VIGNETTE_2}; {VIGNETTE_3 (optional)}, conveying {SPAN_OR_PROCESS}; the last vignette dissolves and locks into {THIS_START}; steady by {T} seconds.
- **Example (#3→#4)**: [0-3s] Open on <Picture 1>: @Study at night — @Gini reading, both paws pressing the book. Within the same frame, three very short vignettes flash by in quick dissolves: her right paw turns a page; both paws close the book and push it toward the desk corner; she pulls the notebook open before her — conveying the study session advancing; the last vignette dissolves and locks into @Gini with the pencil gripped in her right paw, left paw pressing the notebook, pencil tip on the page; steady by 3 seconds.

#### cutaway_insert ｜ Cutaway Insert / 插入空镜 ｜ cinematic ｜ 1.5–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span minutes · hours · day-night ｜ location none · adjacent · far ｜ narrative normal ｜ action-only no. Links needing a breath or a sense of separation; the insert must belong to this shot's scene (or be a generic empty shot such as sky); the light transition happens inside the insert.
- **Not applicable**: the insert object doesn't exist in this shot's scene and isn't a generic empty shot; mid high-speed action.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. Cut in to an empty close-up of {STILL_OBJECT} belonging to this shot's scene for about 1 second, its light shifting from {OLD_LIGHT} to {NEW_LIGHT}; cutting back, the frame is {THIS_START}; steady by {T} seconds.
- **Example (#2→#3)**: [0-2.5s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose; hold about 0.5s. Cut in to an empty close-up of the @Study desk lamp — in dimness the warm yellow light switches on and its glow spreads (about 1 second); cutting back to the medium shot, the frame is the full @Study night view, @Gini seated at the desk, forepaws on either side of the open book; steady by 2.5 seconds.

#### sound_bridge ｜ Sound Bridge (J-cut) / 声音先行 ｜ cinematic ｜ 1.5–3.0s ｜ H3 medium / MiniMax low
- **Applicable**: span minutes · hours · day-night ｜ location any ｜ narrative normal, emotion ｜ action-only no. Prefer on audio-native models (H3): the next scene's ambience leads in while the picture follows with a soft dissolve; must pair with a visual device.
- **Not applicable**: standalone use on models without audio control (e.g., MiniMax); strongly beat-synced segments.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {NEXT_AMBIENCE} enters first and swells while the image holds for about 1 second; the image then softly dissolves into {THIS_START}, and sound and picture lock in sync by {T} seconds. (Pair with a visual device such as a dissolve; audio-capable models only.)
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose. The quiet night-room ambience and a faint rustle of pages enter first and swell while the image holds on the balcony for about 1 second; the image then softly dissolves into @Study at night — @Gini under the warm lamp, both paws on either side of the open book; sound and picture lock in sync by 3 seconds.

#### rack_focus ｜ Rack Focus / 焦点转移 ｜ cinematic ｜ 1.0–2.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span none · minutes · hours ｜ location none ｜ narrative normal, emotion ｜ action-only **yes** ｜ fast **yes**. In-space attention shifts with a small time gap; the full-blur instant masks the state switch — a cinematic fast device.
- **Not applicable**: the frame lacks foreground/background layers for a focus pull.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. Focus racks slowly from {SUBJECT_A} to {SUBJECT_B} in the foreground or background; the original subject melts into soft bokeh; at the instant of full blur the content transitions, and as focus racks back it resolves on {THIS_START}; focus locks and the frame steadies by {T} seconds.
- **Example (fast substitute for #3→#4)**: [0-1.5s] Open on <Picture 1>: @Study at night — @Gini reading head-down, both paws pressing the book. Focus racks slowly from her to the pencil in the desk foreground; book and character melt into warm bokeh; at the instant of full blur the content transitions, and as focus racks back it resolves: @Gini's right paw already grips the pencil, left paw lightly pressing the open notebook, tip descending to the page; focus locks and the frame steadies by 1.5 seconds.

#### oner_walkthrough ｜ Walkthrough Oner / 一镜穿越 ｜ cinematic ｜ 2.5–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span none · minutes · hours ｜ location adjacent ｜ narrative normal ｜ action-only no. Adjacent spaces genuinely connected by a door or corridor; one unbroken tracking take through, light grading en route.
- **Not applicable**: no actual connecting path between the two spaces; T < 2.5s; day-night flip with no light-gradient motivation inside the passage.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. In one unbroken take, the camera follows {@CHARACTER} (or moves on its own) {DIRECTION} through {DOORWAY_OR_PASSAGE}, the light grading from {OLD_LIGHT} to {NEW_LIGHT} along the way; emerging, the camera settles on {THIS_START} with no cut anywhere; locked by {T} seconds.
- **Example (hypothetical #2 → adjacent living room)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini releases tree pose onto all fours, right forepaw first, and trots toward the left doorway. In one unbroken take, the camera follows her through the door frame, the light grading from outdoor bright white to soft interior light along the way; emerging, the camera settles: in @LivingRoom, @Gini sits down at the rug center; locked by 3 seconds, no cut anywhere.

#### pov_shift ｜ POV Shift / 主观视点转场 ｜ cinematic ｜ 2.0–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span minutes · hours · day-night ｜ location none · adjacent ｜ narrative normal, emotion, memory ｜ action-only no. With a clear gaze motivation: push in to the eyes → cut to POV → change within the view → pull back to an objective camera.
- **Not applicable**: no plausible gaze motivation.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. The camera pushes in to a close-up of the eyes of {@CHARACTER} (write only gaze direction and intensity), then switches to the character's POV: in the view, {GAZE_TARGET} gradually changes, lights up or draws closer; pulling back from the POV to an objective camera, the frame is {THIS_START}; steady by {T} seconds.
- **Example (#2→#3)**: [0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini completes tree pose, her gaze turning toward the interior. The camera pushes in to a close-up of her eyes, then switches to her POV: at the far end of the dim interior a warm desk lamp lights up, its glow gradually swelling; pulling back from the POV to an objective camera, the frame is @Study at night — @Gini seated at the desk, both forepaws on either side of the open book; steady by 3 seconds.

#### memory_dream ｜ Memory-Dream Transition / 回忆梦境转场 ｜ cinematic ｜ 2.0–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span any (none–years) ｜ location any ｜ narrative memory, dream ｜ action-only no. Entering or leaving memory, dream or fantasy: soft-focus bloom, palette drift, faint ripple.
- **Not applicable**: ordinary linear time links (not memory or dream).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. A soft-focus glow blooms at the frame edges, the palette drifts {warm-white or cool-desaturated}, a faint ripple passes across the frame, and present-day detail blurs away; past the haze peak, the image resolves again with a memory-or-dream tonal quality, revealing {THIS_START}; resolved and steady by {T} seconds.
- **Example (hypothetical: after #4, a new shot recalling the morning workout, bound to @Balcony)**: [0-3s] Open on <Picture 1>: the night study under the warm lamp — @Gini's right paw holds the pen paused above the page, her gaze drifting far away. A soft-focus glow blooms at the frame edges, the palette drifts warm-white, a faint ripple passes across the frame; past the haze peak the image resolves — early-morning @Balcony in a pale memory tint, @Gini raising a mini dumbbell in each forepaw to her chest; resolved and steady by 3 seconds.

### 2.3 Same-Scene Action Bridge Techniques

#### put_down_prop ｜ Put Down Prop / 放下道具 ｜ action_bridge ｜ 1.5–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span none · minutes ｜ location none ｜ narrative normal ｜ action-only **yes**. First choice when the previous shot's held item is no longer needed; small steps and orientation tweaks can be folded in.
- **Not applicable**: the held item is still needed in this shot (no need to put it down).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} bends down; the paw or hand holding {OLD_PROP} sets it gently at {PLACE}, while the other paw or hand sets down its own item, braces the body or hangs free (state left-right roles); the character then straightens up, steps to {TARGET_POS} if needed, both paws or hands now empty, body turning toward {ORIENTATION}; by {T} seconds {@CHARACTER} is in the position and pose of {THIS_START}.
- **Example (#1→#2, model answer)**: [0-3s] Open on <Picture 1>: early-morning @Balcony — @Gini stands on the training mat, a mini dumbbell in each forepaw raised at chest height. She bends down; her right paw first sets its dumbbell gently at the mat edge, then her left paw sets the other beside it, both paws now free and braced on the mat; she straightens up, steps in small paces to the yoga-mat center and settles into a crouch, body turning to face front; by 3 seconds @Gini is crouched empty-pawed at the yoga-mat center, about to rise slowly — exactly this shot's opening frame.

#### pick_up_prop ｜ Pick Up Prop / 拿起道具 ｜ action_bridge ｜ 1.5–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span none · minutes ｜ location none ｜ narrative normal ｜ action-only **yes**. This shot opens holding a new prop while the previous shot's paws/hands were empty or placed elsewhere; also fits "operate a switch" actions.
- **Not applicable**: the previous shot's paws/hands still hold an old item with no disposal written (use swap_prop first).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. One paw or hand of {@CHARACTER} leaves {FROM_POS} and reaches for {NEW_PROP} (state which one, while the other keeps pressing or steadying {SUPPORT}); it grips {NEW_PROP} firmly and brings it to {USE_POS}; by {T} seconds {@CHARACTER} is in the pose of {THIS_START} with {NEW_PROP} in place.
- **Example (#3→#4, model answer)**: [0-2s] Open on <Picture 1>: @Study at night — @Gini reading head-down, both forepaws pressing either side of the open book. Her left paw gently pulls the notebook before her straight and holds it, while her right paw leaves the page, reaches for the pencil on the desk, grips it firmly and brings it above the notebook page, lowering the tip; by 2 seconds @Gini holds the pencil in her right paw, left paw pressing the notebook — this shot's opening frame.

#### swap_prop ｜ Prop Swap / 道具交接 ｜ action_bridge ｜ 2.0–3.0s ｜ H3 high / MiniMax medium
- **Applicable**: span none · minutes ｜ location none ｜ narrative normal ｜ action-only **yes**. Full handoff when the old item must go down and the new one must come up; two beats of ~1–1.5s each.
- **Not applicable**: only a one-way put-down or pick-up is needed (use put_down_prop or pick_up_prop); T < 2s.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} first sets {OLD_PROP} down at {PLACE} with one paw or hand (state which, and what the other is doing), then reaches to {NEW_PROP}, grips it and brings it to {USE_POS}; by {T} seconds {@CHARACTER} is in the pose of {THIS_START} — old prop released, {NEW_PROP} in place.
- **Example (alternative for #3→#4)**: [0-3s] Open on <Picture 1>: @Study at night — @Gini with both paws pressing the open book. She first closes the book gently with her right paw and pushes it to the desk's upper-left corner (left paw steadying the desk edge), then pulls the notebook open before her; her right paw reaches to the pencil and grips it, the tip moving above the page, while her left paw shifts to press the notebook lightly; by 3 seconds @Gini holds the pencil in her right paw, left paw pressing the paper — this shot's opening frame.

#### rise_relocate ｜ Rise and Relocate / 起身走位 ｜ action_bridge ｜ 2.0–3.0s ｜ H3 high / MiniMax high
- **Applicable**: span none · minutes ｜ location none ｜ narrative normal ｜ action-only **yes**. Same-space posture and position changes (sit↔stand↔step); prop put-downs or pick-ups may be folded into the steps.
- **Not applicable**: requires cross-scene movement (use motion_follow or oner_walkthrough); T < 2s with large motion.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} unwinds the current pose step by step (state which paw or foot moves first and how the weight shifts; prop put-downs or pick-ups may be folded into the steps), then rises, sits or steps to {TARGET_POS}, turning toward {ORIENTATION} and settling into this shot's opening pose; the camera may track slightly and then lock; by {T} seconds the frame is {THIS_START}.
- **Example (alternative for #1→#2)**: [0-3s] Open on <Picture 1>: early-morning @Balcony — @Gini holding the dumbbells raised in both paws. She first lowers both paws — right then left setting the dumbbells at the mat edge — then her weight shifts back, hind legs pushing her body up; she steps in small paces to the yoga-mat center, settles into a crouch, body turning to face front; by 3 seconds @Gini is crouched empty-pawed at the mat center, ready to rise slowly — this shot's opening frame.

#### breath_beat ｜ Breath Beat / 呼吸停顿 ｜ action_bridge ｜ 1.0–1.5s ｜ H3 high / MiniMax high
- **Applicable**: span none ｜ location none ｜ narrative normal ｜ action-only **yes** ｜ fast **yes**. Minimal link when the states nearly match and only gaze/expression/micro-pose differ; also the continuity floor when T is squeezed to 1s.
- **Not applicable**: hard residues exist (held prop, position, posture) — a pause cannot fix them.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}. {@CHARACTER} finishes the last beat of the current action and stills, exhaling softly, shoulders easing; the gaze turns toward {GAZE_DIR} and the pose micro-adjusts into this shot's opening state (state that both paws or hands stay put, or how they adjust); by {T} seconds the frame is {THIS_START} with the camera unchanged.
- **Example (constructed same-action link: #4 → next shot of continued writing)**: [0-1s] Open on <Picture 1>: @Study at night — @Gini, pen in right paw, left paw pressing the paper, finishes writing a line. The pen tip lifts off the paper and stills; she exhales softly, shoulders easing, her gaze returning to the top of the page, the pen tip landing again at the start of the next line (left paw keeps pressing the page); by 1 second the frame is this shot's opening writing pose, camera unchanged.

#### insert_hands_closeup ｜ Close-up Insert Handoff / 特写遮挡交接 ｜ action_bridge ｜ 1.5–3.0s ｜ H3 medium / MiniMax medium
- **Applicable**: span none · minutes ｜ location none ｜ narrative normal ｜ action-only **yes**. When a prop handoff is complex and would drag in a wide shot: cut in to a paw/hand close-up, complete the handoff inside, cut back.
- **Not applicable**: the character's paws or hands cannot plausibly enter frame (too far away); T < 1.5s.
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}; hold about 0.5s. Cut in to a close-up of the paws or hands of {@CHARACTER}: the handoff happens inside the close-up — state which paw or hand sets {OLD_PROP} down at {PLACE} and which grips {NEW_PROP} (or both end empty); cutting back to the original framing, {@CHARACTER} is already in the pose of {THIS_START}; steady by {T} seconds.
- **Example (#1→#2)**: [0-2.5s] Open on <Picture 1>: early-morning @Balcony — @Gini with a dumbbell in each forepaw raised at chest height; hold about 0.5s. Cut in to a paw close-up: the right paw sets its dumbbell gently at the mat edge, the left paw's dumbbell is then set beside it, both paws bracing steady on the mat; cutting back to the medium shot, @Gini is already crouched empty-pawed at the yoga-mat center, about to rise slowly; steady by 2.5 seconds.

#### micro_jump ｜ Micro Jump Cut / 轻微跳切 ｜ action_bridge ｜ 1.0–2.0s ｜ H3 medium / MiniMax low
- **Applicable**: span none · minutes · hours ｜ location none ｜ narrative normal ｜ action-only **yes** ｜ fast **yes**. Continuity escape hatch: when a smooth action can't fit into T or the state conflict is too large, one crisp same-camera jump resets the state.
- **Not applicable**: ample time exists for a smooth action bridge (prefer action bridges); repeated across consecutive shots (strobing feel).
- **Template (EN)**: [0-{T}s] Open on <Picture 1>: {PREV_END}; hold for about half the transition. Then one crisp micro jump cut: camera and framing unchanged, {@CHARACTER} stays in the same screen region, but {OLD_PROP} is already out of hand and in place, the pose switching directly to {THIS_START}; hold still after the jump until {T} seconds.
- **Example (fallback for #1→#2)**: [0-1s] Open on <Picture 1>: early-morning @Balcony — @Gini with a dumbbell in each forepaw raised at chest height; hold about 0.5s. Then one crisp micro jump cut: camera and framing unchanged, the two dumbbells already lie side by side at the mat edge, and @Gini is crouched empty-pawed at the yoga-mat center, about to rise slowly; hold still after the jump until 1 second.

## 3. Selection Rules

### 3.1 Three-Step Decision
1. **Step 1 — Diff & verdict.** Compare the previous shot's end state with this shot's opening state. If time, location or narrative layer changes → `verdict = "scene_time"`. If only in-scene residues differ (props, posture, position, gaze, environment state) → `verdict = "continuity"`. If the states match → `verdict = "none"` (no transition; nulls). Record the deltas into `changes` and the continuity residues into `hazards`.
2. **Step 2 — Technique lookup.** Use the tables below. Pick the **first matching row top-down**; within a row try candidates **left to right**, skipping any whose not-applicable conditions hit, whose seconds range cannot contain T, or whose executability for the current video model is `low` while a non-low candidate remains. Default to **H3** when the model is unspecified.
3. **Step 3 — Timing & writing.** Set T (scene_time default 3.0s; continuity 1.0–3.0s), clamp into the technique's range, apply the mid-frame rule and shrink rule (P7/P8), then fill the technique's `template_en` into `transition_prompt`, ending settled on this shot's opening by T.

### 3.2 Lookup Table

**scene_time**

| # | When | Candidates (left → right) |
|---|---|---|
| 1 | Day-night flip plus location change | fade_black → zoom_through → dissolve → whip_pan |
| 2 | Location change within daytime, both ends bright | occlusion_wipe → whip_pan → motion_follow → dissolve |
| 3 | Adjacent spaces, character can plausibly walk over, small time gap | motion_follow → oner_walkthrough → occlusion_wipe |
| 4 | Same space, time-of-day or day-night change | timelapse_light → dissolve → jump_cut_lapse → clock_calendar |
| 5 | Next day or several days later | fade_black → timelapse_light → jump_cut_lapse → clock_calendar |
| 6 | Season change | season_change → dissolve → fade_black |
| 7 | A year or more passes | fade_black → season_change → montage_flash |
| 8 | Entering a memory or dream | memory_dream → fade_white → dissolve |
| 9 | Leaving a memory or dream | memory_dream → dissolve → fade_black |
| 10 | Mood shift only, same time and place | rack_focus → speed_ramp → sound_bridge → light_flash |
| 11 | Any other combination (fallback) | dissolve → fade_black |

**continuity**

| # | When | Candidates (left → right) |
|---|---|---|
| 1 | Only need to put the old prop down | put_down_prop → insert_hands_closeup → micro_jump |
| 2 | Only need to pick the new prop up | pick_up_prop → insert_hands_closeup → micro_jump |
| 3 | Put the old prop down and pick the new one up | swap_prop → insert_hands_closeup → micro_jump |
| 4 | Posture or position change, no prop conflict | rise_relocate → match_on_action → micro_jump |
| 5 | Compound prop plus posture/position change: pick the prop-base technique per the rows above and fold the move into its steps; overflow falls through | put_down_prop → pick_up_prop → swap_prop → insert_hands_closeup → occlusion_wipe |
| 6 | Only lightweight hazards remain (gaze, expression, tiny orientation tweak) and no other row matches | breath_beat |
| 7 | Environment state such as a lamp must change via character action | pick_up_prop → timelapse_light → micro_jump |
| 8 | Smooth bridging infeasible or T ≤ 1.5s | micro_jump → breath_beat → whip_pan → light_flash |

**Fast fallback** — scene_time: `light_flash, whip_pan, beat_snap, rack_focus`; continuity: `breath_beat, micro_jump, rack_focus`.

### 3.3 Hard Rules
1. **Legal ID set (exactly 32):** whip_pan, occlusion_wipe, zoom_through, roll_spin, motion_follow, object_to_lens, light_flash, speed_ramp, beat_snap, dissolve, fade_black, fade_white, match_cut, match_on_action, jump_cut_lapse, timelapse_light, clock_calendar, season_change, montage_flash, cutaway_insert, sound_bridge, rack_focus, oner_walkthrough, pov_shift, memory_dream, put_down_prop, pick_up_prop, swap_prop, rise_relocate, breath_beat, insert_hands_closeup, micro_jump. Any other id is invalid. Legacy aliases must be remapped: `zoom_punch → zoom_through`, `defocus_blur → rack_focus`, `light_lapse → timelapse_light`.
2. One technique per transition; `seconds` within its `seconds_min..seconds_max`; T in 0.5 steps; scene_time default 3.0; continuity 1.0–3.0; absolute minimum 1.0; clip cap 15s.
3. Mid-frame rule and shrink rule as in P7/P8; at T = 1.0 still failing → drop the transition and note "duration constraint too tight" in `reason`.
4. No prefix in `transition_prompt`; it covers only 0–T and ends settled on this shot's opening.
5. Image wins: no wardrobe/appearance prose; no invented props; `clock_calendar` requires an existing timepiece; `beat_snap` never with costume changes.
6. @ only assets bound to this shot; previous-shot content in plain words.
7. State each paw/hand's action and landing point in every bridge.
8. `sound_bridge` only on audio-capable models, and always paired with a visual device.
9. Executability skip rule applies within rows; default model H3.
10. Avoid repeating whip_pan / light_flash / beat_snap / micro_jump across consecutive shots.
11. `montage_flash` is a last resort; all vignettes inside bound scenes.
12. `verdict = "none"` when end state equals opening state: technique_id/seconds/transition_prompt are null.

### 3.4 Output JSON Schema

```json
{
  "verdict": "scene_time | continuity | none",
  "changes": ["time/location/narrative deltas, e.g. 'time: late morning → night'"],
  "hazards": ["continuity residues, e.g. 'held: dumbbells in both paws → paws empty'"],
  "technique_id": "one of the 32 legal ids, or null",
  "seconds": 3.0,
  "transition_prompt": "the filled template_en, no system prefix, or null",
  "reason": "matched row, skipped candidates and why; note 'duration constraint too tight' when dropped"
}
```

Example (#2→#3):

```json
{
  "verdict": "scene_time",
  "changes": ["time: late morning → night (day-night flip)", "location: balcony → @Study"],
  "hazards": ["posture: standing tree pose → seated at desk", "props: paws free → both forepaws on open book"],
  "technique_id": "fade_black",
  "seconds": 3.0,
  "transition_prompt": "[0-3s] Open on <Picture 1>: bright late-morning balcony — @Gini steady in tree pose on the yoga mat, eyes sparkling. Brightness falls smoothly, sinking to full black in about 1.5s; in the black, the quiet night-room ambience and a faint rustle of pages enter first; the image then fades up from black into @Study at night — warm desk-lamp glow bathing the small desk, @Gini seated at the desk with both forepaws resting on either side of the open book — reaching normal exposure and locking by 3 seconds.",
  "reason": "Day-night flip plus location change → scene_time row 1; fade_black is the first candidate, dark destination suits a through-black fade; T=3.0 within 2.0–3.0; no mid-frame constraint; black absorbs posture/prop hazards."
}
```

## 4. Same-Scene Action-Only Section

### 4.1 Residue Checklist
Compare `<Picture 1>` (previous end) against this shot's opening on seven axes:
1. **Held items** — what is in each paw/hand (the most dangerous residue);
2. **Posture** — sit / stand / crouch / lean / specific pose;
3. **Position** — where on the set;
4. **Orientation** — body facing;
5. **Gaze & expression** — direction, intensity (lightweight);
6. **Prop placement on set** — open/closed book, items moved;
7. **Environment state** — lamp on/off, door open/closed (must change via visible cause).

### 4.2 Comparison Method
1. Write one sentence for the previous shot's **end state** and one for this shot's **opening state**, each covering all seven axes.
2. Enumerate differences → `changes`; tag each as **hard** (held items, position, posture, environment state) or **lightweight** (gaze, expression, tiny orientation) → `hazards`.
3. Match the hazard profile to a continuity row (§3.2): props first (rows 1–3), posture/position (row 4), compound (row 5), lightweight only (row 6), environment (row 7), infeasible/short (row 8).

### 4.3 Smooth-Bridge Template Library

| Residue profile | Base technique | Fold-ins | Escape path |
|---|---|---|---|
| Old item in paw/hand, no longer needed | put_down_prop | small steps, turning | insert_hands_closeup → micro_jump |
| New item needed in paw/hand | pick_up_prop | state what the idle paw/hand steadies | insert_hands_closeup → micro_jump |
| Old out + new in | swap_prop (down first, then up) | re-seating, page pulls | insert_hands_closeup → micro_jump |
| Posture/position only, no prop conflict | rise_relocate (or match_on_action when motion carries) | prop micro-moves within steps | micro_jump |
| Gaze / expression / micro-orientation only | breath_beat | — | — |
| Environment state (lamp, switch) | pick_up_prop (operate the switch) / timelapse_light | — | micro_jump |
| Complex handoff dragging in wide shot | insert_hands_closeup | — | occlusion_wipe |

Ordering rule: **solve props first**, fold movement and posture into the prop-base technique's steps; what cannot fit falls through to the escape path.

### 4.4 Fallback
- Smooth bridging infeasible or **T ≤ 1.5s** → `micro_jump`, `breath_beat`, `whip_pan`, `light_flash` (continuity fast fallback: breath_beat, micro_jump, rack_focus).
- Every bridge still obeys P5 (each paw/hand stated), P3 (image wins) and P9 (settled by T).
- If even T = 1.0 fails the mid-frame constraint, drop the transition entirely; output nulls and note "duration constraint too tight" in `reason`.
