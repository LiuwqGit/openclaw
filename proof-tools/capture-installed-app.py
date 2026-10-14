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

HEALTH_LABEL = "Diagnostics and logs"
DREAMING_LABEL = "Dreaming"
HEALTH_MARKER = "Phone Node"
DREAMING_MARKER = "Memory Store"


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


def scroll_down():
    adb("shell", "input", "swipe", "540", "1500", "540", "600", "300")
    time.sleep(1.2)


def wait_label(out_dir, step, label, timeout=90, scroll=False, max_scrolls=8):
    """Wait until `label` appears; optionally scroll the list to reveal it."""
    deadline = time.time() + timeout
    scrolls = 0
    last_xml = ""
    while time.time() < deadline:
        xml = dump_xml()
        last_xml = xml
        root = parse_tree(xml)
        if root is not None and find_nodes(root, label):
            return True
        if scroll and scrolls < max_scrolls:
            scroll_down()
            scrolls += 1
            continue
        time.sleep(2)
    save_dump(out_dir, f"fail-wait-{step}", last_xml)
    screencap(out_dir / f"fail-wait-{step}.png")
    log(f"wait_label FAILED: '{label}' (step {step})")
    return False


def tap_label(out_dir, step, label, timeout=90, scroll=True):
    """Wait for `label`, tap it (prefer clickable ancestor), verify it took effect
    by waiting for the screen to change (label's own tap target disappears or a
    caller-provided marker appears via wait_label afterwards)."""
    if not wait_label(out_dir, step, label, timeout=timeout, scroll=scroll):
        return False
    xml = dump_xml()
    root = parse_tree(xml)
    if root is None:
        return False
    nodes = find_nodes(root, label)
    parent_map = {c: p for p in root.iter() for c in p}
    for node in nodes:
        # nearest clickable ancestor (including self)
        cur = node
        while cur is not None:
            if cur.get("clickable") == "true":
                c = center_of(cur)
                if c:
                    log(f"tap_label[{step}]: '{label}' clickable ancestor at {c}")
                    tap(*c, wait=2.0)
                    return True
            cur = parent_map.get(cur)
    for node in nodes:
        c = center_of(node)
        if c:
            log(f"tap_label[{step}]: '{label}' text node at {c}")
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
    if not tap_label(out_dir, f"health-nav-{tag}", HEALTH_LABEL):
        return False
    if not wait_label(out_dir, f"health-screen-{tag}", HEALTH_MARKER, timeout=60):
        return False
    time.sleep(2.5)  # let status rows and fixture RPCs settle
    save_dump(out_dir, f"ui-health-{tag}")
    n = screencap(out_dir / f"health-{tag}.png")
    log(f"captured health-{tag}.png ({n} bytes)")
    return n > 10000


def capture_dreaming(out_dir, tag):
    if not tap_label(out_dir, f"dreaming-nav-{tag}", DREAMING_LABEL):
        return False
    if not wait_label(out_dir, f"dreaming-screen-{tag}", DREAMING_MARKER, timeout=60):
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

    # Normal-scale captures: settings home -> Health, back -> Dreaming.
    launch_fixture_scene("settings")
    if not wait_label(out_dir, f"settings-home-{label}", HEALTH_LABEL, timeout=120, scroll=True):
        return False
    if capture_health(out_dir, f"{label}-normal"):
        go_back()
        wait_label(out_dir, f"back-to-settings-{label}", HEALTH_LABEL, timeout=45, scroll=True)
    else:
        ok = False
    if not capture_dreaming(out_dir, f"{label}-normal"):
        ok = False

    # Narrow localized large-font captures (fr-FR, 2x font scale, 640x1360@320).
    apply_narrow_fr_2x()
    launch_fixture_scene("settings")
    if wait_label(out_dir, f"settings-home-narrow-{label}", HEALTH_LABEL, timeout=120, scroll=True):
        if capture_health(out_dir, f"{label}-narrow-fr-2x"):
            go_back()
            wait_label(out_dir, f"back-to-settings-narrow-{label}", HEALTH_LABEL, timeout=45, scroll=True)
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
