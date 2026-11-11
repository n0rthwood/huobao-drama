# Issue #94 acceptance item 3 — drama 15 / episode 21 rework

**Target:** drama **15** 《历史上的今天纪录片》, episode **21** (display episode 1, 《秦亡》), 9:16, storyboards **573–594** (22 shots).

**Outcome:** **BLOCKED — compose, merge, and final export were not submitted.** The image/layer/keyframe/video production work completed within budget, but real raw-video inspection found that H3 did not honor the supplied C-combo junction frame at time zero for sampled shots. This breaks the required seamless layer→generated handoff. No override, manual patch, compose, or merge was used.

## Authorization and scope

- User authorization is preserved in [`authorization.md`](authorization.md), including: “5，是的，需要返工”, the approved “按照建议” plan, and the explicit authority to re-confirm keyframes that were auto-unconfirmed solely by these image changes.
- Narration, design-card content, combos, and keyframe prompt text were not edited.
- All business changes used production HTTP API only. The pre-state read-only database capture is [`before-db-readonly.json`](before-db-readonly.json).

## Budget ledger

| Category | Cap | Attempted | Result |
|---|---:|---:|---|
| Images | 75 | **54** | 8 asset-image attempts + 46 keyframe attempts (39 initial; retries 4 + 2 + 1) |
| Videos | 26 | **22** | video batch 23, all completed |
| TTS | 0 | **0** | none |
| Billed text calls | 30 | **10** | 7 scene-prompt calls + 3 `layer_base_check` vision calls |

Full ledger: [`budget-ledger.json`](budget-ledger.json). The four initial keyframe OOM failures were recovered solely with `keyframe-batch/retry-failed`; the final batch result was 39 completed / 0 failed.

## Acceptance results

| Item | Result | Evidence |
|---|---|---|
| 1. Before-state snapshot | **PASS** | API/DB state: [`before-db-readonly.json`](before-db-readonly.json), [`before-layer-segments-api.json`](before-layer-segments-api.json), [`requests.jsonl`](requests.jsonl). Previous latest merge: ID **34**, `static/merged/f9426ebb-7cdd-4e4f-9125-12c296b84c57.mp4`, 253 s. |
| 2. Scenes 111–116, 122 portrait prompts + images | **PASS** | All regenerated prompts contain `9:16 竖构图`; all eight image tasks **1808–1815** completed with `aspect_locked:true`, 1088×1920 output. Images were opened individually. Before/after sheets: [`before-scene-assets-contact-sheet.png`](before-scene-assets-contact-sheet.png), [`after-scene-assets-contact-sheet.png`](after-scene-assets-contact-sheet.png). |
| 3. Prop 217 portrait aspect version | **PASS** | `POST /props/217/aspect-version` task **1815**, current result `static/images/8c03d0ac-1fbe-4140-8f83-dcca1ba7e88b.png`; opened in [`after/assets/prop-217.png`](after/assets/prop-217.png). Shot 19’s old pinned version was unpinned and its LayerDoc base changed only to that opened current image; final base is 1088×1920 and has no obsolete square crop: [`shot19-current-prop-layer-doc.json`](shot19-current-prop-layer-doc.json). |
| 4. 22 layer-segment renders and base checks | **PASS** | Preview selected all 22, render batch task **1819** completed 22/22; shot 19 rerender task **1846** completed. Base rows: [`base-check-rows.json`](base-check-rows.json). All 22 report `base_check_satisfied:true`. The imported landscape base on shot 16 was kept as **contain + blurred fill**, not cropped or stretched; its post-release VLM check task **1917** passed: `主体完整…比例与底图一致…无撕裂或重影`. The opened frame is [`after/junctions/shot-16.png`](after/junctions/shot-16.png). All junctions: [`after-junction-frames-contact-sheet.png`](after-junction-frames-contact-sheet.png). |
| 4a. Post-release base-check observability | **PASS** | Task **1917** has 1 work, 1 completed `vision_chat` call, and 4 persisted public messages: [`post-release-shot16-base-check-observations.json`](post-release-shot16-base-check-observations.json). |
| 5. Keyframes | **PASS** | Batch **19**: 39 preview-selected changed slots; recovered OOM slots with retry-failed (4 → 2 → 1); final 39/39 completed. All 22 were re-confirmed using the user’s explicit authorization after opening contact sheets: [`keyframe-confirmations.json`](keyframe-confirmations.json). Per-shot visual sheets: [`after/per-shot-keyframes/`](after/per-shot-keyframes/); all-shot sheet: [`after-keyframes-per-shot-contact-sheet.png`](after-keyframes-per-shot-contact-sheet.png). |
| 6. H3 video batch produced | **PASS (generation only)** | Preview selected exactly IDs 573–594; batch **23**, config **8**, model **MiniMax-H3-INT8-ComfyUI**, terminal 22 completed / 0 failed: [`video-start.json`](video-start.json), [`video-status-8.json`](video-status-8.json). |
| 6a. H3 first-frame guide fidelity | **FAIL — blocking** | Real first/mid/last browser frames were captured/opened for shots #1, #4, #8, #12, #16, #19: [`video-sample-frames-contact-sheet.png`](video-sample-frames-contact-sheet.png). The first raw frames do not match the submitted C junctions for #1, #16, or #19, despite task params explicitly naming the junction as `firstFrameUrl` and `junction_slot:"first"`. Details below. |
| 7. Subtitle, compose, merge, final media | **NOT ATTEMPTED (blocked by 6a)** | No subtitle-generation write, compose batch, merge, or final export was submitted after the guide-frame defect. There is therefore no new merge ID or final media path/duration/resolution to claim. |

## Blocking defect evidence — H3 does not start on the supplied junction

All screenshots were extracted from real generated MP4s through an isolated `agent-browser` session and then opened with the file reader. Browser metadata confirmed each sampled raw MP4 as **544×960**, `readyState=4`.

| Shot | Video task | Submitted `firstFrameUrl` / opened junction | Actual raw first frame | Evidence |
|---:|---:|---|---|---|
| #1 / 573 | **1922** | `static/layer-frames/21-31beb09…png` — empty open gate | 子婴 is already walking out of the gate at 0:00; it is not the submitted empty junction | [`video-frames/shot-1-first.png`](video-frames/shot-1-first.png), [`after/junctions/shot-1.png`](after/junctions/shot-1.png) |
| #16 / 588 | **1937** | `static/layer-frames/36-9be396…png` — imported night camp, contain + blurred top/bottom fill | 刘邦, a man, and sheep are already on the sunlit street at 0:00; it is not the camp junction | [`video-frames/shot-16-first.png`](video-frames/shot-16-first.png), [`after/junctions/shot-16.png`](after/junctions/shot-16.png) |
| #19 / 591 | **1940** | `static/layer-frames/39-6d16e8…png` — portrait 行军地图 base | Armored men stand before a gate at 0:00; it is not the map junction | [`video-frames/shot-19-first.png`](video-frames/shot-19-first.png), [`after/junctions/shot-19.png`](after/junctions/shot-19.png) |

The service-side H3 task records prove that the expected inputs were submitted, including `firstFrameUrl`, `junction_hash`, and `junction_slot:"first"`; see [`video-guide-mismatch-task-evidence.json`](video-guide-mismatch-task-evidence.json). The issue is not a base-check failure and was not bypassed: #16’s VLM base check passed, and #19’s portrait prop base needed no visual check after it matched the output aspect.

## Production IDs

- Asset image tasks: **1808–1815** (all completed)
- Layer render batches: **1819** (22 shots) and **1846** (shot 19)
- Automated base checks: **1838** (shot 16), **1842** (shot 19 old cropped base), **1917** (post-release shot 16, passed with persisted observations)
- Keyframe batch: **19** (39 terminal completed)
- Video batch: **23** (22 terminal completed)
- Sample video tasks: **1922** (#1), **1937** (#16), **1940** (#19)
- No rework merge was created. The pre-rework latest merge was **34**.

## Request and error log

Every production API read/write/error and downloaded media request is recorded in [`requests.jsonl`](requests.jsonl), with intent, body keys, status, content type, first choice, source, and response evidence. The initial KSampler failures (and all retries) are in [`keyframe-status-9.json`](keyframe-status-9.json) through [`keyframe-status-retry-6.json`](keyframe-status-retry-6.json).

## Required next action

Fix the H3 C-combo first-frame guide application / guide-frame timeline behavior, then rerun this affected video branch through the API. Do not compose or merge the current raw-video set: it visibly breaks the layer→generated junction at time zero.

This is a technical acceptance report only; it does not represent human artistic or factual approval.
