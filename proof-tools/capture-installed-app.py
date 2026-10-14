#!/usr/bin/env python3
"""Installed-app proof capture driver for openclaw PR #171331 (fixture mode).

Installs the provided before/after debug APKs onto a running emulator and
launches the app's built-in screenshot fixture mode — the same mechanism
scripts/android-screenshots.sh uses for store screenshots — so the production
screens render with deterministic connected-gateway state. Then drives the real
installed-app UI (uiautomator + input tap) to capture the Health and Dreaming
status cards at normal scale and in the narrow localized large-font case
(fr-FR app locale, 2.0 font scale, 640x1360 @ 320dpi).

Usage:
  python3 capture-installed-app.py \
    --before-apk before-main.apk --after-apk after-head.apk \
    --out-dir captures

Requires: adb on PATH, emulator booted (emulator-5554).
"""
import argparse
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

APP_PACKAGE = "ai.openclaw.app.debug"
ACTIVITY = f"{APP_PACKAGE}/ai.openclaw.app.MainActivity"
SERIAL = "emulator-5554"

# EN + fr-FR variants (labels are translated at runtime via apps/.i18n/native/fr.json).
HEALTH_LABELS = ["Diagnostics and logs", "Diagnostics et journaux"]
DREAMING_LABELS = ["Dreaming", "Rêve en cours"]
SIDEBAR_LABELS = ["Show Sidebar", "Afficher la barre latérale"]
PAGES_MENU_LABELS = ["Edit pinned items", "Modifier les éléments épinglés"]
HEALTH_MARKERS = ["Phone Node", "Nœud du téléphone"]
DREAMING_MARKERS = ["Memory Store", "Stockage de la mémoire"]


def adb(*args, timeout=120):
    cmd = ["adb", "-s", SERIAL, *args]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return ""
    if r.returncode != 0:
        sys.stderr.write(f"adb {args} rc={r.returncode}: {r.stderr[:300]}\n")
    return r.stdout


def adb_raw(*args, timeout=180):
    cmd = ["adb", "-s", SERIAL, *args]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return r.stdout
    except subprocess.TimeoutExpired:
        return b""


def log(msg):
    print(f"[capture {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def dump_xml():
    out = adb("exec-out", "uiautomator", "dump", "/dev/tty", timeout=90)
    s = out.find("<hierarchy")
    e = out.rfind("</hierarchy>")
    if s >= 0 and e > s:
        return out[s : e + len("</hierarchy>")]
    return ""


def parse_tree(xml):
    try:
        return ET.fromstring(xml)
    except ET.ParseError:
        return None


def bounds_of(node):
    m = re.findall(r"-?\d+", node.get("bounds", ""))
    if len(m) != 4:
        return None
    x1, y1, x2, y2 = map(int, m)
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def label_of(node):
    return f"{node.get('text', '')}||{node.get('content-desc', '')}".lower()


def find_nodes(root, label):
    needle = label.lower()
    return [n for n in root.iter("node") if needle in label_of(n)]


def center_of(node):
    b = bounds_of(node)
    if not b:
        return None
    return ((b[0] + b[2]) // 2, (b[1] + b[3]) // 2)


def screencap(path):
    data = adb_raw("exec-out", "screencap", "-p")
    Path(path).write_bytes(data)
    return len(data)


def save_dump(out_dir, name, xml=None):
    xml = xml if xml is not None else dump_xml()
    if xml:
        (out_dir / f"{name}.xml").write_text(xml, encoding="utf-8")
    return xml


def tap(x, y, wait=1.5):
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(wait)


def screen_size():
    """Current logical screen size (honors `wm size` override)."""
    out = adb("shell", "wm", "size")
    sizes = re.findall(r"(\d+)x(\d+)", out)
    if not sizes:
        return (1080, 1920)
    w, h = map(int, sizes[-1])  # Override size comes after Physical size
    return (w, h)


def scroll_down():
    w, h = screen_size()
    adb("shell", "input", "swipe", str(w // 2), str(int(h * 0.78)), str(w // 2), str(int(h * 0.3)), "300")
    time.sleep(1.2)


def scroll_up():
    w, h = screen_size()
    adb("shell", "input", "swipe", str(w // 2), str(int(h * 0.3)), str(w // 2), str(int(h * 0.85)), "300")
    time.sleep(1.0)


def scroll_to_top_find(out_dir, step, labels, max_scrolls=10):
    """Scroll the list toward the top until any of `labels` is visible."""
    for _ in range(max_scrolls + 1):
        xml = dump_xml()
        root = parse_tree(xml)
        if root is not None:
            found, _ = find_any(root, labels)
            if found:
                return True
        scroll_up()
    save_dump(out_dir, f"fail-scrolltop-{step}")
    screencap(out_dir / f"fail-scrolltop-{step}.png")
    log(f"scroll_to_top_find FAILED: {labels} (step {step})")
    return False


def find_any(root, labels):
    for label in labels:
        nodes = find_nodes(root, label)
        if nodes:
            return label, nodes
    return None, []


def wait_label(out_dir, step, labels, timeout=90, scroll=False, max_scrolls=8):
    """Wait until any of `labels` appears; optionally scroll the list to reveal it."""
    if isinstance(labels, str):
        labels = [labels]
    deadline = time.time() + timeout
    scrolls = 0
    last_xml = ""
    while time.time() < deadline:
        xml = dump_xml()
        last_xml = xml
        root = parse_tree(xml)
        if root is not None:
            found, _ = find_any(root, labels)
            if found:
                return True
        if scroll and scrolls < max_scrolls:
            scroll_down()
            scrolls += 1
            continue
        time.sleep(2)
    save_dump(out_dir, f"fail-wait-{step}", last_xml)
    screencap(out_dir / f"fail-wait-{step}.png")
    log(f"wait_label FAILED: {labels} (step {step})")
    return False


def tap_label(out_dir, step, labels, timeout=90, scroll=True):
    """Wait for any of `labels`, then tap it (prefer clickable ancestor)."""
    if isinstance(labels, str):
        labels = [labels]
    if not wait_label(out_dir, step, labels, timeout=timeout, scroll=scroll):
        return False
    xml = dump_xml()
    root = parse_tree(xml)
    if root is None:
        return False
    _, nodes = find_any(root, labels)
    parent_map = {c: p for p in root.iter() for c in p}
    for node in nodes:
        # nearest clickable ancestor (including self)
        cur = node
        while cur is not None:
            if cur.get("clickable") == "true":
                c = center_of(cur)
                if c:
                    log(f"tap_label[{step}]: {labels} clickable ancestor at {c}")
                    tap(*c, wait=2.0)
                    return True
            cur = parent_map.get(cur)
    for node in nodes:
        c = center_of(node)
        if c:
            log(f"tap_label[{step}]: {labels} text node at {c}")
            tap(*c, wait=2.0)
            return True
    return False


def launch_fixture_scene(scene="settings"):
    adb("shell", "am", "force-stop", APP_PACKAGE)
    time.sleep(1.5)
    adb("shell", "input", "keyevent", "224")
    adb("shell", "wm", "dismiss-keyguard")
    out = adb(
        "shell", "am", "start", "-W", "-n", ACTIVITY,
        "--ez", "openclaw.screenshotMode", "true",
        "--es", "openclaw.screenshotScene", scene,
        timeout=180,
    )
    last = out.strip().splitlines()[-1] if out.strip() else "no output"
    log(f"am start ({scene}): {last}")
    time.sleep(3)


def go_back(wait=1.5):
    adb("shell", "input", "keyevent", "4")
    time.sleep(wait)


def capture_health(out_dir, tag):
    if not tap_label(out_dir, f"health-nav-{tag}", HEALTH_LABELS):
        return False
    if not wait_label(out_dir, f"health-screen-{tag}", HEALTH_MARKERS, timeout=60):
        return False
    time.sleep(2.5)  # let status rows and fixture RPCs settle
    save_dump(out_dir, f"ui-health-{tag}")
    n = screencap(out_dir / f"health-{tag}.png")
    log(f"captured health-{tag}.png ({n} bytes)")
    return n > 10000


def capture_dreaming(out_dir, tag):
    """Dreaming is a sidebar page hidden from the default page list. Open the
    sidebar, open the Pages dropdown ('Edit pinned items' button navigates all
    destinations), and pick Dreaming from the dropdown menu."""
    if not scroll_to_top_find(out_dir, f"sidebar-{tag}", SIDEBAR_LABELS):
        return False
    if not tap_label(out_dir, f"sidebar-{tag}", SIDEBAR_LABELS, timeout=30, scroll=False):
        return False
    if not tap_label(out_dir, f"pages-menu-{tag}", PAGES_MENU_LABELS, timeout=30, scroll=False):
        return False
    if not tap_label(out_dir, f"dreaming-nav-{tag}", DREAMING_LABELS, timeout=30):
        return False
    if not wait_label(out_dir, f"dreaming-screen-{tag}", DREAMING_MARKERS, timeout=60):
        return False
    time.sleep(2.5)
    save_dump(out_dir, f"ui-dreaming-{tag}")
    n = screencap(out_dir / f"dreaming-{tag}.png")
    log(f"captured dreaming-{tag}.png ({n} bytes)")
    return n > 10000


def apply_narrow_fr_2x():
    adb("shell", "cmd", "locale", "set-app-locales", APP_PACKAGE, "--locales", "fr-FR")
    adb("shell", "settings", "put", "system", "font_scale", "2.0")
    adb("shell", "wm", "size", "640x1360")
    adb("shell", "wm", "density", "320")
    time.sleep(3)


def reset_display():
    adb("shell", "settings", "put", "system", "font_scale", "1.0")
    adb("shell", "wm", "size", "reset")
    adb("shell", "wm", "density", "reset")
    adb("shell", "cmd", "locale", "set-app-locales", APP_PACKAGE, "--locales", "en-US")
    time.sleep(3)


def capture_set(apk_path, label, out_dir):
    log(f"=== capture set: {label} ({apk_path}) ===")
    out = adb("install", "-r", str(apk_path), timeout=900)
    last = out.strip().splitlines()[-1] if out.strip() else "no output"
    log(f"install {label}: {last}")
    if "Success" not in out:
        (out_dir / f"install-fail-{label}.txt").write_text(out, encoding="utf-8")
        return False

    ok = True

    # Normal-scale captures: settings home -> Health, back -> sidebar -> Dreaming.
    launch_fixture_scene("settings")
    if not wait_label(out_dir, f"settings-home-{label}", HEALTH_LABELS, timeout=120, scroll=True):
        return False
    if capture_health(out_dir, f"{label}-normal"):
        go_back()
        wait_label(out_dir, f"back-to-settings-{label}", HEALTH_LABELS, timeout=45, scroll=True)
    else:
        ok = False
    if not capture_dreaming(out_dir, f"{label}-normal"):
        ok = False

    # Narrow localized large-font captures (fr-FR, 2x font scale, 640x1360@320).
    apply_narrow_fr_2x()
    log(f"narrow display: {adb('shell', 'wm size').strip()} density={adb('shell', 'wm density').strip()}")
    launch_fixture_scene("settings")
    if wait_label(out_dir, f"settings-home-narrow-{label}", HEALTH_LABELS, timeout=120, scroll=True):
        if capture_health(out_dir, f"{label}-narrow-fr-2x"):
            go_back()
            wait_label(out_dir, f"back-to-settings-narrow-{label}", HEALTH_LABELS, timeout=45, scroll=True)
        else:
            ok = False
        if not capture_dreaming(out_dir, f"{label}-narrow-fr-2x"):
            ok = False
    else:
        ok = False
    reset_display()
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before-apk", required=True)
    ap.add_argument("--after-apk", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Deterministic capture environment: no animations, screen stays on.
    adb("shell", "settings", "put", "global", "window_animation_scale", "0")
    adb("shell", "settings", "put", "global", "transition_animation_scale", "0")
    adb("shell", "settings", "put", "global", "animator_duration_scale", "0")
    adb("shell", "svc", "power", "stayon", "true")

    ok_before = capture_set(args.before_apk, "before", out_dir)
    ok_after = capture_set(args.after_apk, "after", out_dir)

    files = sorted(p.name for p in out_dir.glob("*.png"))
    log(f"captures: {files}")
    expected = {
        f"{kind}-{phase}-{variant}.png"
        for kind in ("health", "dreaming")
        for phase in ("before", "after")
        for variant in ("normal", "narrow-fr-2x")
    }
    missing = sorted(expected - set(files))
    if missing:
        log(f"MISSING captures: {missing}")
    log(f"before ok={ok_before} after ok={ok_after}")
    if ok_before and ok_after and not missing:
        log("ALL CAPTURES COMPLETE")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
