#!/usr/bin/env python3
"""hbwf — Huobao episode production workflow guard (Issue #97).

Every business write for an episode goes through `hbwf call`. State is re-derived from
Huobao GET/preview endpoints on every guarded call; nothing is tracked from chat memory.
Step state comes from `GET /episodes/{e}/roadmap` (Issue #105): documentary projects are
strictly ordered (a write is refused while an earlier strict step is not done/skipped),
drama projects read the roadmap for information only.

Project layout (production project directory, never inside a repo):
  workflow/workflow.json    static config (ids, profile, fixed models, poster policy)
  workflow/state.json       derived snapshot (`hbwf derive`); never hand-edited
  workflow/decisions.jsonl  human/proxy decisions, bound to artifact version hashes
  workflow/ledger.jsonl     every guarded call: prepared -> outcome, guard verdict
  workflow/bodies/          large request bodies referenced from the ledger
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROFILE_DIR = HERE / "profiles"
GATE_SOURCE = HERE / "omp-extension" / "huobao-workflow-gate.ts"
GATE_INSTALLED = Path(os.environ.get("HBWF_GATE_PATH", Path.home() / ".omp/agent/extensions/huobao-workflow-gate.ts"))
WF_DIR = "workflow"
SLOTS = ("first", "mid", "last")
KF_PROMPT_FIELDS = ("first_frame_prompt", "mid_frame_prompt", "last_frame_prompt", "mid_frame_time")
PROMPT_FIELDS = KF_PROMPT_FIELDS + ("video_prompt",)
NEEDS_GEN = ("missing", "changed")
RUNNING = ("running", "pending", "queued", "processing")
APPROVAL_KINDS = ("keyframe_approval", "video_prompt_review", "video_approval", "compose_approval", "poster_approval", "script_approval")
SCOPED_KINDS = ("rework", "structural_change", "exception", "reconcile", "poster_waiver")
ALL_KINDS = APPROVAL_KINDS + SCOPED_KINDS
SEGMENT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*[-—–~～至到]\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b|s[:：])")
BODY_INLINE_LIMIT = 2000
DONE_STATUSES = ("done", "skipped")
# Roadmap (Issue #105): GET /episodes/{e}/roadmap is the only step-state source.
DOC_STEPS = ("raw", "rewrite", "assets", "poster", "design", "production", "final", "export")
DRAMA_STEP_OF = {"raw": "script", "rewrite": "script", "assets": "assets", "poster": "poster",
                 "design": "keyframes", "production": "keyframes", "final": "videos", "export": "export"}
HUMAN_CONFIRM_SUBSTEPS = (("design.skeleton", "await_skeleton_confirm"), ("design.cards", "await_design_card_confirm"))
# Per-shot actions that only run after the design card gate; a pending card confirmation replaces them.
DESIGN_GATED_ACTIONS = {"write_keyframe_prompts", "generate_keyframes", "wait_keyframes", "review_keyframes",
                        "confirm_keyframes", "write_video_prompt", "review_video_prompt", "generate_video",
                        "wait_video", "review_video", "compose", "review_compose", "done"}
EPISODE_VOICE_KEYS = {"narration_enabled", "tts_config_id", "subtitle_timing", "audio_mix_mode", "audio_bed_gain_db",
                      "narration_fit_default", "narration_spine", "narration_normalize"}
# Explicit write endpoint -> roadmap step table (documentary keys; drama is translated, see DRAMA_STEP_OF).
# Order matters: most specific pattern first. `PUT /episodes/{id}` and `PUT /storyboards/{id}` are body-refined
# in write_step_of(). Writes not in this table stay unmanaged (they still need a single-use `exception`).
WRITE_STEPS = (
    ("POST", r"/episodes/\d+/script/(?:confirm|unconfirm)", "rewrite", "rewrite.confirm"),
    ("PUT", r"/episodes/\d+/script-rewrite/final", "rewrite", "rewrite.final"),
    ("POST", r"/episodes/\d+/script-rewrite(?:/.*)?", "rewrite", None),
    ("POST", r"/agent/script_rewriter/chat", "rewrite", None),
    ("PUT", r"/episodes/\d+/narration-skeleton", "design", "design.skeleton"),
    ("POST", r"/episodes/\d+/narration-skeleton/.+", "design", "design.skeleton"),
    ("POST", r"/episodes/\d+/storyboards/fill-gaps", "design", "design.skeleton"),
    ("PUT", r"/episodes/\d+/storyboards/order", "design", "design.skeleton"),
    ("POST", r"/agent/storyboard_breaker/chat", "design", "design.skeleton"),
    ("POST", r"/storyboards/\d+/design-card/.+", "design", "design.cards"),
    ("PUT", r"/storyboards/\d+/design-card", "design", "design.cards"),
    ("POST", r"/storyboards/\d+/combo", "design", "design.cards"),
    ("POST", r"/episodes/\d+/design-cards/fill", "design", "design.cards"),
    ("PUT", r"/storyboards/\d+/narration-fit", "design", "design.voice"),
    ("DELETE", r"/storyboards/\d+/narration-fit", "design", "design.voice"),
    ("POST", r"/storyboards/\d+/narration/(?:subtitle|voice|write)", "design", "design.voice"),
    ("POST", r"/episodes/\d+/generate-narration", "design", "design.voice"),
    ("POST", r"/episodes/\d+/narration/voice-batch(?:/retry-failed)?", "design", "design.voice"),
    ("POST", r"/episodes/\d+/extract", "assets", "assets.extract"),
    ("POST", r"/episodes/\d+/asset-review/run", "assets", "assets.review"),
    ("PUT", r"/asset-review/items/\d+", "assets", "assets.review"),
    ("POST", r"/asset-pipeline/.+", "assets", None),
    ("POST", r"/dramas/\d+/assets/.+", "assets", None),
    ("POST", r"/episodes/\d+/assets/.+", "assets", None),
    ("DELETE", r"/episodes/\d+/assets/link", "assets", None),
    ("POST", r"/props(?:/.+)?", "assets", None),
    ("PUT", r"/props/\d+(?:/.+)?", "assets", None),
    ("DELETE", r"/props/\d+", "assets", None),
    ("POST", r"/scenes(?:/.+)?", "assets", None),
    ("PUT", r"/scenes/\d+(?:/.+)?", "assets", None),
    ("DELETE", r"/scenes/\d+", "assets", None),
    ("POST", r"/characters(?:/.+)?", "assets", None),
    ("PUT", r"/characters/\d+(?:/.+)?", "assets", None),
    ("DELETE", r"/characters/\d+", "assets", None),
    ("POST", r"/map-studio/.+", "assets", None),
    ("PUT", r"/map-studio/.+", "assets", None),
    ("PUT", r"/episodes/\d+/poster/select", "poster", None),
    ("POST", r"/episodes/\d+/poster(?:/.+)?", "poster", None),
    ("PUT", r"/episodes/\d+/poster", "poster", None),
    ("POST", r"/layer-segments/storyboards/\d+/draft", "production", "production.layer"),
    ("POST", r"/layer-segments/storyboards/\d+/render", "production", "production.layer"),
    ("POST", r"/layer-segments/storyboards/\d+/base-check(?:/override)?", "production", "production.layer"),
    ("PUT", r"/layer-segments/storyboards/\d+", "production", "production.layer"),
    ("DELETE", r"/layer-segments/storyboards/\d+", "production", "production.layer"),
    ("POST", r"/episodes/\d+/generate-keyframe-prompts", "production", "production.keyframes"),
    ("POST", r"/episodes/\d+/keyframe-batch(?:/(?:retry-failed|cancel))?", "production", "production.keyframes"),
    ("POST", r"/storyboards/\d+/keyframes/\w+/generate", "production", "production.keyframes"),
    ("PUT", r"/storyboards/\d+/keyframes/\w+", "production", "production.keyframes"),
    ("POST", r"/storyboards/\d+/confirm-keyframes", "production", "production.keyframes"),
    ("POST", r"/agent/prompt_generator/chat", "production", None),
    ("POST", r"/episodes/\d+/generate-video-prompts", "production", None),
    ("POST", r"/episodes/\d+/video-batch(?:/(?:retry-failed|cancel))?", "final", None),
    ("POST", r"/storyboards/\d+/generate-video", "final", None),
    ("POST", r"/episodes/\d+/compose-batch(?:/retry-failed)?", "final", None),
    ("POST", r"/storyboards/\d+/compose", "final", None),
    ("POST", r"/merge/episodes/\d+/merge", "export", None),
    ("DELETE", r"/merge/episodes/\d+/merges/\d+", "export", None),
    ("POST", r"/storyboards", "design", "design.skeleton"),
    ("DELETE", r"/storyboards/\d+", "design", "design.skeleton"),
)


class GuardError(Exception):
    pass


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_iso(v: str | None) -> float:
    if not v:
        return 0.0
    return datetime.fromisoformat(v.replace("Z", "+00:00")).timestamp()


def sha(value) -> str:
    if not isinstance(value, (str, bytes)):
        value = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if isinstance(value, str):
        value = value.encode()
    return hashlib.sha256(value).hexdigest()[:16]


def file_sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def as_dict(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return {}
    return v or {}


def norm_text(t: str) -> str:
    t = re.sub(r"【[^】]*】", "", t or "")
    return re.sub(r"\s+", "", t)


# ---------------------------------------------------------------- project ---

class Project:
    def __init__(self, root: Path):
        self.root = root
        self.dir = root / WF_DIR
        self.config_path = self.dir / "workflow.json"
        self.config = json.loads(self.config_path.read_text())
        self.profile = json.loads((PROFILE_DIR / f"{self.config['profile']}.json").read_text())
        self.e = int(self.config["episode_id"])
        self.d = int(self.config["drama_id"])

    @staticmethod
    def find(start: str | None) -> "Project":
        p = Path(start or os.getcwd()).resolve()
        for cand in [p, *p.parents]:
            if (cand / WF_DIR / "workflow.json").is_file():
                return Project(cand)
        raise SystemExit(f"hbwf: no {WF_DIR}/workflow.json found from {p}; run `hbwf init` in the production project directory")

    @contextmanager
    def lock(self):
        self.dir.mkdir(exist_ok=True)
        with (self.dir / ".lock").open("w") as f:
            fcntl.flock(f, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(f, fcntl.LOCK_UN)

    def append(self, name: str, record: dict) -> None:
        with (self.dir / name).open("a") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def read_jsonl(self, name: str) -> list[dict]:
        p = self.dir / name
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines() if line.strip()]

    def request(self, method: str, path: str, body=None, timeout: int = 180):
        url = self.config["api_base"].rstrip("/") + path
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, ctype, raw = r.status, r.headers.get("Content-Type", ""), r.read()
        except urllib.error.HTTPError as e:
            status, ctype, raw = e.code, e.headers.get("Content-Type", ""), e.read()
        if "json" not in ctype:
            return status, ctype, {"non_json": raw[:300].decode("utf-8", "replace")}
        return status, ctype, json.loads(raw)

    def get(self, path: str):
        status, ctype, obj = self.request("GET", path)
        if status != 200 or "json" not in ctype:
            raise SystemExit(f"hbwf: GET {path} -> {status} {ctype}: {str(obj)[:300]} (derivation aborted; nothing written)")
        return obj.get("data")

    def get_optional(self, path: str) -> tuple[object | None, str | None]:
        """GET that degrades to (None, error) instead of aborting derivation."""
        status, ctype, obj = self.request("GET", path)
        if status == 200 and "json" in ctype:
            return obj.get("data"), None
        return None, f"GET {path} -> {status} {ctype}: {str(obj)[:200]}"

    def preview(self, path: str, body: dict):
        status, ctype, obj = self.request("POST", path, body)
        if status != 200 or "json" not in ctype:
            raise SystemExit(f"hbwf: preview {path} -> {status} {ctype}: {str(obj)[:300]} (derivation aborted; nothing written)")
        return obj.get("data") or {}

    def canonical_ids(self) -> list[int] | None:
        f = self.config.get("canonical_ids_file")
        if not f:
            return None
        p = Path(f) if os.path.isabs(f) else self.root / f
        if not p.exists():
            return None
        v = json.loads(p.read_text())
        if isinstance(v, dict):
            v = v.get("storyboard_ids") or v.get("ids")
        return [int(x) for x in v]


# ------------------------------------------------------------- derivation ---

def timeline_check(prompt: str, duration: float, mid_time) -> dict:
    """Source rule: references/api-production.md — read back duration / mid_frame_time / last segment end."""
    segs = [(float(a), float(b)) for a, b in SEGMENT_RE.findall(prompt or "")]
    issues, warnings = [], []
    if mid_time not in (None, "") and not (0 < float(mid_time) < duration):
        issues.append(f"mid_frame_time {mid_time} outside (0,{duration})")
    if not segs:
        warnings.append("no timeline segments found")
        return {"segments": [], "issues": issues, "warnings": warnings}
    if abs(segs[0][0]) > 0.05:
        issues.append(f"first segment starts at {segs[0][0]}s")
    for (_, b1), (a2, _) in zip(segs, segs[1:]):
        if abs(b1 - a2) > 0.05:
            issues.append(f"gap/overlap at {b1}->{a2}s")
    end = max(b for _, b in segs)
    if end > duration + 0.05:
        issues.append(f"timeline ends {end}s > duration {duration}s")
    elif end < duration - 1.0:
        issues.append(f"timeline ends {end}s, {duration - end:.1f}s short of duration {duration}s")
    return {"segments": segs, "issues": issues, "warnings": warnings}


def decision_index(decisions: list[dict]) -> dict:
    idx: dict = {}
    for d in decisions:
        for key in d.get("bound", {}):
            idx[(d["kind"], str(key))] = d
    return idx


def approval_state(idx, kind, key, current_hash) -> str:
    d = idx.get((kind, str(key)))
    if not d:
        return "missing"
    return "valid" if d["bound"][str(key)] == current_hash else "stale"


def pending_targets(prj: Project) -> dict:
    """Shots targeted by prepared calls without an outcome (in flight or unknown)."""
    open_: dict = {}
    for row in prj.read_jsonl("ledger.jsonl"):
        if row.get("phase") == "prepared":
            open_[row["call_id"]] = row
        elif row.get("phase") == "outcome" and row.get("result") != "unknown":
            open_.pop(row.get("call_id"), None)
    reconciled = {cid for d in prj.read_jsonl("decisions.jsonl") if d["kind"] == "reconcile" for cid in d.get("call_ids", [])}
    out: dict = {}
    for cid, row in open_.items():
        if cid in reconciled:
            continue
        for sid in row.get("target_ids") or []:
            out.setdefault(int(sid), []).append(cid)
    return out


def ledger_attribution(prj: Project):
    """Batch ids and submit windows of ledger-recorded submissions, for reconciliation."""
    batch_ids, windows, unknown_calls = set(), [], []
    prepared = {}
    for row in prj.read_jsonl("ledger.jsonl"):
        if row.get("phase") == "init":
            batch_ids |= {int(x) for x in row.get("adopted_batches", [])}
        if row.get("phase") == "prepared":
            prepared[row["call_id"]] = row
        if row.get("phase") != "outcome":
            continue
        p = prepared.get(row["call_id"], {})
        start = parse_iso(p.get("at")) - 2
        end = parse_iso(row.get("at")) + 5
        windows.append((start, end, row["call_id"]))
        if row.get("result") == "unknown":
            unknown_calls.append(row["call_id"])
        data = (row.get("response") or {}).get("data") if isinstance(row.get("response"), dict) else None
        if isinstance(data, dict) and data.get("id") is not None and p.get("path", "").endswith(("-batch", "/video-batch", "/keyframe-batch")):
            batch_ids.add(int(data["id"]))
    return batch_ids, windows, unknown_calls


def reconcile(prj: Project, vbatch: dict, kbatch: dict) -> dict:
    init_ts = parse_iso(prj.config.get("created_at"))
    batch_ids, windows, unknown_calls = ledger_attribution(prj)
    rows, page = [], 1
    while True:
        data = prj.get(f"/tasks/center?episode_id={prj.e}&page={page}&page_size=200") or {}
        items = data.get("items") or []
        rows += items
        if len(rows) >= int(data.get("total") or 0) or not items:
            break
        page += 1
    attr_path = prj.dir / "attribution.json"
    attr = json.loads(attr_path.read_text()) if attr_path.exists() else {"child_tasks": []}
    child_tasks = set(attr["child_tasks"])
    for b in (vbatch, kbatch):
        if b and b.get("id") in batch_ids:
            child_tasks |= {int(x["task_id"]) for x in b.get("items", []) if x.get("task_id")}
    attr_path.write_text(json.dumps({"child_tasks": sorted(child_tasks), "batches": sorted(batch_ids)}))
    acknowledged = {str(x) for d in prj.read_jsonl("decisions.jsonl") if d["kind"] == "reconcile" for x in d.get("task_ids", [])}
    orphans = []
    for t in rows:
        created = parse_iso(t.get("created_at"))
        if created < init_ts or t.get("episode_id") not in (prj.e, None):
            continue
        key = f"{'batch' if t.get('type') is None else 'task'}:{t.get('id')}"
        if key in acknowledged:
            continue
        if t.get("type") is None and t.get("id") in batch_ids:
            continue
        if t.get("id") in child_tasks:
            continue
        if any(s <= created <= e for s, e, _ in windows):
            continue
        orphans.append({"key": key, "kind": t.get("kind"), "status": t.get("status"), "created_at": t.get("created_at")})
    return {"orphans": orphans, "unknown_calls": unknown_calls, "rows_checked": len(rows)}


def poster_policy_for(project_type: str | None, required_flag: bool) -> str:
    """纪录片 Poster 必做（#101）：documentary 一律 required，不看 workflow.json 的开关。
    项目类型读不到时 fail-closed 按 required 处理，不默认放行。"""
    if project_type != "drama" or required_flag:
        return "required"
    return "decision_required"


def poster_waiver_refusal(project_type: str | None) -> str | None:
    if project_type == "documentary":
        return "poster_waiver is not allowed for documentary projects: the Poster is a mandatory step and must be produced (#101)"
    if project_type != "drama":
        return f"poster_waiver refused: project_type={project_type!r} could not be confirmed as drama (#101, fail-closed)"
    return None


# ---------------------------------------------------------------- roadmap ---

def walk_roadmap(roadmap: dict | None):
    for n in (roadmap or {}).get("steps") or []:
        yield n
        yield from n.get("substeps") or []


def roadmap_node(roadmap: dict | None, key: str) -> dict | None:
    return next((n for n in walk_roadmap(roadmap) if n.get("key") == key), None)


def roadmap_statuses(roadmap: dict | None) -> dict:
    return {n["key"]: n.get("status") for n in walk_roadmap(roadmap)}


def roadmap_snapshot(roadmap: dict | None) -> dict:
    if not roadmap:
        return {"available": False}
    return {"available": True, "current": roadmap.get("current"), "statuses": roadmap_statuses(roadmap),
            "milestones": {m.get("key"): m.get("status") for m in roadmap.get("milestones") or []}}


def roadmap_step_key(roadmap: dict | None, step: str) -> str:
    """Documentary step keys are the workflow's own; drama roadmap has different keys (informational)."""
    if roadmap and roadmap.get("project_type") != "documentary":
        return DRAMA_STEP_OF.get(step, step)
    return step


def _earliest_step(cands: list[tuple[str, str | None]]) -> tuple[str, str | None] | None:
    return min(cands, key=lambda c: DOC_STEPS.index(c[0])) if cands else None


def write_step_of(method: str, path: str, body: dict) -> tuple[str, str | None] | None:
    """Roadmap step (documentary key) that owns this write endpoint, or None when unmapped."""
    keys = set(body or {})
    if method == "PUT" and re.fullmatch(r"/episodes/\d+", path):
        cands = []
        if "content" in keys:
            cands.append(("raw", None))
        if "script_content" in keys:
            cands.append(("rewrite", "rewrite.final"))
        if keys & EPISODE_VOICE_KEYS:
            cands.append(("design", "design.voice"))
        return _earliest_step(cands)
    if method == "PUT" and re.fullmatch(r"/storyboards/\d+", path):
        if "narration_text" in keys:
            return "design", "design.voice"
        if keys and keys <= set(PROMPT_FIELDS) | {"duration", "mid_frame_time"}:
            return "production", None
        return "design", None
    for meth, pattern, step, substep in WRITE_STEPS:
        if method == meth and re.fullmatch(pattern, path):
            return step, substep
    return None


def roadmap_gate_errors(roadmap: dict | None, step: str, substep: str | None, e: int) -> list[str]:
    """Reject writes to a step while an earlier strict step is not done/skipped (documentary only)."""
    if roadmap is None:
        return ["roadmap unavailable: step order cannot be proven (fail-closed; "
                f"GET /episodes/{e}/roadmap failed)"]
    if not roadmap.get("strict"):
        return []
    steps = roadmap.get("steps") or []
    idx = next((i for i, n in enumerate(steps) if n.get("key") == step), None)
    if idx is None:
        return [f"roadmap has no step {step!r} (project_type={roadmap.get('project_type')})"]
    target = steps[idx]
    blockers = [f"{n['key']}({n.get('status')})" for n in steps[:idx]
                if n.get("ordering") == "strict" and n.get("status") not in DONE_STATUSES]
    if step == "export":
        blockers += [f"{n['key']}({n.get('status')},required_before=export)" for n in steps
                     if n.get("required_before") == "export" and n.get("status") not in DONE_STATUSES]
    if target.get("unlocked") is False:
        blockers.append(f"{step} locked: {target.get('lock_reason') or 'gate closed'}")
    if substep:
        subs = target.get("substeps") or []
        sidx = next((i for i, s in enumerate(subs) if s.get("key") == substep), None)
        if sidx is None:
            blockers.append(f"no substep {substep} under {step}")
        else:
            blockers += [f"{s['key']}({s.get('status')})" for s in subs[:sidx]
                         if s.get("ordering") == "strict" and s.get("status") not in DONE_STATUSES]
    if not blockers:
        return []
    name = f"{step}.{substep}" if substep and not substep.startswith(f"{step}.") else (substep or step)
    return [f"roadmap blocked: {name} needs every earlier strict step done; blocked_by={blockers} "
            f"(see GET /episodes/{e}/roadmap missing/goto)"]


def roadmap_problems(roadmap: dict | None, require_export: bool = False) -> list[str]:
    """Completion problems for the final gate. `require_export` = post-export verification (M3)."""
    if roadmap is None:
        return ["roadmap unavailable: GET /episodes/{e}/roadmap failed; step completion cannot be proven (fail-closed)"]
    # A stale export step is what the merge is about to fix; only the post-export check may flag it.
    probs = [f"roadmap stale: {n['key']} {n.get('label') or ''} needs reverification"
             for n in walk_roadmap(roadmap)
             if n.get("status") == "stale" and (require_export or n.get("key") != "export")]
    steps = roadmap.get("steps") or []
    if roadmap.get("strict"):
        pending = [f"{n['key']}({n.get('status')})" for n in steps
                   if n.get("key") != "export" and n.get("status") not in DONE_STATUSES]
        if pending:
            probs.append(f"roadmap: steps unfinished before export: {pending}")
    if require_export:
        export = next((n for n in steps if n.get("key") == "export"), None)
        if export is None:
            probs.append("roadmap has no export step")
        elif export.get("status") != "done":
            probs.append(f"roadmap export step is {export.get('status')}: the merged film does not match the current shots/poster")
        m3 = next((m for m in roadmap.get("milestones") or [] if m.get("key") == "m3_export"), None)
        probs.append(f"roadmap milestone m3_export is {m3.get('status') if m3 else 'missing'} (export not verified)")
    return probs


def roadmap_next_action(roadmap: dict | None, action: str) -> str | None:
    """Documentary: pending human confirmations replace the per-shot next (hbwf only reports them)."""
    if not roadmap or roadmap.get("project_type") != "documentary":
        return None
    for key, replacement in HUMAN_CONFIRM_SUBSTEPS:
        node = roadmap_node(roadmap, key)
        if node is None or node.get("status") in DONE_STATUSES:
            continue
        if key == "design.skeleton" or action in DESIGN_GATED_ACTIONS:
            return replacement
        return None
    return None


def derive(prj: Project, write: bool = True) -> dict:
    e = prj.e
    problems: list[str] = []
    drama = prj.get(f"/dramas/{prj.d}")
    episode = next((x for x in drama.get("episodes", []) if x["id"] == e), None)
    if episode is None:
        raise SystemExit(f"hbwf: episode {e} not found in drama {prj.d}")
    applies = prj.profile.get("applies", {})
    if applies.get("project_type") and drama.get("project_type") != applies["project_type"]:
        problems.append(f"profile {prj.config['profile']} applies to project_type={applies['project_type']}, drama is {drama.get('project_type')}")
    roadmap, road_err = prj.get_optional(f"/episodes/{e}/roadmap")
    if road_err:
        problems.append(f"roadmap unavailable: {road_err}")
    m = prj.config["models"]
    for kind, field in (("image", "image_config_id"), ("video", "video_config_id"), ("tts", "tts_config_id")):
        if episode.get(field) is not None and int(episode[field]) != int(m[kind]["config_id"]):
            problems.append(f"episode {field}={episode[field]} differs from fixed {kind} config {m[kind]['config_id']}")
    init = next((r for r in prj.read_jsonl("ledger.jsonl") if r.get("phase") == "init"), None)
    if init and init.get("config_sha") != file_sha(prj.config_path):
        problems.append("workflow.json changed after init (tampering or unrecorded edit)")

    sbd = prj.get(f"/episodes/{e}/storyboards")
    shots = sbd if isinstance(sbd, list) else sbd["items"]
    ids = [s["id"] for s in shots]
    # 拆镜之前（原始内容 / 改写 / 资产阶段）没有分镜：逐镜预览接口对空集合 400，
    # 这时不调用预览，只靠 roadmap 判断步骤——前期步骤同样必须能 check / call（#105）
    if ids:
        kprev = prj.preview(f"/episodes/{e}/keyframe-batch/preview", {"storyboard_ids": ids, "config_id": m["image"]["config_id"], "model": m["image"]["model"]})
        vprev = prj.preview(f"/episodes/{e}/video-batch/preview", {"storyboard_ids": ids, "config_id": m["video"]["config_id"], "model": m["video"]["model"]})
        cprev = prj.preview(f"/episodes/{e}/compose-batch/preview", {"storyboard_ids": ids})
    else:
        kprev, vprev, cprev = {}, {}, {}
    vbatch = prj.get(f"/episodes/{e}/video-batch") or {}
    kbatch = prj.get(f"/episodes/{e}/keyframe-batch") or {}
    cstatus = prj.get(f"/episodes/{e}/compose-batch-status") or {}
    voice = prj.get(f"/episodes/{e}/narration/voice-batch-status") or {}
    vps = prj.get(f"/episodes/{e}/video-prompts-status") or {}
    kps = prj.get(f"/episodes/{e}/keyframe-prompts-status") or {}
    poster = prj.get(f"/episodes/{e}/poster") or {}
    active = prj.get("/tasks/active") or {}
    active_items = active if isinstance(active, list) else active.get("items", [])
    ep_tasks = [{"id": t.get("id"), "type": t.get("type"), "status": t.get("status"), "kind": (t.get("params") or {}).get("kind")}
                for t in active_items if t.get("episode_id") == e]

    def running(b):
        return (b or {}).get("status") in RUNNING

    vqueue = {x["storyboard_id"]: x.get("state") for x in vbatch.get("items", []) if running(vbatch) and x.get("state") in RUNNING}
    kqueue: dict = {}
    if running(kbatch):
        for x in kbatch.get("items", []):
            if x.get("state") in RUNNING:
                kqueue.setdefault(x["storyboard_id"], []).append(x.get("slot"))
    kslot = {(x["storyboard_id"], x["slot"]): x.get("status") for x in kprev.get("items", [])}
    vstat = {x["storyboard_id"]: x for x in vprev.get("items", [])}
    cstat = {x["storyboard_id"]: x for x in cprev.get("items", [])}
    idx = decision_index(prj.read_jsonl("decisions.jsonl"))
    frozen = pending_targets(prj)

    out = []
    for s in shots:
        sid = s["id"]
        # #110: documentary shots submit only the generated segment; storyboards.duration is 0 there.
        # GET /episodes/{e}/storyboards now exposes generated_segment_s (budget.gen_s); fall back to duration.
        dur = float(s.get("generated_segment_s") or s.get("duration") or 0)
        kf = s.get("keyframes") or {}
        meta = as_dict(s.get("narration_meta"))
        audio = meta.get("audio") or {}
        blocks = sorted({i.get("code") for i in (s.get("ref_issues") or []) if i.get("severity") == "block"})
        fit = as_dict(s.get("narration_fit"))
        fit_eff = as_dict(s.get("narration_fit_effective"))
        tempo = max(float(fit.get("tempo_override") or 1), float(fit_eff.get("tempo_override") or 1))
        narration_ok = bool(s.get("narration_audio_url")) and s.get("narration_status") in ("voiced", "composed", "compose_stale") \
            and audio.get("text_sha256") == meta.get("text_sha256") and not {"narration_too_long", "narration_voice_stale"} & set(blocks)
        required = [sl for sl in SLOTS if (sl != "first" or not kf.get("inherits_first"))
                    and (sl != "mid" or kf.get("mid_required") or (s.get("mid_frame_prompt") or "").strip())]
        kf_problems = [f"{sl}_frame_prompt empty" for sl in required if not (s.get(f"{sl}_frame_prompt") or "").strip()]
        if "mid" in required and not (0 < float(s.get("mid_frame_time") or 0) < dur):
            kf_problems.append(f"mid_frame_time {s.get('mid_frame_time')} outside (0,{dur})")
        kf_problems += [f"ref_issue:{b}" for b in blocks if b not in ("narration_too_long", "narration_voice_stale", "empty_video_prompt")]
        tl = timeline_check(s.get("video_prompt") or "", dur, s.get("mid_frame_time") if "mid" in required else None)
        vp_problems = (["video_prompt empty"] if not (s.get("video_prompt") or "").strip() else []) + tl["issues"]
        saved = s.get("field_saved_at") or {}
        v = vstat.get(sid) or {}
        c = cstat.get(sid) or {}
        cplan = c.get("plan") or {}
        image_hash = sha([s.get(f"{sl}_frame_image") for sl in SLOTS] + [s.get(f"{sl}_frame_prompt") for sl in SLOTS])
        vp_hash = sha([s.get("video_prompt"), dur, s.get("mid_frame_time")])
        rec = {
            "id": sid,
            "number": s.get("storyboard_number"),
            "duration": dur,
            "narration": {"ok": narration_ok, "status": s.get("narration_status"), "tempo": tempo,
                          "duration_ms": audio.get("duration_ms"), "text": s.get("narration_text") or ""},
            "subtitle_ok": bool(s.get("subtitle_url")),
            "kf_prompts": {"ok": not kf_problems, "problems": kf_problems, "required_slots": required,
                           "saved_at": max(int(saved.get(f) or 0) for f in KF_PROMPT_FIELDS)},
            "video_prompt": {"ok": not vp_problems, "problems": vp_problems, "warnings": tl["warnings"], "hash": vp_hash,
                             "saved_at": int(saved.get("video_prompt") or 0)},
            "keyframes": {"slots": {sl: kslot.get((sid, sl), "n/a") for sl in required}, "ready": bool(kf.get("ready")),
                          "confirmed": bool(kf.get("confirmed")), "image_hash": image_hash, "queued_slots": kqueue.get(sid, [])},
            "video": {"url": s.get("video_url"), "preview": v.get("status"), "preview_reason": v.get("reason"), "queued": vqueue.get(sid)},
            "compose": {"url": s.get("composed_video_url"), "preview": c.get("status"), "exportable": bool(c.get("exportable")),
                        "blocked": bool(cplan.get("blocked")), "reason": c.get("reason")},
            "frozen_by_calls": frozen.get(sid, []),
            "approvals": {
                "keyframe_approval": approval_state(idx, "keyframe_approval", sid, image_hash),
                "video_prompt_review": approval_state(idx, "video_prompt_review", sid, vp_hash),
                "video_approval": approval_state(idx, "video_approval", sid, sha(s.get("video_url") or "")),
                "compose_approval": approval_state(idx, "compose_approval", sid, sha(s.get("composed_video_url") or "")),
            },
        }
        rec["next"] = next_action(rec)
        human = roadmap_next_action(roadmap, rec["next"])
        if human:
            rec["next"] = human
        out.append(rec)

    canon = prj.canonical_ids()
    if canon is None:
        problems.append("canonical_ids_file missing")
    else:
        if len(canon) != len(set(canon)):
            problems.append("duplicate ids in canonical order")
        if set(canon) != set(ids):
            problems.append(f"canonical set differs: missing {sorted(set(ids) - set(canon))}, extra {sorted(set(canon) - set(ids))}")
        else:
            by_id = {r["id"]: r for r in out}
            if norm_text("".join(by_id[i]["narration"]["text"] for i in canon)) != norm_text(episode.get("script_content") or ""):
                problems.append("narration concatenated in canonical order differs from script_content (coverage/order broken)")
    order = {sid: i for i, sid in enumerate(canon or [])}
    out.sort(key=lambda r: (order.get(r["id"], 10 ** 6), r["number"] or 0, r["id"]))
    for r in out:
        r["narration"].pop("text")

    selected = poster.get("selected_version_id")
    sel = next((v for v in poster.get("versions") or [] if v.get("id") == selected), None) or {}
    poster_hash = sha([selected, sel.get("image_url") or sel.get("path") or sel.get("image") or poster.get("final_image")])
    waiver = [d for d in prj.read_jsonl("decisions.jsonl") if d["kind"] == "poster_waiver"]
    state = {
        "derived_at": now_iso(),
        "hbwf_sha": file_sha(Path(__file__))[:16],
        "drama_id": prj.d, "episode_id": e,
        "profile": prj.config["profile"],
        "poster_policy": poster_policy_for(drama.get("project_type"), bool(prj.config.get("required_poster"))),
        "problems": problems,
        "canonical_ids": canon,
        "batches": {
            "video": {"id": vbatch.get("id"), "status": vbatch.get("status")},
            "keyframe": {"id": kbatch.get("id"), "status": kbatch.get("status")},
            "compose": {"status": cstatus.get("status")},
            "voice": {"status": voice.get("status")},
            "video_prompts": {"status": vps.get("status")},
            "keyframe_prompts": {"status": kps.get("status")},
        },
        "active_tasks": ep_tasks,
        "poster": {"selected_version_id": selected, "versions": len(poster.get("versions") or []), "hash": poster_hash,
                   "approval": approval_state(idx, "poster_approval", "poster", poster_hash) if selected else "missing",
                   "waiver": [d["id"] for d in waiver]},
        "reconcile": reconcile(prj, vbatch, kbatch),
        "roadmap": roadmap,
        "shots": out,
    }
    state["final_gate"] = final_gate_problems(state, None)
    if write:
        (prj.dir / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=1))
    return state


def next_action(r: dict) -> str:
    if not r["narration"]["ok"]:
        return "fix_narration"
    if r["narration"]["tempo"] > 1:
        return "remove_acceleration"
    if not r["subtitle_ok"]:
        return "make_subtitle"
    if r["frozen_by_calls"]:
        return "wait_call"
    if not r["kf_prompts"]["ok"]:
        return "write_keyframe_prompts"
    k = r["keyframes"]
    if k["queued_slots"]:
        return "wait_keyframes"
    if any(st in NEEDS_GEN for st in k["slots"].values()):
        return "generate_keyframes"
    if r["approvals"]["keyframe_approval"] != "valid":
        return "review_keyframes"
    if not k["confirmed"]:
        return "confirm_keyframes"
    v = r["video"]
    if v["queued"]:
        return "wait_video"
    if v["preview"] in NEEDS_GEN or not v["url"]:
        if not r["video_prompt"]["ok"]:
            return "write_video_prompt"
        if r["approvals"]["video_prompt_review"] != "valid":
            return "review_video_prompt"
        return "generate_video"
    if r["approvals"]["video_approval"] != "valid":
        return "review_video"
    c = r["compose"]
    if c["preview"] != "unchanged" or not c["exportable"]:
        return "compose"
    if r["approvals"]["compose_approval"] != "valid":
        return "review_compose"
    return "done"


def final_gate_problems(state: dict, merge_body: dict | None) -> list[str]:
    p = list(state["problems"])
    for r in state["shots"]:
        if r["next"] != "done":
            p.append(f"shot {r['id']}: next={r['next']}")
    po = state["poster"]
    if not po["selected_version_id"]:
        if state["poster_policy"] == "required" or not po["waiver"]:
            p.append("poster: no approved selected version" + ("" if state["poster_policy"] == "required" else " and no poster_waiver decision"))
    elif po["approval"] != "valid":
        p.append(f"poster approval {po['approval']}")
    busy = {k: v["status"] for k, v in state["batches"].items() if v.get("status") in RUNNING}
    if busy:
        p.append(f"batches running: {busy}")
    if state["active_tasks"]:
        p.append(f"active tasks for episode: {[t['id'] for t in state['active_tasks']]}")
    rec = state["reconcile"]
    if rec["orphans"]:
        p.append(f"unledgered server writes (orphans): {[o['key'] for o in rec['orphans']]}")
    if rec["unknown_calls"]:
        p.append(f"calls with unknown outcome not reconciled: {rec['unknown_calls']}")
    if merge_body is not None:
        if [int(x) for x in merge_body.get("storyboard_ids") or []] != (state["canonical_ids"] or []):
            p.append("merge storyboard_ids must equal the canonical order exactly")
        if po["selected_version_id"] and merge_body.get("poster_version_id") != po["selected_version_id"]:
            p.append("merge poster_version_id must equal the approved selected poster version")
    p += [x for x in roadmap_problems(state.get("roadmap")) if x not in p]
    return p


# ------------------------------------------------------------------ guard ---

def scoped_decisions(decisions: list[dict], kind: str, sid=None, method=None, path=None, after_ts: int = 0) -> list[dict]:
    out = []
    for d in decisions:
        if d["kind"] != kind or int(d.get("ts", 0)) <= after_ts:
            continue
        if sid is not None and int(sid) not in [int(x) for x in d.get("ids", [])]:
            continue
        if method and d.get("method") and d["method"] != method:
            continue
        if path and d.get("path_regex") and not re.fullmatch(d["path_regex"], path):
            continue
        out.append(d)
    return out


def used_exception_ids(ledger: list[dict]) -> set:
    return {row.get("exception_id") for row in ledger if row.get("phase") == "prepared" and row.get("exception_id")}


def ids_from(body: dict, key="storyboard_ids") -> list[int]:
    v = body.get(key)
    if not isinstance(v, list) or not v:
        raise GuardError(f"`{key}` must be a non-empty explicit list (empty/omitted means the server's whole-episode default scope)")
    return [int(x) for x in v]


def check_model(models: dict, body: dict, kind: str, errors: list):
    m = models[kind]
    if body.get("config_id") is not None and int(body["config_id"]) != int(m["config_id"]):
        errors.append(f"{kind} config_id must be {m['config_id']} (models are fixed by workflow.json)")
    if m.get("model") and body.get("model") is not None and body["model"] != m["model"]:
        errors.append(f"{kind} model must be {m['model']}")


def prompt_write_allowed(decisions, r, scope: str, errors: list):
    sid = r["id"]
    if r["video"]["queued"] or r["keyframes"]["queued_slots"] or r["frozen_by_calls"]:
        errors.append(f"{sid}: inputs are frozen (queued in a running batch or targeted by an unfinished call)")
        return
    kf_need, vp_need = not r["kf_prompts"]["ok"], not r["video_prompt"]["ok"]
    need = kf_need if scope == "keyframe_prompts" else vp_need if scope == "video_prompt" else (kf_need or vp_need)
    if need:
        return
    saved = {"keyframe_prompts": r["kf_prompts"]["saved_at"], "video_prompt": r["video_prompt"]["saved_at"]}.get(
        scope, max(r["kf_prompts"]["saved_at"], r["video_prompt"]["saved_at"]))
    ok = [d for d in scoped_decisions(decisions, "rework", sid, after_ts=saved)
          if scope in d.get("scope", []) or "all_prompts" in d.get("scope", [])]
    if not ok:
        errors.append(f"{sid}: {scope} already complete and valid; a rewrite needs a `rework` decision recorded after its last save")


def guard(ctx: dict, method: str, path: str, body: dict, declared_ids: list[int] | None, state: dict) -> tuple[list[str], list[str], str | None]:
    """Pure policy function. ctx = {episode_id, models, decisions, ledger, voice_preview(callable|None)}."""
    e = ctx["episode_id"]
    decisions, ledger = ctx["decisions"], ctx["ledger"]
    errors: list[str] = []
    warnings: list[str] = []
    sm = {r["id"]: r for r in state["shots"]}
    b = state["batches"]
    ep = f"/episodes/{e}"
    exception_id = None

    def shot(sid):
        if sid not in sm:
            raise GuardError(f"storyboard {sid} is not in episode {e}")
        return sm[sid]

    def take_exception():
        used = used_exception_ids(ledger)
        for d in scoped_decisions(decisions, "exception", method=method, path=path):
            if d["id"] not in used:
                return d["id"]
        return None

    if method == "GET" or (method == "POST" and path.endswith("/preview")):
        return errors, warnings, None
    if state["problems"]:
        warnings += [f"state problem: {p}" for p in state["problems"]]
    target = write_step_of(method, path, body)
    if target:
        step, substep = target
        errors += roadmap_gate_errors(state.get("roadmap"), roadmap_step_key(state.get("roadmap"), step), substep, e)

    m = re.fullmatch(r"/storyboards/(\d+)(/.*)?", path)
    sid_in_path = int(m.group(1)) if m else None
    tail = (m.group(2) or "") if m else None

    if path == f"{ep}/generate-keyframe-prompts" and method == "POST":
        ids = ids_from(body)
        check_model(ctx["models"], body, "text", errors)
        if b["keyframe_prompts"]["status"] in RUNNING:
            errors.append("a keyframe prompt generation task is already running")
        for sid in ids:
            prompt_write_allowed(decisions, shot(sid), "keyframe_prompts", errors)
    elif path == f"{ep}/generate-video-prompts" and method == "POST":
        ids = ids_from(body)
        check_model(ctx["models"], body, "text", errors)
        if b["voice"]["status"] in RUNNING:
            errors.append("voice batch running; video prompts must not run concurrently with voicing")
        if b["video_prompts"]["status"] in RUNNING:
            errors.append("a video prompt generation task is already running")
        for sid in ids:
            r = shot(sid)
            if r["video_prompt"]["ok"] or "video_prompt empty" not in r["video_prompt"]["problems"]:
                errors.append(f"{sid}: generate-video-prompts force-rewrites and leaks transition review to other shots; "
                              "use it only for shots with an empty video prompt. Rewrite via scoped prompt_generator chat with --ids")
            if r["video"]["queued"] or r["frozen_by_calls"]:
                errors.append(f"{sid}: inputs are frozen")
        warnings.append("generate-video-prompts also runs transition review on shots outside storyboard_ids (services/video-prompts.ts:56-61)")
    elif path == "/agent/prompt_generator/chat" and method == "POST":
        if not declared_ids:
            errors.append("prompt_generator chat has no server-side scope; declare the target shots with --ids")
        check_model(ctx["models"], body, "text", errors)
        if int(body.get("episode_id") or 0) != e:
            errors.append(f"episode_id must be {e}")
        if "readStoryboardContext" not in (body.get("message") or ""):
            errors.append("message must forbid readStoryboardContext (whole-episode context overflows the model window)")
        for sid in declared_ids or []:
            prompt_write_allowed(decisions, shot(sid), "all_prompts", errors)
    elif (method == "POST" and path in ("/agent/storyboard_breaker/chat", "/storyboards")) or (sid_in_path and not tail and method == "DELETE"):
        targets = declared_ids or ([sid_in_path] if sid_in_path else [])
        has = scoped_decisions(decisions, "structural_change", method=method, path=path) if not targets else \
            [d for d in decisions if d["kind"] == "structural_change" and all(int(t) in [int(x) for x in d.get("ids", [])] for t in targets)]
        if not has:
            errors.append("structural change (breaker / create / delete storyboards) needs a `structural_change` decision covering the targets")
    elif sid_in_path and not tail and method == "PUT":
        r = shot(sid_in_path)
        keys = set(body)
        if "narration_text" in keys and not scoped_decisions(decisions, "structural_change", sid_in_path):
            errors.append(f"{sid_in_path}: changing narration_text needs a `structural_change` decision")
        pk = keys & set(PROMPT_FIELDS)
        if pk:
            prompt_write_allowed(decisions, r, "video_prompt" if pk == {"video_prompt"} else "keyframe_prompts" if "video_prompt" not in pk else "all_prompts", errors)
        elif r["video"]["queued"] or r["keyframes"]["queued_slots"]:
            errors.append(f"{sid_in_path}: queued in a running batch; inputs are frozen")
        other = keys - set(PROMPT_FIELDS) - {"narration_text"}
        if other:
            exception_id = take_exception()
            if not exception_id:
                errors.append(f"{sid_in_path}: fields {sorted(other)} are not workflow-managed; needs an unused `exception` decision for {method} {path}")
    elif sid_in_path and tail == "/narration-fit" and method == "PUT":
        if float(body.get("tempo_override") or 1) > 1 or body.get("mode") == "tempo":
            errors.append("acceleration is forbidden: narration-fit must be pad with tempo_override<=1")
    elif sid_in_path and tail == "/narration-fit" and method == "DELETE":
        pass
    elif sid_in_path and tail == "/narration/subtitle" and method == "POST":
        if not shot(sid_in_path)["narration"]["ok"]:
            errors.append(f"{sid_in_path}: narration not voiced/current")
    elif path == f"{ep}/narration/voice-batch" and method == "POST":
        ids = ids_from(body)
        if b["video_prompts"]["status"] in RUNNING:
            errors.append("video prompt generation running; voice batch must not run concurrently")
        st = ctx["voice_preview"]({**body, "storyboard_ids": ids}) if ctx.get("voice_preview") else {}
        for sid in ids:
            shot(sid)
            if st.get(sid) not in NEEDS_GEN:
                errors.append(f"{sid}: voice preview is {st.get(sid)}; only missing/changed may be submitted")
    elif path == f"{ep}/keyframe-batch" and method == "POST":
        items = body.get("items")
        if not isinstance(items, list) or not items:
            raise GuardError("`items` must be a non-empty explicit list of {storyboard_id, slot}")
        check_model(ctx["models"], body, "image", errors)
        if b["keyframe"]["status"] in RUNNING:
            errors.append("a keyframe batch is already running for this episode (one per episode)")
        for it in items:
            sid, slot = int(it["storyboard_id"]), it["slot"]
            r = shot(sid)
            if not r["narration"]["ok"]:
                errors.append(f"{sid}: narration not voiced/current (keyframes come after measured audio)")
            if not r["kf_prompts"]["ok"]:
                errors.append(f"{sid}: keyframe prompts invalid {r['kf_prompts']['problems']}")
            if r["video"]["queued"] or r["frozen_by_calls"]:
                errors.append(f"{sid}: inputs frozen (queued video or unfinished call)")
            stv = r["keyframes"]["slots"].get(slot)
            if stv not in NEEDS_GEN:
                errors.append(f"{sid}/{slot}: preview is {stv}; only missing/changed slots may be generated")
    elif sid_in_path and tail == "/confirm-keyframes" and method == "POST":
        r = shot(sid_in_path)
        if body.get("confirmed") is False:
            exception_id = take_exception()
            if not exception_id:
                errors.append("unconfirming needs an unused `exception` decision")
        else:
            if r["approvals"]["keyframe_approval"] != "valid":
                errors.append(f"{sid_in_path}: keyframe_approval {r['approvals']['keyframe_approval']} (review current images first)")
            if not all(v == "unchanged" for v in r["keyframes"]["slots"].values()):
                errors.append(f"{sid_in_path}: slots not all unchanged {r['keyframes']['slots']}")
            if not r["keyframes"]["ready"]:
                errors.append(f"{sid_in_path}: keyframes not ready")
    elif (path == f"{ep}/video-batch" and method == "POST") or (sid_in_path and tail == "/generate-video" and method == "POST"):
        ids = ids_from(body) if sid_in_path is None else [sid_in_path]
        check_model(ctx["models"], body, "video", errors)
        if sid_in_path is None and b["video"]["status"] in RUNNING:
            errors.append("a video batch is already running (one per episode); wait, or use per-shot generate-video for shots outside it")
        for sid in ids:
            r = shot(sid)
            if not r["narration"]["ok"]:
                errors.append(f"{sid}: narration not current")
            if not (r["keyframes"]["confirmed"] and r["approvals"]["keyframe_approval"] == "valid"):
                errors.append(f"{sid}: keyframes not confirmed with a valid approval")
            if not r["video_prompt"]["ok"]:
                errors.append(f"{sid}: video prompt invalid {r['video_prompt']['problems']}")
            if r["approvals"]["video_prompt_review"] != "valid":
                errors.append(f"{sid}: video_prompt_review {r['approvals']['video_prompt_review']}")
            if r["video"]["queued"] or r["frozen_by_calls"]:
                errors.append(f"{sid}: already queued / frozen")
            if r["video"]["preview"] not in NEEDS_GEN:
                errors.append(f"{sid}: video preview is {r['video']['preview']}; only missing/changed may be generated")
    elif (path == f"{ep}/compose-batch" and method == "POST") or (sid_in_path and tail == "/compose" and method == "POST"):
        ids = ids_from(body) if sid_in_path is None else [sid_in_path]
        for sid in ids:
            r = shot(sid)
            if not (r["video"]["url"] and r["approvals"]["video_approval"] == "valid"):
                errors.append(f"{sid}: no reviewed video (video_approval {r['approvals']['video_approval']}); a shot without video is passively 'blocked', not composable")
            if not (r["narration"]["ok"] and r["subtitle_ok"]):
                errors.append(f"{sid}: narration/subtitle not ready")
            if r["narration"]["tempo"] > 1:
                errors.append(f"{sid}: accelerated narration")
            if r["compose"]["preview"] not in ("missing", "changed", "unknown") or r["compose"]["blocked"]:
                errors.append(f"{sid}: compose preview {r['compose']['preview']} blocked={r['compose']['blocked']}")
    elif method == "POST" and path in (f"{ep}/keyframe-batch/retry-failed", f"{ep}/video-batch/retry-failed",
                                        f"{ep}/compose-batch/retry-failed", f"{ep}/narration/voice-batch/retry-failed"):
        warnings.append("retry-failed resubmits only the failed remainder")
    elif path == f"{ep}/poster/select" and method == "PUT":
        vid = body.get("version_id")
        if not any(str(d.get("version_id")) == str(vid) for d in decisions if d["kind"] == "poster_approval"):
            errors.append(f"selecting poster version {vid} needs a poster_approval decision for that version")
    elif path.startswith(f"{ep}/poster") and method in ("POST", "PUT"):
        if body.get("config_id") is not None:
            check_model(ctx["models"], body, "image" if path.endswith("/generate") else "text", errors)
    elif path == f"/merge/episodes/{e}/merge" and method == "POST":
        errors += final_gate_problems(state, body)
    else:
        exception_id = take_exception()
        if not exception_id:
            errors.append(f"{method} {path} is not a workflow-managed write; it needs an unused `exception` decision for this exact call")
    return errors, warnings, exception_id


# --------------------------------------------------------------- commands ---

def gate_installed_ok() -> str | None:
    if os.environ.get("HBWF_SKIP_GATE_CHECK") == "1" and os.environ.get("HBWF_TEST") == "1":
        return None
    if not GATE_INSTALLED.is_file():
        return f"omp workflow gate not installed at {GATE_INSTALLED}; install it from {GATE_SOURCE} before any write"
    if file_sha(GATE_INSTALLED) != file_sha(GATE_SOURCE):
        return f"installed gate {GATE_INSTALLED} differs from skill copy {GATE_SOURCE}; reinstall"
    return None


def cmd_init(a):
    root = Path(a.project).resolve()
    wf = root / WF_DIR
    wf.mkdir(parents=True, exist_ok=True)
    target = wf / "workflow.json"
    if target.exists() and not a.force:
        raise SystemExit(f"{target} exists (use --force only with a recorded decision)")
    if not (PROFILE_DIR / f"{a.profile}.json").exists():
        raise SystemExit(f"unknown profile {a.profile}")
    cfg = {"version": 1, "api_base": a.api_base, "drama_id": a.drama, "episode_id": a.episode, "profile": a.profile,
           "required_poster": a.required_poster, "canonical_ids_file": a.canonical, "models": json.loads(a.models),
           "authorization": a.authorization, "created_at": a.created_at or now_iso()}
    target.write_text(json.dumps(cfg, ensure_ascii=False, indent=2))
    prj = Project(root)
    adopted = []
    for p in (f"/episodes/{prj.e}/video-batch", f"/episodes/{prj.e}/keyframe-batch"):
        b = prj.get(p) or {}
        if b.get("id") is not None and b.get("status") in RUNNING:
            adopted.append(int(b["id"]))
    with prj.lock():
        prj.append("ledger.jsonl", {"phase": "init", "at": now_iso(), "config_sha": file_sha(target), "config": cfg,
                                    "adopted_batches": adopted,
                                    "note": "batches already running at init are adopted: their child tasks are attributed, not orphans"})
    print(f"wrote {target}")


def _missing_text(m: dict) -> str:
    return f"{m.get('code')}: {m.get('message')}" + (f" x{m['count']}" if m.get("count") is not None else "")


def summarize_roadmap(roadmap: dict | None) -> list[str]:
    if not roadmap:
        return ["roadmap: unavailable (GET /episodes/{e}/roadmap failed; step completion cannot be verified)"]
    st = roadmap.get("status") or {}
    cur = roadmap.get("current") or {}
    prog = roadmap.get("progress") or {}
    current = f"{cur.get('step') or '-'}" + (f"/{cur['substep']}" if cur.get("substep") else "")
    lines = [f"roadmap: {roadmap.get('project_type')} strict={roadmap.get('strict')} status={st.get('effective')} "
             f"(derived={st.get('derived')} override={st.get('override')}) progress={prog.get('done')}/{prog.get('total')} current={current}"]
    lines.append("milestones: " + ", ".join(f"{m.get('key')}={m.get('status')}" for m in roadmap.get("milestones") or []))
    for n in roadmap.get("steps") or []:
        extra = []
        if n.get("unlocked") is False:
            extra.append(f"locked: {n.get('lock_reason') or 'gate closed'}")
        if n.get("counts"):
            extra.append(f"counts {n['counts'].get('done')}/{n['counts'].get('total')}")
        if n.get("required_before"):
            extra.append(f"required_before={n['required_before']}")
        lines.append(f"  {n.get('key', ''):11s} {n.get('status', ''):11s} {n.get('label') or ''}" + (f"  [{', '.join(extra)}]" if extra else ""))
        for node in [*(n.get("substeps") or []), n]:
            if node.get("missing"):
                lines.append(f"    {node['key']} missing: " + "; ".join(_missing_text(m) for m in node["missing"]))
            if node.get("blocked_by"):
                lines.append(f"    {node['key']} blocked_by: " + ", ".join(node["blocked_by"]))
        for x in n.get("notices") or []:
            lines.append(f"    notice {x.get('code')}: {x.get('message')}")
        subs = n.get("substeps") or []
        if subs:
            lines.append("    substeps: " + ", ".join(f"{s['key'].rsplit('.', 1)[-1]}={s.get('status')}" for s in subs))
    return lines


def summarize(state: dict) -> str:
    groups: dict = {}
    for r in state["shots"]:
        groups.setdefault(r["next"], []).append(r["id"])
    lines = [f"derived_at {state['derived_at']}  drama {state['drama_id']} episode {state['episode_id']}  profile {state['profile']}"]
    lines.append("batches: " + ", ".join(f"{k}={v.get('status')}" for k, v in state["batches"].items()))
    po = state["poster"]
    lines.append(f"poster: policy={state['poster_policy']} selected={po['selected_version_id']} versions={po['versions']} approval={po['approval']} waiver={po['waiver']}")
    lines += summarize_roadmap(state.get("roadmap"))
    rec = state["reconcile"]
    lines.append(f"reconcile: orphans={[o['key'] for o in rec['orphans']]} unknown_calls={rec['unknown_calls']}")
    for p in state["problems"]:
        lines.append(f"PROBLEM: {p}")
    order = ["await_skeleton_confirm", "await_design_card_confirm", "fix_narration", "remove_acceleration", "make_subtitle",
             "wait_call", "write_keyframe_prompts", "generate_keyframes",
             "wait_keyframes", "review_keyframes", "confirm_keyframes", "write_video_prompt", "review_video_prompt",
             "generate_video", "wait_video", "review_video", "compose", "review_compose", "done"]
    lines.append("next action per shot (canonical order):")
    for k in order:
        if k in groups:
            lines.append(f"  {k:22s} {len(groups[k]):3d}  {groups[k]}")
    if groups.keys() & {"await_skeleton_confirm", "await_design_card_confirm"}:
        lines.append("await_* = 等待人工确认（hbwf 只提示；不调用 confirm 端点）")
    gate = state["final_gate"]
    lines.append(f"final gate: {'PASS' if not gate else str(len(gate)) + ' problem(s)'}")
    for g in [g for g in gate if not g.startswith('shot ')]:
        lines.append(f"  - {g}")
    return "\n".join(lines)


def cmd_derive(a):
    prj = Project.find(a.project)
    with prj.lock():
        state = derive(prj)
    print(summarize(state))


def cmd_check(a):
    prj = Project.find(a.project)
    with prj.lock():
        state = derive(prj)
    if a.json:
        print(json.dumps(state, ensure_ascii=False, indent=1))
        return
    print(summarize(state))
    if a.ids:
        want = {int(x) for x in a.ids.split(",")}
        for r in state["shots"]:
            if r["id"] in want:
                print(json.dumps(r, ensure_ascii=False))
    if a.final and state["final_gate"]:
        sys.exit(2)


def cmd_status(a):
    try:
        prj = Project.find(a.project)
    except SystemExit as ex:
        print(str(ex))
        return
    p = prj.dir / "state.json"
    if not p.exists():
        print("hbwf: state.json not derived yet; run `hbwf derive`")
        return
    print(summarize(json.loads(p.read_text())))


def cmd_get(a):
    prj = Project.find(a.project)
    print(json.dumps(prj.get(a.path), ensure_ascii=False, indent=None if a.compact else 1))


def load_body(a) -> dict:
    if a.body_file:
        return json.loads(Path(a.body_file).read_text())
    if a.body:
        return json.loads(a.body)
    return {}


def body_ref(prj: Project, call_id: str, body: dict):
    raw = json.dumps(body, ensure_ascii=False)
    if len(raw) <= BODY_INLINE_LIMIT:
        return body, None
    (prj.dir / "bodies").mkdir(exist_ok=True)
    p = prj.dir / "bodies" / f"{call_id}.json"
    p.write_text(raw)
    summary = {k: (v if len(json.dumps(v, ensure_ascii=False)) <= 300 else f"<{len(json.dumps(v, ensure_ascii=False))} chars>") for k, v in body.items()}
    return summary, {"path": str(p.relative_to(prj.root)), "sha256": file_sha(p)}


def target_ids_of(path: str, body: dict, declared: list[int] | None) -> list[int]:
    if declared:
        return declared
    if isinstance(body.get("storyboard_ids"), list):
        return [int(x) for x in body["storyboard_ids"]]
    if isinstance(body.get("items"), list):
        return sorted({int(x["storyboard_id"]) for x in body["items"] if "storyboard_id" in x})
    m = re.fullmatch(r"/storyboards/(\d+)(/.*)?", path)
    return [int(m.group(1))] if m else []


def cmd_call(a):
    prj = Project.find(a.project)
    method = a.method.upper()
    path = a.path.split("?")[0]
    body = load_body(a)
    declared = [int(x) for x in a.ids.split(",")] if a.ids else None
    call_id = uuid.uuid4().hex[:12]
    with prj.lock():
        state = derive(prj)
        ledger = prj.read_jsonl("ledger.jsonl")
        decisions = prj.read_jsonl("decisions.jsonl")
        road_before = roadmap_snapshot(state.get("roadmap"))
        target = write_step_of(method, path, body)
        target_key = roadmap_step_key(state.get("roadmap"), target[0]) if target else None
        target_sub = target[1] if target and (state.get("roadmap") or {}).get("project_type") == "documentary" else None
        ctx = {"episode_id": prj.e, "models": prj.config["models"], "decisions": decisions, "ledger": ledger,
               "voice_preview": lambda bd: {x["storyboard_id"]: x.get("status") for x in
                                            prj.preview(f"/episodes/{prj.e}/narration/voice-batch/preview", bd).get("items", [])}}
        body_hash = sha([method, path, body])
        try:
            errors, warnings, exception_id = guard(ctx, method, path, body, declared, state)
        except GuardError as ex:
            errors, warnings, exception_id = [str(ex)], [], None
        if method != "GET" and not path.endswith("/preview"):
            gate = gate_installed_ok()
            if gate and not a.dry_run:
                errors.append(gate)
            unknown = [r["call_id"] for r in ledger if r.get("phase") == "outcome" and r.get("result") == "unknown" and r.get("body_hash") == body_hash]
            reconciled = {cid for d in decisions if d["kind"] == "reconcile" for cid in d.get("call_ids", [])}
            if [c for c in unknown if c not in reconciled]:
                errors.append(f"an identical earlier call has an unknown outcome {unknown}; reconcile it from GET state and record a `reconcile` decision before resubmitting")
        summary, ref = body_ref(prj, call_id, body)
        verdict = {"allowed": not errors, "errors": errors, "warnings": warnings}
        prepared = {"phase": "prepared", "call_id": call_id, "at": now_iso(), "method": method, "path": path,
                    "declared_ids": declared, "target_ids": target_ids_of(path, body, declared), "intent": a.intent,
                    "body": summary, "body_ref": ref, "body_hash": body_hash, "guard": verdict, "dry_run": a.dry_run,
                    "exception_id": exception_id if (not errors and not a.dry_run) else None,
                    "roadmap_step": target_key, "roadmap_substep": target_sub, "roadmap_current": road_before.get("current"),
                    "state_derived_at": state["derived_at"], "actor": os.environ.get("HBWF_ACTOR") or os.environ.get("USER")}
        if errors or a.dry_run:
            prepared["phase"] = "refused" if errors else "dry_run"
            prepared["target_ids"] = []
            prj.append("ledger.jsonl", prepared)
            for w in warnings:
                print(f"warning: {w}", file=sys.stderr)
            if errors:
                print("hbwf: REFUSED", file=sys.stderr)
                for x in errors:
                    print(f"  - {x}", file=sys.stderr)
                sys.exit(2)
            print("hbwf: dry-run ALLOWED (no request sent)")
            return
        # re-check in-flight batches right before submitting (TOCTOU)
        for key, p in (("video", f"/episodes/{prj.e}/video-batch"), ("keyframe", f"/episodes/{prj.e}/keyframe-batch")):
            cur = prj.get(p) or {}
            if (cur.get("id"), cur.get("status")) != (state["batches"][key]["id"], state["batches"][key]["status"]):
                prepared["phase"] = "refused"
                prepared["guard"]["errors"].append(f"{key} batch changed during guard; re-run")
                prj.append("ledger.jsonl", prepared)
                raise SystemExit(f"hbwf: REFUSED — {key} batch changed between derivation and submission; re-run")
        prj.append("ledger.jsonl", prepared)
        before_saved = {r["id"]: (r["kf_prompts"]["saved_at"], r["video_prompt"]["saved_at"]) for r in state["shots"]}
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    outcome = {"phase": "outcome", "call_id": call_id, "body_hash": body_hash}
    try:
        status, ctype, resp = prj.request(method, a.path, body if method != "GET" else None, timeout=a.timeout)
        outcome.update({"result": "ok" if status < 400 and "json" in ctype else "error", "status": status, "content_type": ctype, "response": resp})
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as ex:
        outcome.update({"result": "unknown", "error": repr(ex)})
        status, ctype, resp = None, None, None
    outcome["at"] = now_iso()
    if path == "/agent/prompt_generator/chat" and outcome["result"] != "unknown":
        with prj.lock():
            after = derive(prj, write=False)
        changed = [r["id"] for r in after["shots"] if (r["kf_prompts"]["saved_at"], r["video_prompt"]["saved_at"]) != before_saved.get(r["id"])]
        outcome["changed_ids"] = changed
        outside = sorted(set(changed) - set(declared or []))
        missing = sorted(set(declared or []) - set(changed))
        if outside:
            outcome["violation"] = f"model wrote shots outside declared ids: {outside}"
        if missing:
            outcome["not_saved"] = missing
    with prj.lock():
        try:
            after = derive(prj)
        except SystemExit as ex:  # the write already happened: never lose its outcome record
            after = None
            print(f"warning: post-write derive failed ({ex}); outcome recorded without roadmap after-state", file=sys.stderr)
        if target_key:
            after_snap = roadmap_snapshot((after or {}).get("roadmap")) if after else {"available": False}
            outcome["roadmap"] = {"step": target_key, "substep": target_sub, "before": road_before, "after": after_snap,
                                  "terminal": after_snap.get("statuses", {}).get(target_key) in DONE_STATUSES}
        prj.append("ledger.jsonl", outcome)
    if outcome["result"] == "unknown":
        print(f"hbwf: UNKNOWN outcome ({outcome['error']}); do NOT resubmit. Read state with `hbwf check`, then record `hbwf decide reconcile --call-ids {call_id}`.", file=sys.stderr)
        sys.exit(3)
    printable = {"call_id": call_id, "status": status, "content_type": ctype, "response": resp}
    for k in ("changed_ids", "not_saved", "violation"):
        if k in outcome:
            printable[k] = outcome[k]
    print(json.dumps(printable, ensure_ascii=False)[: a.max_print])
    if outcome["result"] != "ok" or outcome.get("violation"):
        sys.exit(1)


def cmd_decide(a):
    prj = Project.find(a.project)
    if not a.authority:
        raise SystemExit("--authority (the user's authorization wording) is required")
    evidence = []
    for p in a.evidence or []:
        fp = Path(p) if os.path.isabs(p) else prj.root / p
        if not fp.is_file():
            raise SystemExit(f"evidence file not found: {p}")
        evidence.append({"path": str(fp), "sha256": file_sha(fp)})
    if a.kind in APPROVAL_KINDS + ("poster_waiver", "structural_change", "exception") and not evidence and a.kind in APPROVAL_KINDS:
        raise SystemExit("approvals require --evidence: the media/review files actually opened (stored as trace, not proof)")
    ids = [int(x) for x in a.ids.split(",")] if a.ids else []
    rec = {"id": uuid.uuid4().hex[:12], "at": now_iso(), "ts": int(time.time()), "kind": a.kind, "ids": ids,
           "authority": a.authority, "note": a.note, "evidence": evidence, "bound": {},
           "actor": os.environ.get("HBWF_ACTOR") or os.environ.get("USER")}
    with prj.lock():
        if a.kind in APPROVAL_KINDS:
            state = derive(prj)
            sm = {r["id"]: r for r in state["shots"]}
            if a.kind == "poster_approval":
                if not a.version_id:
                    raise SystemExit("--version-id required for poster_approval")
                poster = prj.get(f"/episodes/{prj.e}/poster")
                ver = next((v for v in poster.get("versions") or [] if str(v.get("id")) == str(a.version_id)), None)
                if not ver:
                    raise SystemExit(f"poster version {a.version_id} not found")
                rec["version_id"] = int(a.version_id)
                rec["bound"]["poster"] = sha([int(a.version_id), ver.get("image_url") or ver.get("path") or ver.get("image") or poster.get("final_image")])
            elif a.kind == "script_approval":
                epi = next(x for x in prj.get(f"/dramas/{prj.d}").get("episodes", []) if x["id"] == prj.e)
                rec["bound"]["script"] = sha(epi.get("script_content") or "")
            else:
                if not ids:
                    raise SystemExit("--ids required")
                for sid in ids:
                    r = sm.get(sid)
                    if not r:
                        raise SystemExit(f"{sid} not in episode")
                    if a.kind == "keyframe_approval":
                        bad = {k: v for k, v in r["keyframes"]["slots"].items() if v != "unchanged"}
                        if bad:
                            raise SystemExit(f"{sid}: cannot approve keyframes while slots are {bad}")
                        rec["bound"][str(sid)] = r["keyframes"]["image_hash"]
                    elif a.kind == "video_prompt_review":
                        if not r["video_prompt"]["ok"]:
                            raise SystemExit(f"{sid}: video prompt fails structural checks {r['video_prompt']['problems']}")
                        rec["bound"][str(sid)] = r["video_prompt"]["hash"]
                    elif a.kind == "video_approval":
                        if not r["video"]["url"]:
                            raise SystemExit(f"{sid}: no video to approve")
                        rec["bound"][str(sid)] = sha(r["video"]["url"])
                    elif a.kind == "compose_approval":
                        if not r["compose"]["url"] or r["compose"]["preview"] != "unchanged":
                            raise SystemExit(f"{sid}: composition not current (preview {r['compose']['preview']})")
                        rec["bound"][str(sid)] = sha(r["compose"]["url"])
        else:
            rec["scope"] = a.scope.split(",") if a.scope else []
            if a.kind == "rework" and (not rec["scope"] or not ids):
                raise SystemExit("rework requires --ids and --scope keyframe_prompts|video_prompt|all_prompts")
            if a.kind == "exception" and not (a.method and a.path_regex):
                raise SystemExit("exception requires --method and --path-regex for the exact single call it allows")
            if a.kind == "reconcile" and not (a.call_ids or a.task_ids):
                raise SystemExit("reconcile requires --call-ids and/or --task-ids (e.g. task:2644, batch:33)")
            if a.method:
                rec["method"] = a.method.upper()
            if a.path_regex:
                rec["path_regex"] = a.path_regex
            if a.call_ids:
                rec["call_ids"] = a.call_ids.split(",")
            if a.task_ids:
                rec["task_ids"] = a.task_ids.split(",")
            if a.kind in ("structural_change", "exception", "poster_waiver") and not a.note:
                raise SystemExit(f"{a.kind} requires --note with the reason")
            if a.kind == "poster_waiver":
                refusal = poster_waiver_refusal((prj.get(f"/dramas/{prj.d}") or {}).get("project_type"))
                if refusal:
                    raise SystemExit(refusal)
        prj.append("decisions.jsonl", rec)
    print(json.dumps({k: rec[k] for k in ("id", "kind", "ids", "bound")}, ensure_ascii=False))


def cmd_final(a):
    prj = Project.find(a.project)
    with prj.lock():
        state = derive(prj)
    roadmap = state.get("roadmap")
    probs = list(dict.fromkeys(state["final_gate"] + roadmap_problems(roadmap, require_export=True)))
    decisions = prj.read_jsonl("decisions.jsonl")
    kinds: dict = {}
    for d in decisions:
        kinds[d["kind"]] = kinds.get(d["kind"], 0) + 1
    print(f"decisions recorded: {kinds}")
    for line in summarize_roadmap(roadmap):
        print(line)
    print("final check PASS" if not probs else "final check FAIL:\n" + "\n".join(f"  - {p}" for p in probs))
    sys.exit(0 if not probs else 2)


def build_parser():
    ap = argparse.ArgumentParser(prog="hbwf", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--project", dest="project_dir", help="production project directory (default: search upward from cwd)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("init", help="create workflow/workflow.json")
    p.add_argument("project")
    p.add_argument("--api-base", required=True)
    p.add_argument("--drama", type=int, required=True)
    p.add_argument("--episode", type=int, required=True)
    p.add_argument("--profile", default="drama_narration")
    p.add_argument("--required-poster", action="store_true")
    p.add_argument("--canonical", help="canonical storyboard id order file, relative to the project")
    p.add_argument("--models", required=True, help='JSON {"text":{"config_id":..,"model":..},"image":{..},"video":{..},"tts":{"config_id":..}}')
    p.add_argument("--authorization", required=True, help="the user's authorization wording")
    p.add_argument("--created-at", help="reconciliation start (ISO); default now")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_init)

    for name, fn, hlp in (("derive", cmd_derive, "re-derive state.json from Huobao"),
                          ("status", cmd_status, "print the last derived state (no network)"),
                          ("final", cmd_final, "post-export completion check (pre-export gate + roadmap M3, no stale steps)")):
        sub.add_parser(name, help=hlp).set_defaults(fn=fn)
    p = sub.add_parser("check", help="derive and print roadmap steps + per-shot next actions")
    p.add_argument("--ids")
    p.add_argument("--json", action="store_true")
    p.add_argument("--final", action="store_true")
    p.set_defaults(fn=cmd_check)
    p = sub.add_parser("get", help="read-only GET")
    p.add_argument("path")
    p.add_argument("--compact", action="store_true")
    p.set_defaults(fn=cmd_get)

    p = sub.add_parser("call", help="guarded business call (the only write path)")
    p.add_argument("method")
    p.add_argument("path")
    p.add_argument("--body")
    p.add_argument("--body-file")
    p.add_argument("--ids", help="declared target storyboard ids (required for prompt_generator chat)")
    p.add_argument("--intent", required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--timeout", type=int, default=1800)
    p.add_argument("--max-print", type=int, default=4000)
    p.set_defaults(fn=cmd_call)

    p = sub.add_parser("decide", help="record a human/proxy decision bound to current artifact versions")
    p.add_argument("kind", choices=ALL_KINDS)
    p.add_argument("--ids")
    p.add_argument("--version-id")
    p.add_argument("--evidence", nargs="*")
    p.add_argument("--authority", required=True)
    p.add_argument("--note", default="")
    p.add_argument("--scope", help="rework scope: keyframe_prompts,video_prompt,all_prompts")
    p.add_argument("--method")
    p.add_argument("--path-regex")
    p.add_argument("--call-ids")
    p.add_argument("--task-ids")
    p.set_defaults(fn=cmd_decide)
    return ap


def main(argv=None):
    a = build_parser().parse_args(argv)
    if a.cmd != "init":
        a.project = a.project_dir
    a.fn(a)


if __name__ == "__main__":
    main()
