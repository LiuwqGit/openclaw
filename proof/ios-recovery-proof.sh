#!/usr/bin/env bash
# Evidence harness for openclaw/openclaw#191474 (issue #191449).
#
# Upstream gates every Apple *test* lane behind !ordinaryPullRequest, so a fork
# pull_request compiles the iOS sources (Periphery build-for-testing) but never
# executes them. This script executes the regression the PR adds on a real iOS
# simulator three ways:
#
#   1. at the PR head                                        -> expected GREEN
#   2. with main's screen-wide lock placement re-applied      -> expected RED
#   3. with main's unmodified ChatProTab.swift                -> expected build failure
#
# It lives only on this evidence branch and is not part of the PR diff.
set -uo pipefail

RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"
GITHUB_ENV="${GITHUB_ENV:-/dev/null}"
GITHUB_PATH="${GITHUB_PATH:-/dev/null}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HEAD_SHA="${HEAD_SHA:?}"
BASE_SHA="${BASE_SHA:?}"
CHANGED_SOURCE="${CHANGED_SOURCE:-apps/ios/Sources/Design/ChatProTab.swift}"
TEST_SELECTOR="${TEST_SELECTOR:--only-testing:OpenClawTests/ChatProTabRecoveryControlsTests}"
UPSTREAM_RAW="${UPSTREAM_RAW:-https://raw.githubusercontent.com/openclaw/openclaw}"
PROOF_DIR="${PROOF_DIR:-$RUNNER_TEMP/proof}"
DERIVED_DATA="${DERIVED_DATA:-$RUNNER_TEMP/DerivedData}"

mkdir -p "$PROOF_DIR"

log() { printf '\n=== %s ===\n' "$*"; }
note() { printf '%s\n' "$*" | tee -a "$PROOF_DIR/summary.txt"; }

xcodebuild_run() {
  local action="$1"
  local log_path="$2"
  shift 2
  xcodebuild \
    -project apps/ios/OpenClaw.xcodeproj \
    -scheme OpenClaw \
    -configuration Debug \
    -destination "platform=iOS Simulator,id=${IOS_SIMULATOR_ID:?}" \
    -derivedDataPath "$DERIVED_DATA" \
    CODE_SIGNING_ALLOWED=NO \
    CODE_SIGNING_REQUIRED=NO \
    CODE_SIGN_IDENTITY= \
    COMPILER_INDEX_STORE_ENABLE=NO \
    ARCHS=arm64 \
    ONLY_ACTIVE_ARCH=YES \
    "$@" \
    "$action" 2>&1 | tee "$log_path"
  return "${PIPESTATUS[0]}"
}

# ---------------------------------------------------------------- host report
log "Host, Xcode and simulator inventory"
sw_vers || true
uname -a
ls -d /Applications/Xcode*.app 2>/dev/null || true
newest_xcode="$(ls -d /Applications/Xcode*.app 2>/dev/null | sort -V | tail -1)"
if [[ -n "$newest_xcode" ]]; then
  sudo xcode-select -s "$newest_xcode/Contents/Developer" || true
fi
xcode-select -p
xcodebuild -version | tee "$PROOF_DIR/toolchain.txt"
swift --version 2>&1 | tee -a "$PROOF_DIR/toolchain.txt"
{
  echo "xcrun simctl list runtimes"
  xcrun simctl list runtimes
  echo
  echo "xcrun simctl list devices available"
  xcrun simctl list devices available
} > "$PROOF_DIR/simulator-inventory.txt" 2>&1
cat "$PROOF_DIR/simulator-inventory.txt"
note "host: $(sw_vers -productVersion 2>/dev/null || uname -r) / $(xcodebuild -version | paste -sd ' ' -)"
note "head proven: $(git rev-parse HEAD) (PR head $HEAD_SHA)"

# ------------------------------------------------------------- node and pnpm
log "Node and pnpm"
node --version
if ! command -v pnpm >/dev/null 2>&1; then
  corepack enable || npm install --global pnpm@12.15.0
  corepack prepare pnpm@12.15.0 --activate || npm install --global pnpm@12.15.0
fi
pnpm --version

log "Native asset dependencies (mermaid renderer, gateway protocol)"
CI=true pnpm install --frozen-lockfile --prefer-offline --optional \
  --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...' \
  --config.ignore-scripts=false \
  --config.engine-strict=false \
  --config.enable-pre-post-scripts=true \
  --config.side-effects-cache=true 2>&1 | tail -30

log "xcodegen and the pinned Swift tools"
tools_dir="$RUNNER_TEMP/openclaw-swift-tools"
./scripts/install-xcodegen.sh "$tools_dir"
./scripts/install-swift-tools.sh "$tools_dir"
echo "$tools_dir" >> "$GITHUB_PATH"
export PATH="$tools_dir:$PATH"
xcodegen --version
swiftformat --version
swiftlint version 2>&1 | head -2

# The watch app target builds the WatchRTC Rust static libraries. This job proves
# ChatProTab's rendered interaction lock, not the companion watch app, and a fork
# runner has no WatchRTC cargo cache. Nothing else is touched: ChatProTab.swift,
# the regression and every other source stay byte-identical to the PR head.
log "Drop the embedded watch app from the generated project (harness only)"
python3 - <<'PY' | tee "$PROOF_DIR/project-patch.txt"
import pathlib
import sys

spec = pathlib.Path("apps/ios/project.yml")
text = spec.read_text()
marker = "\ntargets:\n  OpenClaw:\n    type: application\n"
start = text.index(marker)
end = text.index("\n  OpenClawShareExtension:", start)
block = text[start:end]
dependency = "      - target: OpenClawWatchApp\n"
count = block.count(dependency)
if count != 1:
    sys.exit(f"expected exactly one watch dependency in the OpenClaw target, found {count}")
spec.write_text(text[:start] + block.replace(dependency, "") + text[end:])
print("removed the OpenClawWatchApp dependency from the OpenClaw target")
PY
if [[ ! -s "$PROOF_DIR/project-patch.txt" ]]; then
  echo "::error::watch dependency removal did not apply"
  exit 1
fi
git --no-pager diff -- apps/ios/project.yml | tee "$PROOF_DIR/project-yml.patch"

log "Signing, version, Swift file list and xcodegen"
./scripts/ios-configure-signing.sh || echo "::warning::signing configuration reported a problem"
./scripts/ios-write-version-xcconfig.sh
node scripts/ios-write-swift-filelist.mjs
(cd apps/ios && xcodegen generate)

log "Select and boot an iOS simulator (deployment target iOS 26.2)"
IOS_SIMULATOR_ID="$(python3 - <<'PY'
import json, re, subprocess, sys

listing = json.loads(subprocess.run(
    ["xcrun", "simctl", "list", "devices", "available", "--json"],
    check=True, capture_output=True, text=True).stdout)


def version(runtime):
    match = re.search(r"iOS-(\d+)[-.](\d+)", runtime)
    return tuple(int(part) for part in match.groups()) if match else (0, 0)


candidates = []
for runtime, devices in listing.get("devices", {}).items():
    if "iOS" not in runtime or version(runtime) < (26, 2):
        continue
    for device in devices:
        if device.get("isAvailable") and device.get("name", "").startswith("iPhone"):
            candidates.append((version(runtime), device["name"], device["udid"]))
if not candidates:
    sys.exit("no available iPhone simulator with an iOS 26.2+ runtime")
candidates.sort(reverse=True)
print(candidates[0][2])
PY
)"
export IOS_SIMULATOR_ID
if [[ -z "$IOS_SIMULATOR_ID" ]]; then
  echo "::error::no usable iOS simulator"
  exit 1
fi
echo "IOS_SIMULATOR_ID=$IOS_SIMULATOR_ID" >> "$GITHUB_ENV"
note "simulator: $IOS_SIMULATOR_ID ($(xcrun simctl list devices | grep -F "$IOS_SIMULATOR_ID" | head -1 | tr -s ' '))"
xcrun simctl bootstatus "$IOS_SIMULATOR_ID" -b

log "Build the app and the test bundle for testing (PR head)"
build_status=0
xcodebuild_run build-for-testing "$PROOF_DIR/build-head.log" -showBuildTimingSummary || build_status=$?
if [[ "$build_status" -ne 0 ]]; then
  note "RESULT head build: FAILED (exit $build_status)"
  grep -n "error:" "$PROOF_DIR/build-head.log" | head -40
  exit "$build_status"
fi
note "RESULT head build-for-testing: SUCCEEDED"

log "Execute the regression at the PR head (expected GREEN)"
green_status=0
xcodebuild_run test-without-building "$PROOF_DIR/test-head-green.log" \
  -resultBundlePath "$PROOF_DIR/head-green.xcresult" \
  -parallel-testing-enabled NO \
  -collect-test-diagnostics never \
  "$TEST_SELECTOR" || green_status=$?
grep -E "Test Suite|Test Case|passed|failed" "$PROOF_DIR/test-head-green.log" | tail -30
if [[ "$green_status" -eq 0 ]]; then
  note "RESULT head execution: GREEN (xcodebuild exit 0)"
else
  note "RESULT head execution: FAILED (xcodebuild exit $green_status) — the regression did not pass at the PR head"
fi

log "Re-apply main's screen-wide lock placement and re-execute (expected RED)"
python3 - <<'PY' | tee "$PROOF_DIR/behaviour-revert.txt"
import pathlib
import sys

source = pathlib.Path("apps/ios/Sources/Design/ChatProTab.swift")
text = source.read_text()
anchor = "    var body: some View {\n        self.content\n"
if text.count(anchor) != 1:
    sys.exit("body/content anchor not found exactly once")
source.write_text(text.replace(anchor, anchor + "            .disabled(self.isChatMutationLocked)\n", 1))
print("re-applied main's screen-wide .disabled placement with the unchanged lock expression")
PY
git --no-pager diff -- "$CHANGED_SOURCE" | tee "$PROOF_DIR/behaviour-revert.patch"

reverted_build=0
xcodebuild_run build-for-testing "$PROOF_DIR/build-reverted.log" || reverted_build=$?
if [[ "$reverted_build" -ne 0 ]]; then
  note "RESULT behaviour-reverted build: FAILED (exit $reverted_build)"
  grep -n "error:" "$PROOF_DIR/build-reverted.log" | head -40
else
  red_status=0
  xcodebuild_run test-without-building "$PROOF_DIR/test-reverted-red.log" \
    -resultBundlePath "$PROOF_DIR/reverted-red.xcresult" \
    -parallel-testing-enabled NO \
    -collect-test-diagnostics never \
    "$TEST_SELECTOR" || red_status=$?
  grep -E "Test Suite|Test Case|passed|failed|XCTAssert" "$PROOF_DIR/test-reverted-red.log" | tail -40
  if [[ "$red_status" -eq 0 ]]; then
    note "RESULT behaviour-reverted execution: UNEXPECTEDLY GREEN — the regression does not discriminate the fix"
  else
    note "RESULT behaviour-reverted execution: RED (xcodebuild exit $red_status), as required"
  fi
fi
git checkout -- "$CHANGED_SOURCE"

log "Prove the regression does not compile against unmodified main"
curl --fail --location --no-progress-meter --show-error \
  --output "$PROOF_DIR/ChatProTab.main.swift" \
  "$UPSTREAM_RAW/$BASE_SHA/$CHANGED_SOURCE"
cp "$PROOF_DIR/ChatProTab.main.swift" "$CHANGED_SOURCE"
base_status=0
xcodebuild_run build-for-testing "$PROOF_DIR/build-base-source.log" || base_status=$?
git checkout -- "$CHANGED_SOURCE"
if [[ "$base_status" -eq 0 ]]; then
  note "RESULT main-source build: UNEXPECTEDLY SUCCEEDED (no compile-level RED evidence)"
else
  note "RESULT main-source build: FAILED (exit $base_status) — the regression cannot build against main"
  grep -n "error:" "$PROOF_DIR/build-base-source.log" | head -20 | tee -a "$PROOF_DIR/summary.txt"
fi

log "Export the rendered attachments from the green result bundle"
bundle="$PROOF_DIR/head-green.xcresult"
attachments="$PROOF_DIR/attachments"
mkdir -p "$attachments"
if [[ -e "$bundle" ]]; then
  if xcrun xcresulttool export attachments --path "$bundle" --output-path "$attachments" \
    > "$PROOF_DIR/attachment-export.log" 2>&1; then
    note "attachment export: 'xcresulttool export attachments'"
  else
    echo "::warning::'xcresulttool export attachments' unavailable, falling back to per-reference export"
    python3 - "$bundle" "$attachments" <<'PY' 2>&1 | tee -a "$PROOF_DIR/attachment-export.log"
import json, pathlib, subprocess, sys

bundle, out = sys.argv[1], pathlib.Path(sys.argv[2])
payload = json.loads(subprocess.run(
    ["xcrun", "xcresulttool", "get", "--path", bundle, "--legacy", "--format", "json"],
    check=True, capture_output=True, text=True).stdout)
references = []


def walk(node):
    if isinstance(node, dict):
        payload_ref = node.get("payloadRef")
        if isinstance(payload_ref, dict) and payload_ref.get("id"):
            name = node.get("name", {})
            label = name.get("_value") if isinstance(name, dict) else None
            references.append((str(label or "attachment"), payload_ref["id"]))
        for value in node.values():
            walk(value)
    elif isinstance(node, list):
        for value in node:
            walk(value)


walk(payload)
print(f"found {len(references)} payload references")
for index, (name, identifier) in enumerate(references):
    safe = "".join(character if character.isalnum() or character in "-_." else "_" for character in name)
    target = out / f"{index:03d}-{safe}"
    subprocess.run(["xcrun", "xcresulttool", "export", "--path", bundle,
                    "--id", identifier, "--output-path", str(target)], check=False)
PY
    note "attachment export: per-reference fallback"
  fi
else
  echo "::warning::no green result bundle to export"
fi
find "$attachments" -type f | sort | tee "$PROOF_DIR/attachment-index.txt"

log "Summary"
cat "$PROOF_DIR/summary.txt"
if grep -q "RESULT head execution: GREEN" "$PROOF_DIR/summary.txt" &&
  grep -q "RESULT behaviour-reverted execution: RED" "$PROOF_DIR/summary.txt"; then
  note "OVERALL: the regression executes GREEN at the PR head and RED with main's lock placement"
  exit 0
fi
note "OVERALL: incomplete — see the RESULT lines above"
exit 1
