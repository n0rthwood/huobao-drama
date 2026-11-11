# Coordinator restart checkpoint

At coordinator instruction, production submissions stopped after keyframe batch **19** reached terminal state.

- Completed: 35 of 39 submitted keyframe slots.
- Failed: 4 slots — storyboard 583 `mid`/`last`, 584 `mid`, 585 `last`.
- All four errors are `KSampler` CUDA allocation OOM (full API response is in `keyframe-status-9.json` and `requests.jsonl`).
- No retry, video batch, or new text task was submitted after the checkpoint.
- Awaiting coordinator confirmation that the backend restart is complete.
