#!/usr/bin/env python3
"""Google Earth Web 底图抓取（火宝 Issue #84）。

用法：`python earth-map.py` —— 作业描述从 stdin 读 JSON，最后一行 stdout 输出 sidecar JSON。
调用方是 backend/src/services/map-earth.ts；相机/取景数学两边逐行一致（同一套公式各写一遍，
因为浏览器这一侧必须按 Earth **实际落点** 重算裁切框，不能用 Node 侧的计划值）。

数学与控件定位来自 ~/projects/qing_russia_history/src/qrdoc/earth.py（2026-11-01 实测闭合，
见 skill kmz-google-earth）。本脚本自带全部所需代码，不 import 那个项目的任何模块。

三趟截图，实际机位一致：
  1. 用户 KMZ 证据图；2. 专用控制点 KMZ 校准图（129×129 网格、128×128 留出点实测 ≤3px）；
  3. 无 KML 的干净底图。只用实测网格配准，名义球面相机数学只负责计划与控制点定位。

Earth 的界面（搜索框/工具栏/小地图/版权 footer）永远贴着窗口四边，所以窗口开得比可用画幅大，
截图只取中间那块。影像版权属 Google 及其数据方，调用方负责在成品上保留出处。

失败一律以非零退出码 + stderr 说明结束，绝不输出一张不知道拍了什么的图。
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import signal
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

EARTH_RADIUS_M = 6_371_008.8
CHROME = {"left": 110, "top": 130, "right": 110, "bottom": 130}
LABEL_CHAR_PX = 29.5
LABEL_GAP_PX = 40
PIN_ABOVE_PX = 120
PIN_BELOW_PX = 40
LINE_PAD_PX = 12
LIMB_USABLE = 0.86
CAMERA_SLACK = 0.04

L_PLACEHOLDER = "flt-semantics-placeholder"
L_FILE_MENU = "File"
L_OPEN_KML = "Open local KML file"
# 2026-11 Google Earth home screen: local files now enter through the rebuilt
# Local KML editor instead of the legacy File menu.
L_LOCAL_KML_EDITOR = "Local KML editor"
L_OPEN_KML_DEVICE_LABELS = ("Open KML/Z from device", "Open KML from device")
L_DISMISS = "Dismiss"
L_COLLAPSE = "Collapse panel"
L_HIDE_MENU = "Hide the menu bar"
L_CLOSE = "Close"
L_BASEMAP = "Basemap settings, Change basemap"
L_BASEMAP_CLEAN = "Clean"

_NODES_JS = """() => {
  const out = [];
  for (const el of document.querySelectorAll('flt-semantics')) {
    const r = el.getBoundingClientRect();
    let label = el.getAttribute('aria-label') || '';
    if (!label) {
      label = Array.from(el.childNodes).filter(n => n.nodeType === 3)
        .map(n => n.textContent.trim()).join(' ').trim();
    }
    if (!label) {
      const span = el.querySelector(':scope > span');
      if (span) label = span.textContent.trim();
    }
    if (!label || r.width < 1 || r.height < 1) continue;
    out.push({id: el.id, role: el.getAttribute('role') || '', label,
              x: r.x, y: r.y, w: r.width, h: r.height});
  }
  return out;
}"""

# Earth 把相机写在自己的 URL 里；pushState + popstate 是唯一不重载 Flutter 应用
# （从而不会丢掉已载入的本地 KML）的改相机方式。
_PUSH_CAMERA_JS = """(url) => {
  history.pushState(null, '', url);
  dispatchEvent(new PopStateEvent('popstate', {state: null}));
}"""

_CAMERA_RE = re.compile(r"/@(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)a,([\d.]+)d,([\d.]+)y")


class EarthError(RuntimeError):
    pass


# ----------------------------------------------------------------- 相机数学
def unit(lat: float, lon: float) -> tuple[float, float, float]:
    rlat, rlon = math.radians(lat), math.radians(lon)
    return (math.cos(rlat) * math.cos(rlon), math.cos(rlat) * math.sin(rlon), math.sin(rlat))


def focal_px(window_width: int, fov: float) -> float:
    """`…y` 是**水平**视场角，焦距按窗口宽算。"""
    return window_width / (2 * math.tan(math.radians(fov) / 2))


def project(points, camera, window):
    lat0, lon0, distance, fov = camera
    up = unit(lat0, lon0)
    rlat0, rlon0 = math.radians(lat0), math.radians(lon0)
    east = (-math.sin(rlon0), math.cos(rlon0), 0.0)
    north = (-math.sin(rlat0) * math.cos(rlon0), -math.sin(rlat0) * math.sin(rlon0),
             math.cos(rlat0))
    focal = focal_px(window[0], fov)
    horizon = EARTH_RADIUS_M / (EARTH_RADIUS_M + distance)
    out = []
    for lon, lat in points:
        p = unit(lat, lon)
        along = p[0] * up[0] + p[1] * up[1] + p[2] * up[2]
        depth = (EARTH_RADIUS_M + distance) - EARTH_RADIUS_M * along
        x = EARTH_RADIUS_M * (p[0] * east[0] + p[1] * east[1] + p[2] * east[2])
        y = EARTH_RADIUS_M * (p[0] * north[0] + p[1] * north[1] + p[2] * north[2])
        out.append((window[0] / 2 + focal * x / depth,
                    window[1] / 2 - focal * y / depth,
                    along > horizon))
    return out


def label_width_px(name: str) -> float:
    return LABEL_CHAR_PX * sum(1.0 if unicodedata.east_asian_width(ch) in "WFA" else 0.5
                               for ch in name)


def content_rect(points, labelled, camera, window):
    """要出现在画面里的矩形：全部几何 + 每个地名自己的图钉/文字留位。"""
    seen = project(points, camera, window)
    if not all(visible for _x, _y, visible in seen):
        return None
    xs = [x for x, _y, _v in seen]
    ys = [y for _x, y, _v in seen]
    rect = [min(xs) - LINE_PAD_PX, min(ys) - LINE_PAD_PX,
            max(xs) + LINE_PAD_PX, max(ys) + LINE_PAD_PX]
    places = [(item["lon"], item["lat"]) for item in labelled]
    for (x, y, visible), item in zip(project(places, camera, window), labelled):
        if not visible:
            return None
        rect = [min(rect[0], x - LABEL_GAP_PX), min(rect[1], y - PIN_ABOVE_PX),
                max(rect[2], x + label_width_px(item["name"]) + LABEL_GAP_PX),
                max(rect[3], y + PIN_BELOW_PX)]
    return rect


def inside_clip(rect, frame) -> bool:
    return (rect[0] >= CHROME["left"] and rect[1] >= CHROME["top"]
            and rect[2] <= CHROME["left"] + frame[0]
            and rect[3] <= CHROME["top"] + frame[1])


def limb_angle(distance: float) -> float:
    return math.degrees(math.asin(EARTH_RADIUS_M / (EARTH_RADIUS_M + distance)))


def rect_angle(rect, window, fov: float) -> float:
    focal = focal_px(window[0], fov)
    cx, cy = window[0] / 2, window[1] / 2
    corners = ((rect[0], rect[1]), (rect[2], rect[1]), (rect[0], rect[3]), (rect[2], rect[3]))
    return math.degrees(math.atan(max(math.hypot(x - cx, y - cy) for x, y in corners) / focal))


def limb_fill(rect, window, distance: float, fov: float) -> float:
    return math.tan(math.radians(rect_angle(rect, window, fov))) / math.tan(
        math.radians(limb_angle(distance)))


def crop_box(rect, frame) -> dict:
    x0 = max(CHROME["left"], math.floor(rect[0]))
    y0 = max(CHROME["top"], math.floor(rect[1]))
    x1 = min(CHROME["left"] + frame[0], math.ceil(rect[2]))
    y1 = min(CHROME["top"] + frame[1], math.ceil(rect[3]))
    return {"x": x0, "y": y0, "width": max(x1 - x0, 1), "height": max(y1 - y0, 1)}


def camera_url(camera, earth_url: str) -> str:
    lat, lon, distance, fov = camera
    return f"{earth_url}@{lat:.6f},{lon:.6f},0a,{distance:.0f}d,{fov:g}y,0h,0t,0r"


def camera_taken(asked, got) -> bool:
    span = asked[2] * math.tan(math.radians(asked[3]) / 2) / 111_320.0
    return (abs(got[0] - asked[0]) <= span * CAMERA_SLACK
            and abs(got[1] - asked[1]) <= span * CAMERA_SLACK
            / max(math.cos(math.radians(asked[0])), 0.2)
            and abs(math.log2(got[2] / asked[2])) <= CAMERA_SLACK)


# ----------------------------------------------------------------- 页面控件
def nodes(page):
    return page.evaluate(_NODES_JS)


def match(found, label: str, exact: bool):
    for node in found:
        text = node["label"]
        hit = text == label if exact else label.lower() in text.lower()
        # 模态遮罩带着整段对话框文字，绝不能点它
        if hit and not (node["w"] > 900 and node["h"] > 600):
            return node
    return None


def find(page, label: str, *, exact: bool = True, timeout: float = 20.0, required: bool = True):
    waited, seen = 0.0, []
    reopen_after_dismiss = False
    while waited <= timeout:
        seen = nodes(page)
        # 实测 onboarding 气泡没有 Alert/dialog role（如 “Access the data catalog…”），
        # 只有一个 Dismiss。它仍然会吃掉菜单点击，因此对所有非关闭目标先清掉可见 Dismiss。
        # 普通 Clean 设置面板只有 Close，不因此被误关。
        dismiss = match(seen, L_DISMISS, True)
        blocked = dismiss is not None or any(
            n["role"] in ("alert", "alertdialog") or n["label"] == "Alert"
            or n["label"].startswith("Find infrastructure assets") for n in seen)
        history = getattr(page, "_huobao_readiness", [])
        observation = {"target": label, "elapsed_s": waited, "labels": [n["label"] for n in seen]}
        history.append(observation)
        page._huobao_readiness = history[-100:]
        if blocked and label not in (L_CLOSE, L_DISMISS):
            close = dismiss or match(seen, L_CLOSE, True)
            if close is not None:
                # Coachmark 的语义节点可能先于画布完成移动；按节点激活，
                # 不按旧像素误点“项目”，也不发会退出编辑器的全局 Escape。
                activate(page, close)
                observation["action"] = close["label"]
            reopen_after_dismiss = label == L_OPEN_KML or label in L_OPEN_KML_DEVICE_LABELS
            page.wait_for_timeout(1000)
            waited += 1.0
            continue  # 重读语义树；必须观测到弹窗消失、目标可用才算就绪
        hit = match(seen, label, exact)
        if hit:
            return hit
        # 清掉迟到的 onboarding 气泡可能同时收起已经展开的 File 菜单。
        # 仅在本次查找确实清过遮挡气泡之后恢复一次菜单，不能每轮点击 File（会反复开关）。
        if reopen_after_dismiss:
            reopen_after_dismiss = False
            file_menu = match(seen, L_FILE_MENU, True)
            if file_menu is not None:
                activate(page, file_menu)
                observation["action"] = "Open File menu"
        page.wait_for_timeout(1000)
        waited += 1.0
    if not required:
        return None
    labels = sorted({n["label"][:40] for n in seen})[:40]
    raise EarthError(f"Google Earth Web 控件 {label!r} 在 {timeout:.0f}s 内没出现；"
                     f"界面可能已变更。当前可见标签：{labels}")


def activate(page, node) -> bool:
    """Flutter 语义动作以节点身份定位，避免动画期间的旧 bbox 命中别处。"""
    return page.evaluate("""(id) => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.click();
      return true;
    }""", node["id"])


def click(page, label: str, *, exact: bool = True, timeout: float = 20.0,
          required: bool = True, settle: int = 1500) -> bool:
    node = find(page, label, exact=exact, timeout=timeout, required=required)
    if node is None:
        return False
    if not activate(page, node):
        if required:
            raise EarthError(f"Google Earth 控件 {label!r} 在激活前已变化，请重试本阶段")
        return False
    page.wait_for_timeout(settle)
    return True


def enable_semantics(page, timeout: float = 90.0) -> None:
    """就绪判定：语义树已经开着就直接用，否则点那个隐藏的占位元素把它打开。

    不要盲等固定秒数，也不要只等 `flt-semantics-placeholder`：Earth 的首屏时长随网络波动，
    而且在某些状态下（例如从已有会话恢复）语义节点一开始就在、占位元素根本不出现，
    实测死等占位元素会在 60s 超时失败。两种就绪条件任一满足即可。
    """
    waited = 0.0
    clicked = False
    while waited < timeout:
        if nodes(page):
            return
        placeholder = page.query_selector(L_PLACEHOLDER)
        if placeholder is not None:
            # 占位元素在视口之外，Flutter 只认 DOM click
            placeholder.evaluate("el => el.click()")
            clicked = True
            page.wait_for_timeout(2500)
            waited += 2.5
            if nodes(page):
                return
        page.wait_for_timeout(1000)
        waited += 1.0
    raise EarthError(
        f"等了 {timeout:.0f}s，Earth Web 既没有暴露 semantics 节点，"
        + ("也" if not clicked else "点过无障碍占位元素后也")
        + f"没能启用无障碍（占位元素 {L_PLACEHOLDER} "
        + ("从未出现" if not clicked else "点过了") + "）；页面可能没加载完或 Flutter 语义 API 已变更",
    )


def settle_tiles(page, timeout: float = 60.0, quiet_rounds: int = 2) -> float:
    """等到连续两帧字节一致：影像是异步流式加载的。"""
    previous, stable, waited = None, 0, 0.0
    while waited < timeout:
        current = hashlib.sha256(page.screenshot(type="jpeg", quality=40)).digest()
        if previous is not None and current == previous:
            stable += 1
            if stable >= quiet_rounds:
                return waited
        else:
            stable = 0
        previous = current
        page.wait_for_timeout(2000)
        waited += 2.0
    return waited


def clean_basemap(page) -> bool:
    """Earth 自带的 Clean 底图：卫星影像但没有 Google 的现代地名/国界/道路。"""
    click(page, L_BASEMAP, timeout=90, settle=2500)
    click(page, L_BASEMAP_CLEAN, exact=False, timeout=30, settle=4000)
    click(page, L_CLOSE, timeout=20, settle=1500)
    return True


def read_camera(page):
    found = _CAMERA_RE.search(page.url)
    if not found:
        raise EarthError(f"Earth Web 的 URL 里不再带相机参数：{page.url}")
    lat, lon, _alt, distance, fov = (float(g) for g in found.groups())
    return (lat, lon, distance, fov)


def apply_camera(page, camera, earth_url: str, tries: int = 3):
    url = camera_url(camera, earth_url)
    reported = camera
    for _ in range(tries):
        page.evaluate(_PUSH_CAMERA_JS, url)
        page.wait_for_timeout(8000)
        reported = read_camera(page)
        if camera_taken(camera, reported):
            return reported
    raise EarthError(f"Earth 没有接受给定相机 {url}，它回报的是 {camera_url(reported, earth_url)}；"
                     "裁切框是按相机算的，拒绝保存一张可能拍错地方的图")


def init_script(kmz: Path) -> str:
    """The local-KML open actions call showOpenFilePicker (File System Access API).
    Playwright's file chooser interception cannot serve it, so install a handle
    returning the KMZ bytes before Earth loads."""
    payload = base64.b64encode(kmz.read_bytes()).decode()
    name = json.dumps(kmz.name)
    return f"""
(() => {{
  const bin = atob("{payload}");
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  window.__huobaoPicker = {{requested: 0, file_reads: 0, name: {name}, bytes: bytes.length}};
  window.__huobaoEarthErrors = [];
  window.addEventListener('error', e => window.__huobaoEarthErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__huobaoEarthErrors.push(String(e.reason)));
  window.showOpenFilePicker = async () => {{
    window.__huobaoPicker.requested++;
    return [{{
      kind: 'file', name: {name},
      getFile: async () => {{
        window.__huobaoPicker.file_reads++;
        return new File([bytes], {name}, {{type: 'application/vnd.google-earth.kmz'}});
      }},
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
    }}];
  }};
}})();
"""


def prepare_page(page, earth_url: str) -> None:
    # domcontentloaded + 就绪轮询：`load` 之后再盲等 15s 既慢又不可靠（实测 60s 超时失败），
    # 真正的就绪信号是语义树可用，由 enable_semantics 轮询判定。
    page.goto(earth_url, wait_until="domcontentloaded", timeout=120000)
    enable_semantics(page)


def open_local_kml(page) -> None:
    """Prefer an already-ready editor; the home-screen link is navigation, not import.

    At large production viewports both File and Local KML editor can be visible.
    Clicking the latter from an editor navigates back to Map projects and loses
    the usable File menu. Only use it when no editor menu is present.
    """
    if not find(page, L_FILE_MENU, timeout=15, required=False):
        click(page, L_LOCAL_KML_EDITOR, timeout=20)
        find(page, L_FILE_MENU, timeout=30)
    click(page, L_FILE_MENU)
    if find(page, L_OPEN_KML, exact=False, timeout=5, required=False):
        click(page, L_OPEN_KML, exact=False, timeout=10, settle=0)
        return
    for label in L_OPEN_KML_DEVICE_LABELS:
        if find(page, label, timeout=5, required=False):
            click(page, label, timeout=10, settle=0)
            return
    labels = sorted({node["label"][:80] for node in nodes(page)})
    raise EarthError(f"Google Earth File menu has no local-KML open action; saw {labels[:40]}")

def capture_failure(page, prefix: str, tag: str) -> str:
    """失败现场：截图 + 当前 URL + 可见标签。关页面之前必须留下，否则无从诊断。"""
    captured = {"captured_at": datetime.now(timezone.utc).isoformat(), "pass": tag}
    captured["readiness_history"] = getattr(page, "_huobao_readiness", [])
    try:
        captured["picker"] = page.evaluate("() => window.__huobaoPicker || null")
        captured["page_errors"] = page.evaluate("() => window.__huobaoEarthErrors || []")
    except Exception as exc:
        captured["picker_diagnostics_error"] = str(exc)
    try:
        captured["url"] = page.url
    except Exception as exc:
        captured["url_error"] = str(exc)
    shot = f"{prefix}-{tag}.png"
    try:
        Path(shot).parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=shot, timeout=15000)
        captured["screenshot"] = shot
    except Exception as exc:
        captured["screenshot_error"] = str(exc)
    try:
        captured["labels"] = nodes(page)
    except Exception as exc:
        captured["labels_error"] = str(exc)
    diagnostics = f"{prefix}-{tag}.json"
    try:
        Path(diagnostics).parent.mkdir(parents=True, exist_ok=True)
        Path(diagnostics).write_text(json.dumps(captured, ensure_ascii=False, indent=2), encoding="utf-8")
        captured["diagnostics"] = diagnostics
    except Exception as exc:
        captured["diagnostics_error"] = str(exc)
    labels = [item["label"][:40] for item in captured.get("labels", [])][:20]
    return (f"url={captured.get('url', '')} | screenshot={captured.get('screenshot', '')} "
            f"| diagnostics={captured.get('diagnostics', '')} | labels={labels}")


def tidy_ui(page) -> bool:
    clean = clean_basemap(page)
    click(page, L_HIDE_MENU, required=False, timeout=5)
    click(page, L_COLLAPSE, required=False, timeout=5, settle=2000)
    return clean


def shoot(page, job, *, out_path: Path, with_kmz: bool):
    """应用相机 → 等瓦片稳 → 按 Earth **实际** 相机复算裁切框 → 截图。"""
    earth_url = job["earth_url"]
    frame = (job["frame"]["width"], job["frame"]["height"])
    window = (job["window"]["width"], job["window"]["height"])
    planned = (job["camera"]["lat"], job["camera"]["lon"],
               job["camera"]["distance_m"], job["camera"]["fov_deg"])
    points = [tuple(p) for p in job["points"]]
    labelled = job["labelled"]

    apply_camera(page, planned, earth_url)
    # 指针退出视口，避免 Google 悬停卡片/tooltip 残留在裁切边缘。
    page.mouse.move(-20, -20)
    page.keyboard.press("Escape")
    page.wait_for_timeout(1000)
    waited = settle_tiles(page)
    used = read_camera(page)
    if not camera_taken(planned, used):
        used = apply_camera(page, planned, earth_url)
        waited += settle_tiles(page)
        used = read_camera(page)

    rect = content_rect(points, labelled, used, window)
    if rect is None:
        raise EarthError(f"按 Earth 实际相机（{camera_url(used, earth_url)}）复算，有几何落在地平线之后")
    if not inside_clip(rect, frame):
        raise EarthError(f"按 Earth 实际相机复算，内容 {[round(v) for v in rect]} 超出无界面画幅 {frame}")
    fill = limb_fill(rect, window, used[2], used[3])
    if fill > LIMB_USABLE:
        raise EarthError(f"裁切框会拍到地球边缘（占地平线半径 {fill:.0%}，上限 {LIMB_USABLE:.0%}）")
    crop = crop_box(rect, frame)
    interactive_roles = {"button", "dialog", "alert", "alertdialog", "tooltip", "menu", "textbox", "menuitem"}
    overlaps = [node for node in nodes(page)
                if node["role"] in interactive_roles
                and node["w"] < window[0] * .8 and node["h"] < window[1] * .8
                and node["x"] < crop["x"] + crop["width"] and node["x"] + node["w"] > crop["x"]
                and node["y"] < crop["y"] + crop["height"] and node["y"] + node["h"] > crop["y"]]
    if overlaps and not with_kmz:
        raise EarthError(f"Google UI intersects the intended clean map crop: {overlaps}")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(out_path), clip=crop)
    return {"camera": used, "crop": crop, "rect": rect, "waited": waited, "with_kmz": with_kmz}


def main() -> int:
    job = json.loads(sys.stdin.read())
    kmz = Path(job["kmz"])
    out = Path(job["out"])
    evidence = Path(job["evidence"])
    window = (job["window"]["width"], job["window"]["height"])
    from earth_calibration import build_controls, write_calibration_kmz, measure_controls
    calibration_controls = build_controls(job["bbox"])
    calibration_kmz = out.with_name(out.stem + "-calibration.kmz")
    calibration_sha256 = write_calibration_kmz(calibration_controls, calibration_kmz)
    calibration_image = out.with_name(out.stem + "-calibration.png")
    earth_url = job["earth_url"]
    debug_prefix = job.get("debug") or str(out.with_suffix(""))

    from playwright.sync_api import sync_playwright

    launch_args = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
                   "--hide-scrollbars", "--mute-audio"]
    # 作业标记：Chromium 会忽略它不认识的开关，但它会留在命令行里，
    # 调用方据此精确找到本次作业拉起的浏览器进程（绝不按进程名乱杀）。
    if job.get("marker"):
        launch_args.append(f"--huobao-earth-job={job['marker']}")
    # Controls are located by English labels (Local KML editor / File / Dismiss),
    # so the browser locale must not follow the container default.
    context_options = {
        "viewport": {"width": window[0], "height": window[1]},
        "device_scale_factor": 1,
        "locale": "en-US",
        "extra_http_headers": {"Accept-Language": "en-US,en;q=0.9"},
    }
    with sync_playwright() as driver:
        launch = {"headless": True, "args": launch_args}
        if job.get("chromium"):
            launch["executable_path"] = job["chromium"]
        browser = driver.chromium.launch(**launch)
        try:
            # 第一趟：载入 KMZ，证明本地 KML 真的被解析，并留下证据图
            context = browser.new_context(**context_options)
            context.add_init_script(init_script(kmz))
            page = context.new_page()
            try:
                prepare_page(page, earth_url)
                open_local_kml(page)
                # Opening an editor is not import proof: the injected picker must
                # materialize the KMZ and Earth must expose its parsed folder.
                page.wait_for_function("() => window.__huobaoPicker?.file_reads > 0", timeout=15000)
                find(page, ", folder", exact=False, timeout=90)
                folders = [node["label"] for node in nodes(page) if ", folder" in node["label"]]
                while click(page, L_DISMISS, required=False, timeout=3, settle=1200):
                    pass
                tidy_ui(page)
                evidence_shot = shoot(page, job, out_path=evidence, with_kmz=True)
            except Exception as exc:
                raise EarthError(
                    f"载入 KMZ 这一趟失败：{type(exc).__name__}: {exc} | "
                    + capture_failure(page, debug_prefix, "kmz-pass")) from exc
            finally:
                context.close()

            # 独立校准趟：专用 KMZ，只含真实经纬度上的固定大小洋红色中心标记。
            # 检测整张窗口截图，坐标原点明确为 window-top-left，不混用裁切后的像素。
            context = browser.new_context(**context_options)
            context.add_init_script(init_script(calibration_kmz))
            page = context.new_page()
            try:
                prepare_page(page, earth_url)
                open_local_kml(page)
                page.wait_for_function("() => window.__huobaoPicker?.file_reads > 0", timeout=15000)
                find(page, ", folder", exact=False, timeout=90)
                tidy_ui(page)
                asked = (job["camera"]["lat"], job["camera"]["lon"],
                         job["camera"]["distance_m"], job["camera"]["fov_deg"])
                apply_camera(page, asked, earth_url)
                page.mouse.move(-20, -20)
                page.keyboard.press("Escape")
                settle_tiles(page)
                calibration_camera = read_camera(page)
                page.screenshot(path=str(calibration_image))
                calibration = measure_controls(calibration_controls, calibration_image,
                                               calibration_camera, window, project)
                calibration["screenshot"] = str(calibration_image)
                calibration["kmz"] = str(calibration_kmz)
                calibration["kmz_sha256"] = calibration_sha256
                calibration["camera"] = {
                    "lat": calibration_camera[0], "lon": calibration_camera[1],
                    "distance_m": calibration_camera[2], "fov_deg": calibration_camera[3]}
            except Exception as exc:
                raise EarthError(f"真实像素校准失败：{type(exc).__name__}: {exc} | "
                                 + capture_failure(page, debug_prefix, "calibration-pass")) from exc
            finally:
                context.close()

            # 第二趟：不载入任何 KML，拍干净影像底图（几何由可编辑图层承担，不烧进底图）
            context = browser.new_context(**context_options)
            page = context.new_page()
            try:
                prepare_page(page, earth_url)
                clean = tidy_ui(page)
                base_shot = shoot(page, job, out_path=out, with_kmz=False)
            except Exception as exc:
                raise EarthError(
                    f"拍干净底图这一趟失败：{type(exc).__name__}: {exc} | "
                    + capture_failure(page, debug_prefix, "base-pass")) from exc
            finally:
                context.close()
        finally:
            browser.close()

    lat, lon, distance, fov = base_shot["camera"]
    # 两趟相机不能偷偷不一致。只容许数值回报量化造成的亚像素差，不用未知相机外推像素网格。
    calibration_positions = project([(point["lon"], point["lat"]) for point in calibration_controls],
                                    calibration_camera, window)
    base_positions = project([(point["lon"], point["lat"]) for point in calibration_controls],
                             base_shot["camera"], window)
    drift = max(math.hypot(first[0] - second[0], first[1] - second[1])
                for first, second in zip(calibration_positions, base_positions))
    if drift > .25:
        raise EarthError(f"校准趟与干净底图趟的相机漂移 {drift:.3f}px > 0.25px，拒绝套用旧网格")
    calibration["camera_drift_px"] = drift
    # 网格的最终像素坐标原点为裁切图左上，归一化后与 LayerDoc 同口径。
    crop = base_shot["crop"]
    calibration["grid"] = {
        "lon_min": job["bbox"][0], "lat_min": job["bbox"][1],
        "lon_max": job["bbox"][2], "lat_max": job["bbox"][3],
        "cols": calibration["cols"], "rows": calibration["rows"],
        "points": [[(point[0] - crop["x"]) / crop["width"],
                    (point[1] - crop["y"]) / crop["height"]] for point in calibration["pixels"]]}
    sidecar = {
        "camera_used": {"lat": lat, "lon": lon, "distance_m": distance, "fov_deg": fov},
        "camera_url": camera_url(base_shot["camera"], earth_url),
        "evidence_camera": {"lat": evidence_shot["camera"][0], "lon": evidence_shot["camera"][1],
                            "distance_m": evidence_shot["camera"][2],
                            "fov_deg": evidence_shot["camera"][3]},
        "window": {"width": window[0], "height": window[1]},
        "frame": job["frame"],
        "crop": base_shot["crop"],
        "evidence_crop": evidence_shot["crop"],
        "image": {"width": base_shot["crop"]["width"], "height": base_shot["crop"]["height"]},
        "content_rect": [round(v, 1) for v in base_shot["rect"]],
        "basemap": "clean (no Google labels/borders/roads)" if clean else "default",
        "kmz_sha256": hashlib.sha256(kmz.read_bytes()).hexdigest(),
        "kmz_folders": folders,
        "evidence_path": str(evidence),
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "tiles_settled_after_s": base_shot["waited"] + evidence_shot["waited"],
        "capture_version": "pixelgrid-v2",
        "calibration": calibration,
        "source": earth_url,
    }
    print(json.dumps(sidecar, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    # 调用方超时/取消时发 SIGTERM 给整个进程组。默认 SIGTERM 会直接终止解释器，
    # `finally: browser.close()` 来不及跑，Chromium 就变成吃显存的孤儿进程；
    # 这里把它翻译成 SystemExit，让 with/finally 正常收尾（15s 后调用方才 SIGKILL）。
    def _terminate(signum, _frame):
        raise SystemExit(f"terminated by signal {signum}")

    signal.signal(signal.SIGTERM, _terminate)
    signal.signal(signal.SIGINT, _terminate)
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as exc:  # 失败必须说清楚，调用方会把这段话直接给用户看
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
