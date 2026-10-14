#!/usr/bin/env python3
"""Installed-app proof capture driver for openclaw PR #171331.

Builds nothing itself: installs the provided before/after APKs onto a running
Android emulator, pairs the app with a local openclaw gateway, then drives the
real UI to capture Health and Dreaming screens (normal + narrow fr 2x case).

Usage:
  python3 capture-installed-app.py \
    --before-apk before-main.apk --after-apk after-head.apk \
    --out-dir captures --gateway-url ws://127.0.0.1:18790

Requires: adb on PATH, emulator booted (emulator-5554), gateway token in
GATEWAY_TOKEN env var, `adb reverse tcp:18790 tcp:18790` already applied.
"""
import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path

APP_PACKAGE = "ai.openclaw.app.debug"
ACTIVITY = f"{APP_PACKAGE}/ai.openclaw.app.MainActivity"
SERIAL = "emulator-5554"
GATEWAY_PORT = 18790


def adb(*args, timeout=90, check=False):
    cmd = ["adb", "-s", SERIAL, *args]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return ""
    if check and r.returncode != 0:
        sys.stderr.write(f"adb {args} rc={r.returncode}: {r.stderr[:200]}\n")
    return r.stdout


def dump_xml(timeout=60):
    out = adb("exec-out", "uiautomator", "dump", "/dev/tty", timeout=timeout)
    m = re.search(r"<hierarchy.*</hierarchy>", out, re.S)
    return m.group(0) if m else ""


def nodes(xml):
    result = []
    for m in re.finditer(r"<node[^>]*>", xml):
        tag = m.group(0)

        def attr(name):
            mm = re.search(rf'{name}="([^"]*)"', tag)
            return mm.group(1) if mm else ""

        bm = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', tag)
        if not bm:
            continue
        x1, y1, x2, y2 = map(int, bm.groups())
        if x2 <= x1 or y2 <= y1:
            continue
        result.append(
            {
                "text": attr("text"),
                "desc": attr("content-desc"),
                "cls": attr("class"),
                "clickable": attr("clickable") == "true",
                "cx": (x1 + x2) // 2,
                "cy": (y1 + y2) // 2,
                "bounds": (x1, y1, x2, y2),
            }
        )
    return result


def find_nodes(xml, label, contains=True):
    hits = []
    for n in nodes(xml):
        hay = f"{n['text']}||{n['desc']}"
        ok = (contains and label.lower() in hay.lower()) or (
            not contains and label.lower() == hay.lower()
        )
        if ok:
            hits.append(n)
    return hits


def save_dump(out_dir, name, xml=None):
    xml = xml if xml is not None else dump_xml()
    if xml:
        (out_dir / f"{name}.xml").write_text(xml, encoding="utf-8")
    return xml


def tap(x, y, wait=1.2):
    adb("shell", "input", "tap", str(x), str(y))
    time.sleep(wait)


def tap_label(label, out_dir, step, wait=1.2, timeout=45, scroll=False):
    """Tap the first node containing label. Returns True on success."""
    deadline = time.time() + timeout
    last_xml = ""
    while time.time() < deadline:
        xml = dump_xml()
        last_xml = xml
        hits = find_nodes(xml, label)
        if hits:
            tap(hits[0]["cx"], hits[0]["cy"], wait)
            return True
        if scroll:
            adb("shell", "input", "swipe", "540", "1400", "540", "500", "300")
            time.sleep(1.0)
        else:
            time.sleep(2.0)
    save_dump(out_dir, f"fail-tap-{step}", last_xml)
    log(f"tap_label FAILED: '{label}' (step {step})")
    return False


def type_text(text):
    safe = text.replace(" ", "%s").replace("$", "\\$").replace("&", "\\&")
    adb("shell", "input", "text", safe, timeout=60)


def adb_raw(*args, timeout=120):
    """Run adb capturing raw bytes (binary-safe)."""
    cmd = ["adb", "-s", SERIAL, *args]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=timeout)
        return r.stdout
    except subprocess.TimeoutExpired:
        return b""


def screencap(path):
    data = adb_raw("exec-out", "screencap", "-p", timeout=180)
    Path(path).write_bytes(data)
    return len(data)


def log(msg):
    print(f"[capture {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def launch_app():
    adb("shell", "am", "force-stop", APP_PACKAGE)
    time.sleep(1)
    adb("shell", "input", "keyevent", "224")
    adb("shell", "wm", "dismiss-keyguard")
    out = adb("shell", "am", "start", "-W", "-n", ACTIVITY, timeout=120)
    log(f"am start: {out.strip().splitlines()[-1] if out.strip() else 'no output'}")


def open_drawer():
    """Open the navigation drawer (edge swipe fallback)."""
    xml = dump_xml()
    if find_nodes(xml, "Settings") or find_nodes(xml, "Dreaming"):
        return xml
    # menu icon (content-desc often Open/Menu)
    for n in find_nodes(xml, "menu"):
        if n["clickable"] or True:
            tap(n["cx"], n["cy"], wait=1.5)
            xml2 = dump_xml()
            if find_nodes(xml2, "Settings") or find_nodes(xml2, "Dreaming"):
                return xml2
    # edge swipe
    adb("shell", "input", "swipe", "0", "900", "600", "900", "250")
    time.sleep(1.5)
    return dump_xml()


def go_back():
    adb("shell", "input", "keyevent", "4")
    time.sleep(1.2)


def onboard_and_pair(out_dir, gateway_url, token):
    """First-run onboarding: welcome -> connect gateway (manual url+token)."""
    # Welcome screen
    if not tap_label("Welcome to OpenClaw", out_dir, "welcome-wait", timeout=90):
        log("welcome screen not found; assuming app already onboarded")
        return True
    tap_label("Continue", out_dir, "welcome-continue", timeout=30)
    # Connect Gateway screen
    if not tap_label("Connect Gateway", out_dir, "connect-wait", timeout=60):
        save_dump(out_dir, "fail-connect-screen")
        return False
    if not tap_label("Set up manually", out_dir, "manual-entry", timeout=30):
        save_dump(out_dir, "fail-manual-entry")
        return False
    # Gateway URL field
    if not tap_label("Gateway URL", out_dir, "url-field", timeout=30):
        return False
    type_text(gateway_url)
    time.sleep(0.5)
    # Token field
    if not tap_label("Token", out_dir, "token-field", timeout=30):
        return False
    type_text(token)
    time.sleep(0.5)
    if not tap_label("Continue", out_dir, "manual-continue", timeout=30):
        return False
    # Review -> Connect
    if not tap_label("Connect to this gateway?", out_dir, "review-wait", timeout=45):
        save_dump(out_dir, "fail-review")
        return False
    if not tap_label("Connect", out_dir, "connect-tap", timeout=30):
        return False
    # Possible trust dialog
    deadline = time.time() + 30
    while time.time() < deadline:
        xml = dump_xml()
        if find_nodes(xml, "Trust"):
            hits = find_nodes(xml, "Trust")
            tap(hits[0]["cx"], hits[0]["cy"], wait=1.5)
            continue
        if find_nodes(xml, "Connected") or find_nodes(xml, "Overview"):
            break
        # generic onboarding continue/allow buttons
        for label in ("Allow", "Continue", "Skip", "Not now"):
            hits = find_nodes(xml, label, contains=False)
            if hits and hits[0]["clickable"]:
                tap(hits[0]["cx"], hits[0]["cy"], wait=1.5)
                break
        else:
            time.sleep(2.0)
    save_dump(out_dir, "post-pair")
    return True


def wait_connected(out_dir, timeout=120):
    """Wait until the gateway row / home shows a connected gateway."""
    deadline = time.time() + timeout
    saw_waiting = False
    while time.time() < deadline:
        xml = dump_xml()
        if find_nodes(xml, "Connected") or find_nodes(xml, "connected"):
            return True
        if find_nodes(xml, "Waiting") or find_nodes(xml, "Offline"):
            saw_waiting = True
        time.sleep(3)
    save_dump(out_dir, "fail-wait-connected")
    log(f"wait_connected timeout (saw Waiting/Offline: {saw_waiting})")
    return False


def navigate_health(out_dir, narrow=False):
    open_drawer()
    ok = tap_label("Settings", out_dir, "open-settings", timeout=45)
    if not ok:
        return False
    # Health row is titled Health with subtitle "Diagnostics and logs"
    ok = tap_label("Diagnostics and logs", out_dir, "tap-health", timeout=45, scroll=True)
    if not ok:
        ok = tap_label("Health", out_dir, "tap-health-alt", timeout=30, scroll=True)
    if not ok:
        return False
    # Wait for the detailed status card rows
    deadline = time.time() + 90
    while time.time() < deadline:
        xml = dump_xml()
        if find_nodes(xml, "Phone Node") or find_nodes(xml, "Gateway"):
            return True
        time.sleep(2)
    save_dump(out_dir, f"fail-health-screen{'-narrow' if narrow else ''}")
    return False


def navigate_dreaming(out_dir):
    open_drawer()
    ok = tap_label("Dreaming", out_dir, "open-dreaming", timeout=45)
    if not ok:
        return False
    deadline = time.time() + 90
    while time.time() < deadline:
        xml = dump_xml()
        if find_nodes(xml, "Memory Store") or find_nodes(xml, "dream diary"):
            return True
        time.sleep(2)
    save_dump(out_dir, "fail-dreaming-screen")
    return False


def apply_narrow_fr_2x(out_dir):
    # Per-app French locale (AppCompatDelegate-driven app reacts automatically)
    adb("shell", "cmd", "locale", "set-app-locales", APP_PACKAGE, "--locales", "fr-FR")
    adb("shell", "settings", "put", "system", "font_scale", "2.0")
    # 320dp width: 640px @ 320dpi
    adb("shell", "wm", "size", "640x1360")
    adb("shell", "wm", "density", "320")
    time.sleep(4)
    save_dump(out_dir, "narrow-config-applied")
    # force activity recreate for locale/font
    adb("shell", "am", "start", "-W", "-n", ACTIVITY, timeout=60)


def reset_display():
    adb("shell", "settings", "put", "system", "font_scale", "1.0")
    adb("shell", "wm", "size", "reset")
    adb("shell", "wm", "density", "reset")
    adb("shell", "cmd", "locale", "set-app-locales", APP_PACKAGE, "--locales", "en")
    time.sleep(3)


def capture_set(apk_path, label, out_dir, gateway_url, token, skip_pair):
    log(f"=== capture set: {label} ({apk_path}) ===")
    out = adb("install", "-r", str(apk_path), timeout=900)
    log(f"install {label}: {out.strip().splitlines()[-1] if out.strip() else 'no output'}")
    if "Success" not in out:
        save_str(out_dir, f"install-fail-{label}.txt", out)
        return False
    launch_app()
    if not skip_pair:
        if not onboard_and_pair(out_dir, gateway_url, token):
            return False
        if not wait_connected(out_dir):
            log("gateway did not connect; continuing but captures may show offline rows")
    else:
        time.sleep(6)
        if not wait_connected(out_dir, timeout=60):
            log("gateway not connected after relaunch; re-checking")
            launch_app()
            wait_connected(out_dir, timeout=60)

    ok = True
    # 1. Health normal
    if navigate_health(out_dir):
        time.sleep(2)
        xml = save_dump(out_dir, f"ui-health-{label}-normal")
        screencap(out_dir / f"health-{label}-normal.png")
        log(f"captured health-{label}-normal.png")
    else:
        ok = False
    # 2. Dreaming normal
    go_back()
    if navigate_dreaming(out_dir):
        time.sleep(2)
        save_dump(out_dir, f"ui-dreaming-{label}-normal")
        screencap(out_dir / f"dreaming-{label}-normal.png")
        log(f"captured dreaming-{label}-normal.png")
    else:
        ok = False
    # 3. Health narrow fr 2x
    go_back()
    apply_narrow_fr_2x(out_dir)
    if navigate_health(out_dir, narrow=True):
        time.sleep(2)
        save_dump(out_dir, f"ui-health-{label}-narrow")
        screencap(out_dir / f"health-{label}-narrow-fr-2x.png")
        log(f"captured health-{label}-narrow-fr-2x.png")
    else:
        ok = False
    reset_display()
    launch_app()
    time.sleep(4)
    return ok


def save_str(out_dir, name, content):
    (out_dir / name).write_text(content, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--before-apk", required=True)
    ap.add_argument("--after-apk", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--gateway-url", default=f"ws://127.0.0.1:{GATEWAY_PORT}")
    args = ap.parse_args()

    token = os.environ.get("GATEWAY_TOKEN", "")
    if not token:
        sys.exit("GATEWAY_TOKEN env var required")
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # sanity: adb reverse applied?
    rev = adb("reverse", "--list")
    log(f"adb reverse: {rev.strip()!r}")

    ok_before = capture_set(args.before_apk, "before", out_dir, args.gateway_url, token, skip_pair=False)
    ok_after = capture_set(args.after_apk, "after", out_dir, args.gateway_url, token, skip_pair=True)

    # summary
    files = sorted(p.name for p in out_dir.glob("*.png"))
    log(f"captures: {files}")
    log(f"before ok={ok_before} after ok={ok_after}")
    if ok_before and ok_after and len(files) >= 6:
        log("ALL CAPTURES COMPLETE")
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
