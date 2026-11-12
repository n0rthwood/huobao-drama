"""Deterministic behaviour tests for hbwf policy functions (no network).

Run: python3 -m unittest docs/skills/huobao-director/workflow/test_hbwf.py
"""
import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hbwf  # noqa: E402

E = 26
MODELS = {"text": {"config_id": 10, "model": "deepseek-chat"}, "image": {"config_id": 9, "model": "qwen-image-2.1"},
          "video": {"config_id": 8, "model": "MiniMax-H3-INT8-ComfyUI"}, "tts": {"config_id": 13}}


def shot(sid, **over):
    r = {
        "id": sid, "number": sid, "duration": 9.0,
        "narration": {"ok": True, "status": "voiced", "tempo": 1.0, "duration_ms": 8000},
        "subtitle_ok": True,
        "kf_prompts": {"ok": True, "problems": [], "required_slots": ["first", "mid", "last"], "saved_at": 100},
        "video_prompt": {"ok": True, "problems": [], "warnings": [], "hash": "vp", "saved_at": 100},
        "keyframes": {"slots": {"first": "unchanged", "mid": "unchanged", "last": "unchanged"}, "ready": True,
                      "confirmed": True, "image_hash": "img", "queued_slots": []},
        "video": {"url": "static/videos/a.mp4", "preview": "unchanged", "preview_reason": None, "queued": None},
        "compose": {"url": "static/composed/a.mp4", "preview": "unchanged", "exportable": True, "blocked": False, "reason": None},
        "frozen_by_calls": [],
        "approvals": {"keyframe_approval": "valid", "video_prompt_review": "valid", "video_approval": "valid", "compose_approval": "valid"},
    }
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(r.get(k), dict):
            r[k].update(v)
        else:
            r[k] = v
    r["next"] = hbwf.next_action(r)
    return r


def state(*shots, **over):
    s = {
        "problems": [], "canonical_ids": [x["id"] for x in shots],
        "batches": {"video": {"id": 1, "status": "done"}, "keyframe": {"id": 1, "status": "done"}, "compose": {"status": "done"},
                    "voice": {"status": "done"}, "video_prompts": {"status": "done"}, "keyframe_prompts": {"status": "done"}},
        "active_tasks": [], "poster_policy": "required",
        "poster": {"selected_version_id": 5, "versions": 1, "hash": "p", "approval": "valid", "waiver": []},
        "reconcile": {"orphans": [], "unknown_calls": []},
        "shots": list(shots),
    }
    for k, v in over.items():
        if isinstance(v, dict) and isinstance(s.get(k), dict):
            s[k] = {**s[k], **v}
        else:
            s[k] = v
    return s


def ctx(decisions=(), ledger=(), voice=None):
    return {"episode_id": E, "models": MODELS, "decisions": list(decisions), "ledger": list(ledger), "voice_preview": voice}


def run(st, method, path, body, ids=None, decisions=(), ledger=(), voice=None):
    try:
        errors, warnings, exc = hbwf.guard(ctx(decisions, ledger, voice), method, path, body, ids, st)
    except hbwf.GuardError as e:
        return [str(e)], [], None
    return errors, warnings, exc


class TimelineTest(unittest.TestCase):
    def test_overlong_timeline_is_a_problem(self):
        r = hbwf.timeline_check("0-3秒：a。3-6秒：b。6-9.8秒：c。9-12.3秒：d", 9.8, None)
        self.assertTrue(any("12.3" in i for i in r["issues"]))

    def test_contiguous_timeline_ending_at_duration_passes(self):
        self.assertEqual(hbwf.timeline_check("0-3秒：a。3-6秒：b。6-9.8秒：c", 9.8, 3)["issues"], [])

    def test_missing_segments_only_warns(self):
        r = hbwf.timeline_check("缓慢推镜", 8, None)
        self.assertEqual(r["issues"], [])
        self.assertTrue(r["warnings"])


class NextActionTest(unittest.TestCase):
    def test_shot_without_video_needs_generation_not_compose(self):
        r = shot(809, video={"url": None, "preview": "missing"}, compose={"url": None, "preview": "blocked", "exportable": False, "blocked": True},
                 approvals={"video_prompt_review": "missing", "video_approval": "missing", "compose_approval": "missing"})
        self.assertEqual(r["next"], "review_video_prompt")

    def test_changed_slot_needs_generation_before_review(self):
        r = shot(1, keyframes={"slots": {"first": "changed", "mid": "unchanged", "last": "unchanged"}, "confirmed": False})
        self.assertEqual(r["next"], "generate_keyframes")

    def test_stale_approval_requires_review(self):
        self.assertEqual(shot(1, approvals={"keyframe_approval": "stale"})["next"], "review_keyframes")

    def test_accelerated_narration_blocks(self):
        self.assertEqual(shot(1, narration={"tempo": 1.07})["next"], "remove_acceleration")

    def test_done(self):
        self.assertEqual(shot(1)["next"], "done")


class PromptGuardTest(unittest.TestCase):
    def test_batch_prompt_rewrite_of_completed_shot_refused(self):
        st = state(shot(1))
        errs, _, _ = run(st, "POST", f"/episodes/{E}/generate-keyframe-prompts", {"storyboard_ids": [1], "config_id": 10, "model": "deepseek-chat"})
        self.assertTrue(any("already complete" in e for e in errs))

    def test_rework_decision_after_last_save_allows_rewrite(self):
        st = state(shot(1))
        dec = [{"id": "d1", "kind": "rework", "ids": [1], "scope": ["keyframe_prompts"], "ts": 200}]
        errs, _, _ = run(st, "POST", f"/episodes/{E}/generate-keyframe-prompts", {"storyboard_ids": [1]}, decisions=dec)
        self.assertEqual(errs, [])

    def test_rework_decision_consumed_by_later_save(self):
        st = state(shot(1, kf_prompts={"saved_at": 300}))
        dec = [{"id": "d1", "kind": "rework", "ids": [1], "scope": ["keyframe_prompts"], "ts": 200}]
        errs, _, _ = run(st, "POST", f"/episodes/{E}/generate-keyframe-prompts", {"storyboard_ids": [1]}, decisions=dec)
        self.assertTrue(errs)

    def test_empty_ids_refused(self):
        errs, _, _ = run(state(shot(1)), "POST", f"/episodes/{E}/generate-keyframe-prompts", {"storyboard_ids": []})
        self.assertTrue(any("non-empty" in e for e in errs))

    def test_video_prompt_batch_only_for_empty_prompts(self):
        st = state(shot(1, video_prompt={"ok": False, "problems": ["timeline ends 12s > duration 9s"]}))
        errs, _, _ = run(st, "POST", f"/episodes/{E}/generate-video-prompts", {"storyboard_ids": [1]})
        self.assertTrue(any("force-rewrites" in e for e in errs))
        st2 = state(shot(2, video_prompt={"ok": False, "problems": ["video_prompt empty"]}))
        errs2, warns, _ = run(st2, "POST", f"/episodes/{E}/generate-video-prompts", {"storyboard_ids": [2]})
        self.assertEqual(errs2, [])
        self.assertTrue(warns)

    def test_queued_shot_prompts_frozen(self):
        st = state(shot(1, video_prompt={"ok": False, "problems": ["x"]}, video={"queued": "pending"}))
        errs, _, _ = run(st, "POST", "/agent/prompt_generator/chat",
                         {"episode_id": E, "config_id": 10, "model": "deepseek-chat", "message": "Do not call readStoryboardContext"}, ids=[1])
        self.assertTrue(any("frozen" in e for e in errs))

    def test_chat_requires_declared_ids_and_context_ban(self):
        errs, _, _ = run(state(shot(1)), "POST", "/agent/prompt_generator/chat", {"episode_id": E, "message": "fix"})
        self.assertTrue(any("--ids" in e for e in errs))
        self.assertTrue(any("readStoryboardContext" in e for e in errs))


class MediaGuardTest(unittest.TestCase):
    def test_compose_without_video_refused(self):
        r = shot(809, video={"url": None, "preview": "missing"}, approvals={"video_approval": "missing"},
                 compose={"url": None, "preview": "blocked", "blocked": True, "exportable": False})
        errs, _, _ = run(state(r), "POST", f"/episodes/{E}/compose-batch", {"storyboard_ids": [809]})
        self.assertTrue(any("no reviewed video" in e for e in errs))

    def test_video_requires_prompt_review_and_missing_preview(self):
        r = shot(5, video={"url": None, "preview": "missing"}, approvals={"video_prompt_review": "missing"})
        errs, _, _ = run(state(r), "POST", f"/episodes/{E}/video-batch", {"storyboard_ids": [5], "config_id": 8, "model": "MiniMax-H3-INT8-ComfyUI"})
        self.assertTrue(any("video_prompt_review" in e for e in errs))

    def test_video_model_is_fixed(self):
        r = shot(5, video={"url": None, "preview": "missing"})
        errs, _, _ = run(state(r), "POST", f"/episodes/{E}/video-batch", {"storyboard_ids": [5], "config_id": 7, "model": "wan2.2"})
        self.assertTrue(any("config_id must be 8" in e for e in errs))

    def test_interleaving_video_and_keyframe_batches(self):
        a = shot(1, video={"url": None, "preview": "missing"})
        b = shot(2, keyframes={"slots": {"first": "missing", "mid": "missing", "last": "missing"}, "confirmed": False})
        st = state(a, b, batches={"keyframe": {"id": 7, "status": "running"}})
        errs, _, _ = run(st, "POST", f"/episodes/{E}/video-batch", {"storyboard_ids": [1]})
        self.assertEqual(errs, [])
        errs2, _, _ = run(st, "POST", f"/episodes/{E}/keyframe-batch", {"items": [{"storyboard_id": 2, "slot": "first"}]})
        self.assertTrue(any("already running" in e for e in errs2))
        st_idle = state(a, b)
        errs3, _, _ = run(st_idle, "POST", f"/episodes/{E}/keyframe-batch", {"items": [{"storyboard_id": 2, "slot": "first"}]})
        self.assertEqual(errs3, [])

    def test_unchanged_slot_not_regenerated(self):
        errs, _, _ = run(state(shot(1)), "POST", f"/episodes/{E}/keyframe-batch", {"items": [{"storyboard_id": 1, "slot": "first"}]})
        self.assertTrue(any("only missing/changed" in e for e in errs))

    def test_confirm_needs_valid_approval(self):
        r = shot(1, approvals={"keyframe_approval": "missing"}, keyframes={"confirmed": False})
        errs, _, _ = run(state(r), "POST", "/storyboards/1/confirm-keyframes", {"confirmed": True})
        self.assertTrue(errs)

    def test_acceleration_refused(self):
        errs, _, _ = run(state(shot(1)), "PUT", "/storyboards/1/narration-fit", {"mode": "tempo", "tempo_override": 1.2})
        self.assertTrue(errs)


class StructureAndExceptionTest(unittest.TestCase):
    def test_unlisted_write_needs_single_use_exception(self):
        st = state(shot(1))
        errs, _, _ = run(st, "POST", "/episodes/26/video-batch/cancel", {})
        self.assertTrue(errs)
        dec = [{"id": "x1", "kind": "exception", "method": "POST", "path_regex": r"/episodes/26/video-batch/cancel", "ts": 1}]
        errs2, _, exc = run(st, "POST", "/episodes/26/video-batch/cancel", {}, decisions=dec)
        self.assertEqual((errs2, exc), ([], "x1"))
        used = [{"phase": "prepared", "exception_id": "x1"}]
        errs3, _, _ = run(st, "POST", "/episodes/26/video-batch/cancel", {}, decisions=dec, ledger=used)
        self.assertTrue(errs3)

    def test_storyboard_creation_needs_structural_decision(self):
        errs, _, _ = run(state(shot(1)), "POST", "/storyboards", {"episode_id": E})
        self.assertTrue(errs)


class FinalGateTest(unittest.TestCase):
    def test_required_poster_missing_fails(self):
        st = state(shot(1), poster={"selected_version_id": None, "approval": "missing"})
        self.assertTrue(any("poster" in p for p in hbwf.final_gate_problems(st, None)))

    def test_merge_order_must_be_canonical(self):
        st = state(shot(1), shot(2))
        probs = hbwf.final_gate_problems(st, {"storyboard_ids": [2, 1], "poster_version_id": 5})
        self.assertTrue(any("canonical" in p for p in probs))
        self.assertEqual(hbwf.final_gate_problems(st, {"storyboard_ids": [1, 2], "poster_version_id": 5}), [])

    def test_orphans_block_export(self):
        st = state(shot(1), reconcile={"orphans": [{"key": "task:9"}], "unknown_calls": []})
        self.assertTrue(any("orphans" in p for p in hbwf.final_gate_problems(st, None)))

    def test_waiver_only_when_not_required(self):
        st = state(shot(1), poster_policy="decision_required", poster={"selected_version_id": None, "approval": "missing", "waiver": ["w1"]})
        self.assertEqual(hbwf.final_gate_problems(st, None), [])
        st["poster_policy"] = "required"
        self.assertTrue(hbwf.final_gate_problems(st, None))


if __name__ == "__main__":
    unittest.main()
