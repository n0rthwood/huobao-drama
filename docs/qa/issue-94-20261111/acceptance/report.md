# Issue #94 acceptance item 2 — production report

**Result: FAIL / blocked before layer and final-video coverage.** This is a technical acceptance report, not human artistic approval.

## Scope and authorization

- Production-only isolated project: drama **17**, `八达岭长城测试 1111`; episode **23**, display episode 1; documentary rules on; aspect ratio **9:16**.
- Evidence log: `requests.jsonl`. It records the supplied authorization quote on the first line and records every API read/write/error with intent, body keys, status, content type, and response (configuration secrets redacted).
- User-authorized human-decision calls actually made: script confirm; 13 asset-review `not_needed` dispositions after review; skeleton confirm; design-card confirms attempted after opening returned cards.

## Budget ledger (actual / cap)

| Category | Actual | Cap | Evidence |
|---|---:|---:|---|
| Images | 3 | 30 | tasks 1817 scene, 1818 prop, 1821 prop aspect-version |
| Videos | 0 | 3 | blocked before keyframes/videos |
| TTS | 8 | 8 | task 1807 |
| Billed text LLM | 24 | 40 | rewrite, inspection, extraction, review, skeleton, card fills/retry, asset prompts |

No cap was exceeded.

## Acceptance items

### a. Portrait scene asset — PASS

- Scene **124** `八达岭长城`, task **1817**, completed.
- Read-only DB task row has `params={"size":"1080x1920","aspect_locked":true}` and local path `static/images/a6abb40d-3faf-43ab-b3dc-99b345ba2948.png`.
- The actual opened media at `http://172.30.3.164/huobao/static/images/a6abb40d-3faf-43ab-b3dc-99b345ba2948.png` is **1088×1920** (Qwen alignment) and is visually portrait, with no stretching.
- The generated final scene prompt returned by `GET /episodes/23/scenes` contains `9:16 竖构图`.

### b. Portrait-scene layer base — FAIL / not reached

No layer segment was created before the documentary design-card blocker. Therefore there is no `base_check_required=false` segment, junction/keyframe contact sheet, or geometry comparison.

### c. 1024² prop contain/blurred-fill plus base check — FAIL / not reached

- Prop **221** `号炮` initially completed as task **1818**, a square 1024² image. Its actual opened image was `http://172.30.3.164/huobao/static/images/49a1551f-0076-44a2-9c9f-4752f55fcc4c.png`.
- No valid confirmed C/D layer plan using this prop was available. No layer base segment was rendered, so no `layer_base_check`, blocked video-preview reason, observations conversation, or contain/blurred-fill junction can truthfully be claimed.

### d. Crop, re-render, and layer editor UI — FAIL / not reached

No segment exists to crop. `storyboard_layer_segments` has **no rows** for storyboard IDs 595–602 (read-only DB query). No browser/editor page was opened because no segment ID/base-check panel existed.

### e. Aspect-version behavior — PASS

- Non-faithful prop **221**: `POST /props/221/aspect-version {episode_id:23,config_id:9}` returned task **1821**, `size:"1080x1920"`; it completed. Actual output opened at `http://172.30.3.164/huobao/static/images/0821a54a-7668-4ae3-a643-f56c0ddb119c.png`, measured **1088×1920** and visually preserves the cannon without stretching.
- Faithful/imported copy: `POST /dramas/17/assets/import {kind:"scene",source_id:120,episode_id:23}` created copy scene **125** `霸上军营`. `POST /scenes/125/aspect-version {episode_id:23,config_id:9}` returned HTTP **400**: `该素材不能重绘，请裁切到成片比例或留白，并通过视觉验证`.

### f. Final merged video — FAIL / not reached

No keyframes, videos, compose, or merge were submitted because production did not have valid confirmed layer-capable design cards. Thus there is no final media to inspect or sample.

## Blocking evidence

1. Initial `POST /episodes/23/design-cards/fill` task **1816** ended with `completed:2, failed:6`, error `6/8 个镜头未能保存可实现的设计卡`; persisted task observations identify missing image references. Those images were then generated and **only failed cards** retried.
2. The failed-only retry completed 6/6, and the remaining blank card completed 1/1. Final AI-selected cards were B/B/B/B/A/B/B/A.
3. Design-card confirmations succeeded for storyboards **595–598**. Confirmation of storyboard **599** returned HTTP **400** after the AI-created pending card had been opened: `设计卡未通过结构校验：请填写每个启用段的时长预算；图层段没有底图：请选一张已核验的忠实原件/已生成图，或选择承接上一镜` with issue codes `budget_missing` and `missing_base`.
4. The acceptance authorization permits confirmation endpoints but does **not** permit manually editing a card/combo/base to conceal the failed AI card. No direct DB/media edit or manual workaround was attempted.

## Read-only DB evidence

- Database: `/home/joysort/projects/huobao-drama/data/huobao.sqlite3`, opened with `bun:sqlite` `{readonly:true}`.
- `sys_task` rows: 1801 rewrite completed; 1805 asset review completed; 1806 skeleton completed; 1807 TTS completed 8/8; 1816 design-card task completed with 6 failed items; 1817 scene image completed with `size=1080x1920, aspect_locked=true`; 1818 square prop image completed with `size=1024x1024`; 1821 aspect-version task completed.
- `storyboard_layer_segments` query for storyboards 595–602 returned no rows; consequently there are no base-check DB rows to report.

## Open issue

The card-fill pipeline can persist a pending card (storyboard 599, combo A) that its own later confirmation rejects for `budget_missing` and `missing_base`. This blocks the requested #94 C/D layer-base acceptance path. The exact request/response, task 1816, and observations are preserved in `requests.jsonl`; no service change was made.

## Addendum — coordinator-authorized C coverage attempt

After the original report, the coordinator expressly authorized manual edits to cards **only** on drama 17 / episode 23. The exact IRC authorization is recorded in `requests.jsonl`.

- Cards 595, 596, and 597 were changed to confirmed combo **C** with 3-second layer segments and respectively: portrait scene 124/task 1817; the *original square* prop 221 version task **1818**; and imported faithful scene 125.
- C layer segments 43, 44, and 45 were drafted. The explicit `POST /episodes/23/layer-render-batch/preview` selected exactly storyboards 595–597. Render tasks **1889**, **1890**, and **1892** completed.
- For square-base storyboard **596**, `POST /layer-segments/storyboards/596/base-check` created completed text task **1894** (`kind:"layer_base_check"`). While that task was pending, the explicit video preview returned storyboard 596 blocked with exactly `图层底图待视觉验证`. Task 1894 output was `{"pass":true,"problems":[],"notes":"炮身、炮架与车轮完整无裁切，主体居中，比例与原件一致，上下模糊垫底衔接自然。"}`. The subsequent video preview cleared the visual-base reason and instead reported only `关键帧尚未确认`.
- `base_check` fields are nested under `data.segment` (not the top level): after task 1894, segment 44 has `base_check_required:true`, `base_check_satisfied:true`, and `base_check.status:"passed"` with `task_id:1894` and `config_id:10`; the junction carries the base-check result too. The task’s observations endpoint nevertheless returned `works:[]`, `calls:[]`, `messages:[]`. Coordinator confirmed this is the real observability defect; a master fix is pending production restart. No new base check will be triggered until that restart is explicitly complete.

### Revised item status

- **b: PARTIAL PASS.** A portrait scene base was drafted/rendered on C storyboard 595; its segment does not require a visual base check. Keyframe geometry remains untested.
- **c: PARTIAL PASS.** The actual 1024² prop version 1818 was rendered as C segment 44; the pending visual gate blocked video preview with the required Chinese reason, then nested segment `base_check.status:"passed"` cleared that block. The VLM result says the blurred upper/lower fill is natural. The required persisted base-check state is PASS; its required observations conversation is **FAIL** because task 1894 has no observed work/calls/messages.
- **d: PAUSED.** Coordinator supplied the normalized crop schema and instructed that no crop re-render/base check be triggered until the production restart carrying the observability fix is complete. No crop or UI screenshot has yet been taken.
- **f: IN PROGRESS.** Keyframes/videos for 595–597 may proceed without re-render; crop-related finalization remains paused for the restart.

## Queued production work

After preview, keyframe batch **20** submitted only the six C-shot mid/last slots for storyboards 595–597 (tasks 1896 onward). At the last logged observation all six were queued behind the production image queue (positions approximately 18–28), with none started or failed. No second submission, cancellation, retry, keyframe confirmation, video, compose, or merge request was made.

## Post-release crop and observability acceptance

Coordinator confirmed release `20261111T083953Z` / master `45a56fca`; its authorization and all API reads/writes below are in `requests.jsonl`.

- Storyboard **596** / segment **44** was cropped through the documented normalized 9:16 source crop (`x:0.21665,y:0,w:0.5667,h:1`) and rendered as task **1902**. The automatic new `layer_base_check` task **1903** rejected it: cannon muzzle/front was cut by the left edge, tail cut by the right edge, and the framing was too tight. The actual junction image was opened at `http://172.30.3.164/huobao/static/layer-frames/44-6fb5582f2d0734c548ecc59726b4589dde3248b18096b7c48e98e433fa6e768d.png`; it visibly confirms that the cannon is incomplete. No human override was used.
- Task **1903** proves the release’s observation-persistence correction: `GET /tasks/1903/observations?limit=200&with_messages=1&message_limit=100` returned one completed `layer_base_check` work (id 146), one vision-chat call (id 495), and persisted messages. This contrasts with task 1894’s pre-release empty arrays.
- The source crop was then removed and the complete 1024² original square base restored with the 544×960 contain viewport (`x:0,y:-0.3824,w:1,h:1.7647`). Final C segment render task **1910** completed; automatic base-check **1911** passed with the complete-cannon / natural blurred-fill finding. Its observations endpoint returned `works:1`, `calls:1`, `messages:4`.
- Browser acceptance used the real LAN UI on storyboard 596. The opened and inspected `layer-editor-596-crop.png` shows the crop-rejection UI and `裁切到成片比例` control; the exact normalized crop values were visible in the editor. The inspected `base-check-1911-detail.png` shows the final complete-square canvas, the 1:1-to-output warning, `裁切到成片比例`, task 1911, and the passing visual-base panel. The task-center overlay screenshot is `base-check-1911-task-center.png`. Browser console/API output showed the relevant API requests returning 200 and no page errors.

### Current acceptance status

- **b: PARTIAL PASS.** Portrait scene C base (595) rendered; six generated C mid/last images were opened. Scene-base frames 595 are vertically composed and free of output stretching. Full composed-video continuity remains pending.
- **c: PASS for layer-base containment/gate behavior.** Original 1024² prop task 1818 was preserved, the complete source was rendered with a 544×960 contain viewport, and the post-release task 1911 passed with persisted VLM work/call/message evidence. The failed crop task 1903 confirms that a geometrically valid 9:16 crop is not allowed to conceal material loss.
- **d: PASS.** Crop control, normalized 9:16 crop, re-render, failed automatic VLM completeness gate, restored complete base, post-release persisted observations, and browser UI evidence were all exercised. Screenshots are named above.
- **f: BLOCKED ON ACTIVE IMAGE QUEUE.** Original C keyframe batch 20 completed all six items. Visual inspection found storyboard 596’s original mid/last frames (tasks 1898/1899) depict only the Great Wall rather than its required cannon. Two corrected one-shot keyframe jobs were submitted with both required references, tasks **1912** and **1913**, and remain queued at the last observation. They must complete and be opened before confirming 596; no video, subtitle, compose, or merge is permissible beforehand.

## Budget ledger at last observation

| Category | Actual | Cap | Notes |
| --- | ---: | ---: | --- |
| Images | 11 | 30 | 3 asset/aspect images + 6 batch C keyframes + 2 corrected cannon keyframes |
| Videos | 1 | 3 | Video batch 22 submitted and completed storyboard 595 only |
| TTS | 8 | 8 | Completed before this addendum |
| Billed text LLM | approximately 35 | 40 | Initial video-prompt job reported five targets; authorized retry reported two |
## Final selected-shot production result

- The first scoped `POST /episodes/23/generate-video-prompts` request declared `storyboard_ids:[595,596,597]` but returned `total:5` and processed 595, 596, 597, **600**, and **601**. This is recorded as a separate non-#94 scoped-request finding. Only 595 saved a prompt; 596 and 597 did not.
- Per coordinator instruction, one retry with exactly `[596,597]` was made. It reported `total:2` and terminal status `completed:0, failed:2`. This is the separate normal model-failure finding. No prompt was manually written.
- Coordinator authorized proceeding with available C shots. Video batch **22** explicitly submitted 595 only with config **8** / `MiniMax-H3-INT8-ComfyUI`; task **1919** completed. Real video frames were opened at 0, 2, and 5 seconds (`video-1919-first.png`, `video-1919-2s.png`, `video-1919-5s.png`), showing the portrait Great Wall scene without stretching.
- Subtitle generation for 595 returned two SRT cues (`static/narration/5b68ea84-ebd6-4413-9c08-aa770ef439d9.srt`). Explicit compose of `[595]` completed 1/1. Explicit merge **35** of `[595]` completed to `static/merged/2f81f866-a491-44db-ac1a-485f75aef817.mp4`, duration 10 seconds.
- The final merged media was opened at 0, 4, and 8 seconds (`merge-35-first.png`, `merge-35-4s.png`, `merge-35-8s.png`). A full-frame 5-second inspection (`merge-35-5s-full.png`) visibly shows the burned Chinese narration subtitle in three lines, entirely inside the portrait frame.
- **f: PASS for the coordinator-authorized available C-shot final path.** The final result comprises storyboard 595 only because 596/597 each exhausted their authorized video-prompt retry without a saved prompt. Item c/d coverage remains independently satisfied by storyboard 596’s actual junction/base-check evidence.

## Final read-only DB evidence

The final read-only `bun:sqlite` query is preserved in terminal evidence. It confirms scene task **1817**, crop render **1902**, crop-rejection base check **1903**, restored contain render **1910**, passing observed base check **1911**, corrected cannon images **1912/1913**, completed video task **1919**, segment 44 pinned to prop 221/version task 1818 with `base_check.status:"passed"` / `task_id:1911`, and completed merge **35**.
