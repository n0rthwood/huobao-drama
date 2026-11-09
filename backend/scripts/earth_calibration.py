"""Pixel-grounded Earth registration. No terrain/projection assumptions are accepted as proof.

A capture-only KMZ draws centered, fixed-size magenta icons on a 33x33 geographic grid
and 32x32 independent cell centers. Actual screenshot pixels determine the grid;
withheld centers must agree with bilinear interpolation within 3px or capture fails.
The user's deliverable KMZ is not modified.
"""
from __future__ import annotations

import hashlib
import io
import math
import zipfile
from pathlib import Path

GRID_NODES = 33
MAX_RESIDUAL_PX = 3.0


def build_controls(bbox):
    west, south, east, north = bbox
    controls = []
    for row in range(GRID_NODES):
        for col in range(GRID_NODES):
            controls.append({"kind": "grid", "row": row, "col": col,
                             "lon": west + (east - west) * col / (GRID_NODES - 1),
                             "lat": north - (north - south) * row / (GRID_NODES - 1)})
    for row in range(GRID_NODES - 1):
        for col in range(GRID_NODES - 1):
            controls.append({"kind": "validation", "row": row, "col": col,
                             "lon": west + (east - west) * (col + .5) / (GRID_NODES - 1),
                             "lat": north - (north - south) * (row + .5) / (GRID_NODES - 1)})
    return controls


def write_calibration_kmz(controls, output: Path):
    from PIL import Image
    icon = io.BytesIO()
    Image.new("RGBA", (11, 11), (255, 0, 255, 255)).save(icon, "PNG")
    kml = ('<?xml version="1.0" encoding="UTF-8"?>'
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Pixel calibration</name>'
           '<Style id="calibration"><IconStyle><scale>1</scale><Icon><href>fiducial.png</href></Icon>'
           '<hotSpot x="0.5" y="0.5" xunits="fraction" yunits="fraction"/></IconStyle>'
           '<LabelStyle><scale>0</scale></LabelStyle></Style>'
           '<Folder><name>Pixel calibration controls</name>')
    for control in controls:
        kml += ('<Placemark><styleUrl>#calibration</styleUrl><Point><altitudeMode>clampToGround</altitudeMode>'
                f'<coordinates>{control["lon"]:.12f},{control["lat"]:.12f},0</coordinates>'
                '</Point></Placemark>')
    kml += '</Folder></Document></kml>'
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, data in (("doc.kml", kml.encode()), ("fiducial.png", icon.getvalue())):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(entry, data)
    return hashlib.sha256(output.read_bytes()).hexdigest()


def detect_centers(screenshot: Path):
    from PIL import Image, ImageChops
    image = Image.open(screenshot).convert("RGB")
    red, green, blue = image.split()
    high = [0] * 211 + [255] * 45
    low = [255] * 65 + [0] * 191
    mask = ImageChops.multiply(ImageChops.multiply(red.point(high), blue.point(high)), green.point(low))
    width, height = image.size
    pixels = mask.tobytes()
    remaining = {index for index, value in enumerate(pixels) if value}
    centers = []
    while remaining:
        start = remaining.pop()
        queue, members = [start], [start]
        while queue:
            current = queue.pop()
            x, y = current % width, current // width
            neighbors = []
            if x > 0: neighbors.append(current - 1)
            if x + 1 < width: neighbors.append(current + 1)
            if y > 0: neighbors.append(current - width)
            if y + 1 < height: neighbors.append(current + width)
            for neighbor in neighbors:
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    queue.append(neighbor)
                    members.append(neighbor)
        xs, ys = [index % width for index in members], [index // width for index in members]
        # Earth normalizes this local 11px icon to 32×32 screen pixels (actual capture:
        # all 545 components were exactly 1024 pixels). The former 900-pixel area cap
        # rejected every correctly rendered control before any coordinate validation.
        # This is an icon-shape bound, NOT the independent <=3px registration tolerance.
        if 16 <= len(members) <= 32 * 32 and 4 <= max(xs) - min(xs) + 1 <= 32 and 4 <= max(ys) - min(ys) + 1 <= 32:
            centers.append([sum(xs) / len(xs), sum(ys) / len(ys)])
    return centers


def measure_controls(controls, screenshot: Path, camera, window, project):
    centers = detect_centers(screenshot)
    predicted = project([(control["lon"], control["lat"]) for control in controls], camera, window)
    if not all(point[2] for point in predicted):
        raise RuntimeError("Calibration controls cross Earth's horizon; reduce the requested bbox")
    grid_spacing = min(math.hypot(predicted[1][0] - predicted[0][0], predicted[1][1] - predicted[0][1]),
                       math.hypot(predicted[GRID_NODES][0] - predicted[0][0],
                                  predicted[GRID_NODES][1] - predicted[0][1]))
    # Interstitial controls are sqrt(.5) grid-spacing apart. Refuse a possible neighboring association.
    radius = grid_spacing * .32
    if radius < 5:
        raise RuntimeError("Calibration controls are less than 16px apart; increase map width or use a less extreme aspect ratio")
    measured, used = [], set()
    for index, control in enumerate(controls):
        px, py, _ = predicted[index]
        candidates = [(math.hypot(center[0] - px, center[1] - py), ci, center)
                      for ci, center in enumerate(centers) if ci not in used]
        candidates.sort(key=lambda item: item[0])
        if not candidates or candidates[0][0] > radius:
            nearest = candidates[0][0] if candidates else None
            raise RuntimeError(f"Pixel calibration could not uniquely find {control['kind']}[{control['row']},{control['col']}] "
                               f"at predicted ({px:.1f},{py:.1f}); nearest={nearest}, association radius={radius:.1f}px; "
                               "projection/terrain/UI may hide the control, refusing an unregistered screenshot")
        if len(candidates) > 1 and candidates[1][0] <= radius:
            raise RuntimeError(f"Ambiguous pixel fiducial at {control}; refusing to guess")
        distance, ci, center = candidates[0]
        used.add(ci)
        measured.append({**control, "pixel": center, "predicted": [px, py], "model_error_px": distance})
    grid = [control["pixel"] for control in measured if control["kind"] == "grid"]
    errors = []
    for control in measured:
        if control["kind"] != "validation": continue
        row, col = control["row"], control["col"]
        corners = [grid[row * GRID_NODES + col], grid[row * GRID_NODES + col + 1],
                   grid[(row + 1) * GRID_NODES + col], grid[(row + 1) * GRID_NODES + col + 1]]
        expected = [sum(point[axis] for point in corners) / 4 for axis in (0, 1)]
        error = math.hypot(expected[0] - control["pixel"][0], expected[1] - control["pixel"][1])
        control["withheld_error_px"] = error
        errors.append(error)
    maximum = max(errors)
    rms = math.sqrt(sum(error * error for error in errors) / len(errors))
    if maximum > MAX_RESIDUAL_PX:
        raise RuntimeError(f"Actual Earth pixel-grid validation failed: max={maximum:.3f}px rms={rms:.3f}px "
                           f"over {len(errors)} withheld controls (limit {MAX_RESIDUAL_PX}px). "
                           "Do not use this imagery as a registered map; choose program mode or a smaller bbox")
    return {"cols": GRID_NODES, "rows": GRID_NODES, "pixels": grid, "controls": measured,
            "residual_px": {"max": maximum, "rms": rms}, "validation_count": len(errors),
            "tolerance_px": MAX_RESIDUAL_PX, "coordinate_origin": "window-top-left"}
