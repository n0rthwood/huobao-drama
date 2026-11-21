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


def step_node(key, status="done", ordering="strict", substeps=(), **over):
    n = {"key": key, "label": key, "order": 0, "ordering": ordering, "status": status,
         "criteria_met": status in ("done", "skipped"), "unlocked": True, "lock_reason": None, "goto": None,
         "done_criteria": [], "missing": [], "notices": [], "blocked_by": [], "substeps": list(substeps)}
    n.update(over)
    return n


def doc_steps(**over):
    steps = [
        step_node("raw"),
        step_node("rewrite", substeps=[step_node("rewrite.prepared"), step_node("rewrite.fidelity", "skipped"),
                                       step_node("rewrite.bridge"), step_node("rewrite.final"), step_node("rewrite.confirm")]),
        step_node("assets", substeps=[step_node("assets.extract"), step_node("assets.review")]),
        step_node("poster", ordering="free", required_before="export"),
        step_node("design", substeps=[step_node("design.skeleton"), step_node("design.voice"), step_node("design.cards")]),
        step_node("production", substeps=[step_node("production.layer", ordering="free"),
                                          step_node("production.keyframes", ordering="free")]),
        step_node("final"),
        step_node("export"),
    ]
    for key, val in over.items():
        for n in steps:
            if n["key"] == key:
                n.update(val) if isinstance(val, dict) else n.update({"status": val})
    return steps


def roadmap(steps=None, **over):
    rm = {"episode_id": E, "drama_id": 3, "project_type": "documentary", "strict": True,
          "status": {"effective": "completed", "derived": "completed", "override": None},
          "current": {"step": None, "substep": None}, "progress": {"done": 8, "total": 8},
          "milestones": [{"key": "m1_script", "label": "旁白稿定稿", "status": "done", "achieved_at": None,
                          "steps": ["raw", "rewrite"], "done_criteria": []},
                         {"key": "m2_production", "label": "制作完成", "status": "done", "achieved_at": None,
                          "steps": ["assets", "poster", "design", "production", "final"], "done_criteria": []},
                         {"key": "m3_export", "label": "成片导出", "status": "done", "achieved_at": None,
                          "steps": ["export"], "done_criteria": []}],
          "computed_at": "2026-11-15T00:00:00Z",
          "steps": doc_steps() if steps is None else steps}
    rm.update(over)
    return rm


def state(*shots, **over):
    s = {
        "problems": [], "canonical_ids": [x["id"] for x in shots],
        "batches": {"video": {"id": 1, "status": "done"}, "keyframe": {"id": 1, "status": "done"}, "compose": {"status": "done"},
                    "voice": {"status": "done"}, "video_prompts": {"status": "done"}, "keyframe_prompts": {"status": "done"}},
        "active_tasks": [], "poster_policy": "required",
        "poster": {"selected_version_id": 5, "versions": 1, "hash": "p", "approval": "valid", "waiver": []},
        "reconcile": {"orphans": [], "unknown_calls": []},
        "roadmap": roadmap(),
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

    def test_documentary_poster_cannot_be_waived(self):
        policy = hbwf.poster_policy_for("documentary", False)
        self.assertEqual(policy, "required")
        st = state(shot(1), poster_policy=policy, poster={"selected_version_id": None, "approval": "missing", "waiver": ["w1"]})
        self.assertTrue(any("poster" in p for p in hbwf.final_gate_problems(st, None)))
        self.assertIsNotNone(hbwf.poster_waiver_refusal("documentary"))

    def test_drama_poster_policy_unchanged(self):
        self.assertEqual(hbwf.poster_policy_for("drama", False), "decision_required")
        self.assertEqual(hbwf.poster_policy_for("drama", True), "required")
        self.assertIsNone(hbwf.poster_waiver_refusal("drama"))

    def test_unknown_project_type_fails_closed(self):
        self.assertEqual(hbwf.poster_policy_for(None, False), "required")
        self.assertIsNotNone(hbwf.poster_waiver_refusal(None))


class RoadmapMappingTest(unittest.TestCase):
    def test_write_endpoints_map_to_steps(self):
        cases = [
            ("PUT", f"/episodes/{E}", {"content": "x"}, ("raw", None)),
            ("PUT", f"/episodes/{E}", {"script_content": "x"}, ("rewrite", "rewrite.final")),
            ("PUT", f"/episodes/{E}", {"narration_enabled": True}, ("design", "design.voice")),
            ("POST", f"/episodes/{E}/script/confirm", {}, ("rewrite", "rewrite.confirm")),
            ("POST", f"/episodes/{E}/narration/voice-batch", {}, ("design", "design.voice")),
            ("PUT", f"/storyboards/1/design-card", {"combo": "C"}, ("design", "design.cards")),
            ("POST", f"/episodes/{E}/asset-review/run", {}, ("assets", "assets.review")),
            ("PUT", f"/episodes/{E}/poster/select", {"version_id": 1}, ("poster", None)),
            ("PUT", "/storyboards/1", {"video_prompt": "0-9秒：x"}, ("production", None)),
            ("PUT", "/storyboards/1", {"narration_text": "x"}, ("design", "design.voice")),
            ("POST", f"/episodes/{E}/keyframe-batch", {}, ("production", "production.keyframes")),
            ("POST", f"/episodes/{E}/video-batch", {}, ("final", None)),
            ("POST", f"/merge/episodes/{E}/merge", {}, ("export", None)),
        ]
        for method, path, body, want in cases:
            self.assertEqual(hbwf.write_step_of(method, path, body), want, f"{method} {path} {body}")
        self.assertIsNone(hbwf.write_step_of("POST", "/tasks/9/cancel", {}))
        self.assertIsNone(hbwf.write_step_of("GET", f"/episodes/{E}/roadmap", {}))

    def test_drama_keys_are_translated(self):
        rm = roadmap(project_type="drama", strict=False, steps=[step_node("script", ordering="free")])
        self.assertEqual(hbwf.roadmap_step_key(rm, "production"), "keyframes")
        self.assertEqual(hbwf.roadmap_step_key(rm, "final"), "videos")
        self.assertEqual(hbwf.roadmap_step_key(roadmap(), "production"), "production")


class RoadmapGuardTest(unittest.TestCase):
    def test_later_step_write_refused_with_blocked_by(self):
        rm = roadmap(steps=doc_steps(design="available", production="locked", final="locked"))
        errs, _, _ = run(state(shot(1), roadmap=rm), "POST", f"/episodes/{E}/generate-video-prompts",
                         {"storyboard_ids": [1], "config_id": 10, "model": "deepseek-chat"})
        self.assertTrue(any("blocked_by" in x and "design(available)" in x for x in errs), errs)

    def test_poster_pending_does_not_block_production_but_blocks_export(self):
        rm = roadmap(steps=doc_steps(poster="available"))
        st = state(shot(1), roadmap=rm)
        errs, _, _ = run(st, "POST", f"/episodes/{E}/compose-batch", {"storyboard_ids": [1]})
        self.assertFalse(any("blocked_by" in x for x in errs), errs)
        errs2, _, _ = run(st, "POST", f"/merge/episodes/{E}/merge", {"storyboard_ids": [1], "poster_version_id": 5})
        self.assertTrue(any("blocked_by" in x and "poster(available" in x for x in errs2), errs2)

    def test_done_or_current_step_writes_allowed(self):
        current = roadmap(steps=doc_steps(production="in_progress"))
        errs, _, _ = run(state(shot(1), roadmap=current), "POST", "/storyboards/1/confirm-keyframes", {"confirmed": True})
        self.assertEqual(errs, [])
        done = roadmap(steps=doc_steps())
        errs2, _, _ = run(state(shot(1), roadmap=done), "POST", "/storyboards/1/confirm-keyframes", {"confirmed": True})
        self.assertEqual(errs2, [])

    def test_locked_step_refused(self):
        rm = roadmap(steps=doc_steps(poster="locked", design={"status": "locked", "unlocked": False,
                                                              "lock_reason": "asset review missing"}))
        errs, _, _ = run(state(shot(1), roadmap=rm), "PUT", "/storyboards/1/design-card", {"design_card": {}})
        self.assertTrue(any("locked" in x and "asset review missing" in x for x in errs), errs)

    def test_strict_substep_order_enforced(self):
        rm = roadmap(steps=doc_steps(design={"status": "in_progress", "substeps": [
            step_node("design.skeleton", "available"), step_node("design.voice"), step_node("design.cards")]}))
        errs, _, _ = run(state(shot(1), roadmap=rm), "POST", "/storyboards/1/design-card/confirm", {"acknowledge": True})
        self.assertTrue(any("design.skeleton(available)" in x for x in errs), errs)

    def test_drama_roadmap_is_informational(self):
        rm = roadmap(project_type="drama", strict=False, steps=[
            step_node("script", "available", ordering="free"), step_node("export", "available", ordering="free")])
        errs, _, _ = run(state(shot(1), roadmap=rm), "POST", f"/episodes/{E}/generate-video-prompts",
                         {"storyboard_ids": [1], "config_id": 10, "model": "deepseek-chat"})
        self.assertFalse(any("roadmap blocked" in x for x in errs), errs)

    def test_missing_roadmap_fails_closed(self):
        errs, _, _ = run(state(shot(1), roadmap=None), "POST", f"/episodes/{E}/video-batch", {"storyboard_ids": [1]})
        self.assertTrue(any("roadmap unavailable" in x for x in errs), errs)
        self.assertTrue(hbwf.roadmap_gate_errors(None, "final", None, E))


class RoadmapCompletionTest(unittest.TestCase):
    def test_stale_step_blocks_final_gate(self):
        rm = roadmap(steps=doc_steps(design="stale"))
        probs = hbwf.final_gate_problems(state(shot(1), roadmap=rm), None)
        self.assertTrue(any("stale" in p and "design" in p for p in probs), probs)

    def test_unfinished_step_blocks_final_gate(self):
        rm = roadmap(steps=doc_steps(final="in_progress"))
        probs = hbwf.final_gate_problems(state(shot(1), roadmap=rm), None)
        self.assertTrue(any("unfinished before export" in p for p in probs), probs)

    def test_export_milestone_required_for_final_check(self):
        rm = roadmap(steps=doc_steps(export="available"), milestones=[{"key": "m3_export", "status": "pending"}])
        self.assertEqual([p for p in hbwf.roadmap_problems(rm) if "export step" in p], [])
        post = hbwf.roadmap_problems(rm, require_export=True)
        self.assertTrue(any("export step is available" in p for p in post), post)
        self.assertTrue(any("m3_export is pending" in p for p in post), post)

    def test_stale_export_does_not_block_merge_but_blocks_post_export(self):
        rm = roadmap(steps=doc_steps(export="stale"), milestones=[{"key": "m3_export", "status": "stale"}])
        self.assertEqual(hbwf.roadmap_problems(rm), [])
        post = hbwf.roadmap_problems(rm, require_export=True)
        self.assertTrue(any("stale" in p and "export" in p for p in post), post)
        self.assertTrue(any("m3_export is stale" in p for p in post), post)

    def test_drama_roadmap_is_informational_for_completion(self):
        rm = roadmap(project_type="drama", strict=False, steps=[
            step_node("script", ordering="free"), step_node("assets", "in_progress", ordering="free"),
            step_node("poster", "available", ordering="free"), step_node("keyframes", "in_progress", ordering="free"),
            step_node("videos", "in_progress", ordering="free"), step_node("export", "available", ordering="free")])
        self.assertEqual(hbwf.roadmap_problems(rm), [])


class RoadmapNextActionTest(unittest.TestCase):
    def test_documentary_reports_human_confirmations(self):
        skeleton_pending = roadmap(steps=doc_steps(design={"status": "in_progress", "substeps": [
            step_node("design.skeleton", "available"), step_node("design.voice"), step_node("design.cards")]}))
        self.assertEqual(hbwf.roadmap_next_action(skeleton_pending, "generate_keyframes"), "await_skeleton_confirm")
        cards_pending = roadmap(steps=doc_steps(design={"status": "in_progress", "substeps": [
            step_node("design.skeleton"), step_node("design.voice"), step_node("design.cards", "in_progress",
                                                                               counts={"done": 3, "total": 5})]}))
        self.assertEqual(hbwf.roadmap_next_action(cards_pending, "generate_keyframes"), "await_design_card_confirm")
        self.assertIsNone(hbwf.roadmap_next_action(cards_pending, "fix_narration"))
        self.assertEqual(hbwf.roadmap_next_action(roadmap(), "generate_keyframes"), None)

    def test_drama_next_action_unchanged(self):
        rm = roadmap(project_type="drama", strict=False, steps=[step_node("script", "available", ordering="free")])
        self.assertIsNone(hbwf.roadmap_next_action(rm, "generate_keyframes"))




class VisualDramaWorkflowTest(unittest.TestCase):
    def derive_visual(self, enabled=False, project_type='drama', profile='drama_visual', omit_flag=False):
        import tempfile
        from types import SimpleNamespace
        raw = {'id': 1, 'storyboard_number': 1, 'duration': 8, 'first_frame_prompt': 'start',
               'last_frame_prompt': 'end', 'first_frame_image': 'static/start.png',
               'last_frame_image': 'static/end.png', 'video_prompt': '0-8秒：两个朋友玩耍',
               'video_url': 'static/video.mp4', 'narration_status': 'disabled',
               'keyframes': {'ready': True, 'confirmed': True}, 'ref_issues': []}
        ep = {'id': E, 'script_content': 'Unchanged spoken dialogue'}
        if not omit_flag:
            ep['narration_enabled'] = enabled
        drama = {'project_type': project_type, 'episodes': [ep]}
        def get(path):
            if path == '/dramas/3':
                return drama
            if path == f'/episodes/{E}/storyboards':
                return [raw]
            return {}
        def preview(path, body):
            if 'keyframe' in path:
                return {'items': [{'storyboard_id': 1, 'slot': slot, 'status': 'unchanged'} for slot in ('first', 'last')]}
            return {'items': [{'storyboard_id': 1, 'status': 'unchanged'}]}
        with tempfile.TemporaryDirectory() as tmp:
            prj = SimpleNamespace(d=3, e=E, dir=Path(tmp), profile={'applies': {'project_type': 'drama', 'narration_enabled': False}} if profile == 'drama_visual' else {'applies': {}},
                config={'profile': profile, 'models': MODELS, 'required_poster': True, 'created_at': '2026-11-21T00:00:00Z'},
                get=get, get_optional=lambda path: (roadmap(project_type=project_type, strict=False), None),
                preview=preview, read_jsonl=lambda filename: [], canonical_ids=lambda: [1])
            return hbwf.derive(prj, write=False)

    def test_explicit_visual_drama_skips_only_narration_requirements(self):
        st = self.derive_visual()
        self.assertFalse(st['narration_required'])
        self.assertEqual(st['shots'][0]['next'], 'review_keyframes')
        self.assertFalse(any('coverage/order' in p for p in st['problems']))

    def test_missing_or_non_boolean_false_does_not_disable_narration(self):
        for value, omit in [(None, True), (None, False), (0, False), ('false', False), (True, False)]:
            with self.subTest(value=value, omit=omit):
                st = self.derive_visual(enabled=value, omit_flag=omit)
                self.assertTrue(st['narration_required'])
                self.assertEqual(st['shots'][0]['next'], 'fix_narration')
                self.assertTrue(any('requires' in p for p in st['problems']))
                errs, _, _ = run(st, 'POST', f'/episodes/{E}/video-batch', {'storyboard_ids': [1]})
                self.assertTrue(errs)

    def test_documentary_cannot_use_visual_profile(self):
        st = self.derive_visual(project_type='documentary')
        self.assertTrue(st['narration_required'])
        self.assertTrue(st['problems'])

    def test_existing_narration_profile_still_checks_audio_and_script_coverage(self):
        st = self.derive_visual(enabled=True, profile='drama_narration')
        self.assertTrue(st['narration_required'])
        self.assertEqual(st['shots'][0]['next'], 'fix_narration')
        self.assertTrue(any('coverage/order' in p for p in st['problems']))

    def visual_shot(self, **over):
        return shot(1, narration={'required': False, 'ok': True, 'status': 'disabled'},
                    subtitle_ok=False, compose={'url': None, 'preview': 'disabled', 'exportable': False},
                    **over)

    def test_reviewed_visual_video_can_complete_and_merge_without_compose(self):
        r = self.visual_shot()
        self.assertEqual(r['next'], 'done')
        st = state(r, roadmap=roadmap(project_type='drama', strict=False))
        errs, _, _ = run(st, 'POST', f'/merge/episodes/{E}/merge', {'storyboard_ids': [1], 'poster_version_id': 5})
        self.assertEqual(errs, [])

    def test_visual_mode_still_requires_current_reviewed_video(self):
        for change, expected in [({'video': {'url': None, 'preview': 'missing'}}, 'generate_video'),
                                 ({'video': {'preview': 'changed'}}, 'generate_video'),
                                 ({'approvals': {'video_approval': 'stale'}}, 'review_video')]:
            with self.subTest(change=change):
                r = self.visual_shot(**change)
                self.assertEqual(r['next'], expected)
                self.assertTrue(hbwf.final_gate_problems(state(r), None))

    def test_visual_mode_preserves_poster_canonical_and_running_task_gates(self):
        for over in [{'poster': {'approval': 'missing'}}, {'canonical_ids': [2]},
                     {'active_tasks': [{'id': 99, 'status': 'running'}]},
                     {'reconcile': {'orphans': [{'key': 'task:99'}], 'unknown_calls': []}}]:
            with self.subTest(over=over):
                st = state(self.visual_shot(), **over)
                body = {'storyboard_ids': [1], 'poster_version_id': 5}
                self.assertTrue(hbwf.final_gate_problems(st, body))

    def test_completed_export_passes_but_changed_video_requires_reexport(self):
        # The server compares latest_merge.scenes to the current video paths in order.
        current = roadmap(project_type='drama', strict=False, steps=[step_node('export')])
        self.assertEqual(hbwf.roadmap_problems(current, require_export=True), [])
        changed = copy.deepcopy(current)
        changed['steps'][0]['status'] = 'stale'
        changed['steps'][0]['missing'] = [{'code': 'merge_outdated', 'message': 'current video path changed'}]
        changed['milestones'][-1]['status'] = 'stale'
        self.assertEqual(hbwf.roadmap_problems(changed), [])
        self.assertTrue(hbwf.roadmap_problems(changed, require_export=True))
        self.assertEqual(hbwf.roadmap_problems(current, require_export=True), [])

    def test_missing_export_milestone_remains_blocked(self):
        self.assertTrue(hbwf.roadmap_problems(roadmap(milestones=[]), require_export=True))


if __name__ == "__main__":
    unittest.main()
