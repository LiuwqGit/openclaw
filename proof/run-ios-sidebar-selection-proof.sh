#!/usr/bin/env bash
# Execute the rendered iOS sidebar-selection regression on a real macOS runner with an iOS
# simulator: once against the candidate head (expected GREEN) and once with the two changed
# production files restored to the pull request's base (expected RED). Attached screenshots are
# exported from both xcresult bundles so the rendered behaviour is inspectable outside Xcode.
# Harness only; it is not part of the pull request.
set -uo pipefail

CANDIDATE_REF="${1:-chore/proof-candidate-192299}"
UPSTREAM_URL="${2:-https://github.com/openclaw/openclaw.git}"
FORK_URL="${FORK_URL:-https://github.com/LiuwqGit/openclaw.git}"
WORKDIR="${RUNNER_TEMP:-/tmp}/ios-sidebar-selection-proof"
OUT="${WORKDIR}/out"
RESULTS="${WORKDIR}/results"
DERIVED="${WORKDIR}/DerivedData"
TEST_CLASS="RootSidebarSelectionRenderTests"
TEST_ID="OpenClawTests/${TEST_CLASS}"
PROJECT="apps/ios/OpenClaw.xcodeproj"
SCHEME="OpenClaw"
CHANGED_SOURCES=(
  "apps/ios/Sources/RootSidebar.swift"
  "apps/ios/Sources/RootSidebarGatewayControl.swift"
)
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

log() {
  printf '\n=== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

# run_logged <label> <logfile> <command...>
run_logged() {
  local label="$1"
  local logfile="$2"
  shift 2
  log "$label"
  "$@" >"$logfile" 2>&1
  local status=$?
  tail -n 60 "$logfile"
  printf -- '--- %s exit=%s log=%s\n' "$label" "$status" "$logfile"
  return "$status"
}

rm -rf "$WORKDIR"
mkdir -p "$OUT" "$RESULTS"
cd "$WORKDIR" || exit 90

log "clone candidate $CANDIDATE_REF"
git clone --quiet --depth 3 --branch "$CANDIDATE_REF" "$FORK_URL" repo || exit 91
cd repo || exit 92
HEAD_SHA="$(git rev-parse HEAD)"
git log --oneline -3
BASE_REF="$(git rev-parse HEAD~2)"
printf 'candidate head %s\nproduction base %s\n' "$HEAD_SHA" "$BASE_REF"
git fetch --quiet --depth 1 "$UPSTREAM_URL" main || true
printf 'upstream main %s\n' "$(git rev-parse FETCH_HEAD 2>/dev/null || echo unavailable)"

log "runner toolchain"
{
  sw_vers
  uname -a
  xcodebuild -version
  swift --version
  node --version
  df -h "$WORKDIR"
  sysctl hw.ncpu hw.memsize
  ls -d /Applications/Xcode*.app 2>/dev/null
} 2>&1 | tee "$OUT/toolchain.txt"

log "install pinned swift tooling"
run_logged "install-xcodegen" "$OUT/install-xcodegen.log" ./scripts/install-xcodegen.sh "$WORKDIR/swift-tools" || exit 93
run_logged "install-swift-tools" "$OUT/install-swift-tools.log" ./scripts/install-swift-tools.sh "$WORKDIR/swift-tools" || exit 93
export PATH="$WORKDIR/swift-tools:$PATH"
xcodegen --version
swiftformat --version
swiftlint version

log "watch rtc rust toolchain"
if [[ -f apps/shared/OpenClawWatchRTC/rust-toolchain.toml ]]; then
  watch_toolchain="$(awk -F '"' '/^channel =/ { print $2; exit }' apps/shared/OpenClawWatchRTC/rust-toolchain.toml)"
  printf 'watch toolchain %s\n' "$watch_toolchain"
  export PATH="$HOME/.cargo/bin:$PATH"
  rustup toolchain install "$watch_toolchain" --profile minimal --component rust-src \
    >"$OUT/rust-toolchain.log" 2>&1
  printf -- '--- rust toolchain exit=%s\n' "$?"
  tail -n 10 "$OUT/rust-toolchain.log"
fi

log "node dependencies for the native protocol generator and the mermaid assets"
npm install --global pnpm@12.15.0 >"$OUT/npm.log" 2>&1 || {
  tail -n 40 "$OUT/npm.log"
  exit 94
}
pnpm --version
pnpm install --frozen-lockfile --prefer-offline --optional \
  --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...' \
  --config.ignore-scripts=false --config.engine-strict=false \
  --config.enable-pre-post-scripts=true --config.side-effects-cache=true \
  >"$OUT/pnpm-install.log" 2>&1
pnpm_status=$?
tail -n 25 "$OUT/pnpm-install.log"
printf -- '--- pnpm install exit=%s\n' "$pnpm_status"
if [[ "$pnpm_status" -ne 0 ]]; then exit 95; fi
run_logged "prepare apple mermaid assets" "$OUT/mermaid.log" node scripts/prepare-apple-mermaid.mjs || exit 96

log "simulator inventory"
xcrun simctl list runtimes 2>&1 | tee "$OUT/simulators-before.txt"
xcrun simctl list devices available 2>&1 | tee -a "$OUT/simulators-before.txt"

select_simulator() {
  xcrun simctl list devices available --json 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin)
devices = data.get("devices", {})
candidates = []
for runtime, entries in devices.items():
    if "iOS" not in runtime:
        continue
    for entry in entries:
        if entry.get("isAvailable") and "iPhone" in entry.get("name", ""):
            candidates.append((runtime, entry["udid"], entry["name"]))
candidates.sort(key=lambda item: (item[0], item[2]))
if candidates:
    print(candidates[-1][1])
'
}

SIM_ID="$(select_simulator)"
if [[ -z "$SIM_ID" ]]; then
  log "no iOS simulator runtime available; downloading the iOS platform"
  xcodebuild -downloadPlatform iOS >"$OUT/download-platform.log" 2>&1
  tail -n 20 "$OUT/download-platform.log"
  SIM_ID="$(select_simulator)"
fi
if [[ -z "$SIM_ID" ]]; then
  echo "No usable iOS simulator on this runner" >&2
  exit 97
fi
printf 'simulator %s\n' "$SIM_ID"
xcrun simctl list devices available 2>&1 | tee "$OUT/simulators-selected.txt" | grep -i "$SIM_ID" || true
xcrun simctl bootstatus "$SIM_ID" -b >"$OUT/simulator-boot.log" 2>&1
printf -- '--- simulator boot exit=%s\n' "$?"
tail -n 10 "$OUT/simulator-boot.log"

log "generate the xcode project"
run_logged "pnpm ios:gen" "$OUT/ios-gen.log" pnpm ios:gen || exit 98

xcodebuild_common=(
  -project "$PROJECT"
  -scheme "$SCHEME"
  -configuration Debug
  -destination "platform=iOS Simulator,id=${SIM_ID}"
  -derivedDataPath "$DERIVED"
  CODE_SIGNING_ALLOWED=NO
  CODE_SIGNING_REQUIRED=NO
  CODE_SIGN_IDENTITY=""
  COMPILER_INDEX_STORE_ENABLE=NO
)

run_suite() {
  local label="$1"
  local bundle="$2"
  xcodebuild "${xcodebuild_common[@]}" -showBuildTimingSummary build-for-testing \
    >"$OUT/build-${label}.log" 2>&1
  local build_status=$?
  tail -n 40 "$OUT/build-${label}.log"
  printf -- '--- %s build-for-testing exit=%s\n' "$label" "$build_status"
  grep -n -E "error:|warning: .*(never used|unused)" "$OUT/build-${label}.log" | head -60 \
    >"$OUT/build-${label}.errors.txt" || true
  # Keep the uploaded artifact readable: retain the tail plus every diagnostic line.
  tail -n 20000 "$OUT/build-${label}.log" >"$OUT/build-${label}.tail.log"
  mv "$OUT/build-${label}.tail.log" "$OUT/build-${label}.log"
  if [[ "$build_status" -ne 0 ]]; then
    cat "$OUT/build-${label}.errors.txt"
    return "$build_status"
  fi
  xcodebuild "${xcodebuild_common[@]}" \
    -resultBundlePath "$bundle" \
    -only-testing:"$TEST_ID" \
    -parallel-testing-enabled NO \
    -collect-test-diagnostics never \
    test-without-building >"$OUT/test-${label}.log" 2>&1
  local test_status=$?
  grep -E "Test Case|Test Suite|passed|failed|error:|\[selection-proof\]" "$OUT/test-${label}.log" | tail -n 80
  printf -- '--- %s test exit=%s\n' "$label" "$test_status"
  return "$test_status"
}

export_attachments() {
  local bundle="$1"
  local destination="$2"
  mkdir -p "$destination"
  xcrun xcresulttool export attachments --path "$bundle" --output-path "$destination" \
    >"$OUT/attachments-$(basename "$destination").log" 2>&1
  if [[ "$?" -ne 0 ]]; then
    xcrun xcresulttool export --path "$bundle" --type attachments --output-path "$destination" \
      >>"$OUT/attachments-$(basename "$destination").log" 2>&1
  fi
  # Last resort: xcresult payloads are stored verbatim, so pick the PNGs out of the bundle.
  if ! find "$destination" -name '*.png' -print -quit | grep -q .; then
    find "$bundle" -type f -print0 2>/dev/null | while IFS= read -r -d '' payload; do
      if [[ "$(head -c 8 "$payload" | xxd -p)" == "89504e470d0a1a0a" ]]; then
        cp "$payload" "$destination/$(basename "$payload").png"
      fi
    done
  fi
  printf 'attachments in %s: %s png file(s)\n' "$destination" "$(find "$destination" -name '*.png' | wc -l | tr -d ' ')"
  find "$destination" -name '*.png' -exec ls -l {} \; | head -30
}

log "head run (candidate $HEAD_SHA)"
run_suite head "$RESULTS/head.xcresult"
head_status=$?
export_attachments "$RESULTS/head.xcresult" "$OUT/head-attachments"
xcrun xcresulttool get test-results summary --path "$RESULTS/head.xcresult" \
  >"$OUT/head-summary.json" 2>/dev/null || true
head -c 2000 "$OUT/head-summary.json" 2>/dev/null || true

log "restore the pull request base for the two changed production files ($BASE_REF)"
git checkout "$BASE_REF" -- "${CHANGED_SOURCES[@]}" || exit 99
git status --short | head -20
git diff --stat | head -20

log "base run (production sources at $BASE_REF, failure expected)"
run_suite base "$RESULTS/base.xcresult"
base_status=$?
export_attachments "$RESULTS/base.xcresult" "$OUT/base-attachments"

log "restore the candidate tree"
git checkout HEAD -- "${CHANGED_SOURCES[@]}" || true

base_kind="unknown"
if grep -q "error:" "$OUT/build-base.log" 2>/dev/null; then
  base_kind="compile-error"
elif grep -Eq "XCTAssert|failed -|Failing tests" "$OUT/test-base.log" 2>/dev/null; then
  base_kind="assertion-failure"
fi
head_kind="unknown"
if [[ "$head_status" -eq 0 ]]; then
  head_kind="passed"
elif grep -q "error:" "$OUT/build-head.log" 2>/dev/null; then
  head_kind="compile-error"
else
  head_kind="assertion-failure"
fi

{
  echo "## iOS sidebar selection proof"
  echo ""
  echo "- runner: $(sw_vers -productVersion 2>/dev/null), $(xcodebuild -version 2>&1 | head -n 1)"
  echo "- simulator: \`$SIM_ID\`"
  echo "- candidate head: \`$HEAD_SHA\` (\`$CANDIDATE_REF\`)"
  echo "- production base: \`$BASE_REF\`"
  echo "- head \`${TEST_ID}\`: exit $head_status ($head_kind)"
  echo "- base \`${TEST_ID}\`: exit $base_status ($base_kind)"
  echo ""
  echo '```text'
  grep -E "Test Case|Test Suite|passed|failed|\[selection-proof\]" "$OUT/test-head.log" 2>/dev/null | tail -n 30
  echo '```'
  echo ""
  echo '```text'
  grep -E "Test Case|Test Suite|passed|failed|XCTAssert|\[selection-proof\]" "$OUT/test-base.log" 2>/dev/null | tail -n 30
  echo '```'
} >>"$SUMMARY"

python3 - "$OUT/result.json" <<JSON
import json, sys
json.dump({
    "candidate_head": "$HEAD_SHA",
    "candidate_ref": "$CANDIDATE_REF",
    "production_base": "$BASE_REF",
    "test_id": "$TEST_ID",
    "simulator": "$SIM_ID",
    "head_exit": $head_status,
    "head_kind": "$head_kind",
    "base_exit": $base_status,
    "base_kind": "$base_kind",
}, open(sys.argv[1], "w"), indent=2)
JSON
cat "$OUT/result.json"

printf 'head_exit=%s head_kind=%s base_exit=%s base_kind=%s\n' \
  "$head_status" "$head_kind" "$base_status" "$base_kind"
if [[ "$head_status" -eq 0 && "$base_status" -ne 0 && "$base_kind" == "assertion-failure" ]]; then
  echo "PROOF: RED on base, GREEN on head"
  exit 0
fi
echo "PROOF: inconclusive (head=$head_status/$head_kind base=$base_status/$base_kind)"
exit 1
