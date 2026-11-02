#!/usr/bin/env bash
# Execute the shared chat table regression suite on a real macOS runner: once against the PR head
# and once against upstream main, so the rendered assertions are shown failing on the base and
# passing on the head. Harness only; it is not part of the pull request.
set -uo pipefail

CANDIDATE_REF="${1:-chore/proof-candidate-191076}"
UPSTREAM_URL="${2:-https://github.com/openclaw/openclaw.git}"
FORK_URL="${FORK_URL:-https://github.com/LiuwqGit/openclaw.git}"
WORKDIR="${RUNNER_TEMP:-/tmp}/openclawkit-table-proof"
PACKAGE="apps/shared/OpenClawKit"
SOURCES="apps/shared/OpenClawKit/Sources"
TESTS="apps/shared/OpenClawKit/Tests/OpenClawKitTests"
FILTER="ChatMarkdownTable"
RENDERED_SUITE="ChatMarkdownTableCompactWidthTests"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

log() {
  printf '\n=== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"
}

# run_logged <label> <logfile> <command...> -> exit status of the command, tail echoed
run_logged() {
  local label="$1"
  local logfile="$2"
  shift 2
  log "$label"
  "$@" >"$logfile" 2>&1
  local status=$?
  tail -n 80 "$logfile"
  printf -- '--- %s exit=%s log=%s\n' "$label" "$status" "$logfile"
  return "$status"
}

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
cd "$WORKDIR" || exit 90

log "clone candidate $CANDIDATE_REF"
git clone --quiet --depth 1 --branch "$CANDIDATE_REF" "$FORK_URL" repo || exit 91
cd repo || exit 92
HEAD_SHA="$(git rev-parse HEAD)"
git log -1 --format='head %H %s'
git fetch --quiet --depth 1 "$UPSTREAM_URL" main || exit 93
BASE_SHA="$(git rev-parse FETCH_HEAD)"
printf 'base %s\n' "$BASE_SHA"

log "toolchain"
sw_vers
xcodebuild -version
swift --version
node --version

log "pinned swiftformat and swiftlint"
./scripts/install-swift-tools.sh "$WORKDIR/swift-tools" || exit 99
export PATH="$WORKDIR/swift-tools:$PATH"
swiftformat --version
swiftlint version

swiftformat --lint apps/shared/OpenClawKit/Sources/OpenClawChatUI \
  --config config/swiftformat \
  --unexclude "$PWD/apps/shared/OpenClawKit/Sources/OpenClawChatUI" \
  >"$WORKDIR/swiftformat.log" 2>&1
format_status=$?
tail -n 40 "$WORKDIR/swiftformat.log"
printf -- '--- swiftformat exit=%s\n' "$format_status"

(
  cd apps/ios
  swiftlint lint --strict --quiet --config .swiftlint.yml \
    ../shared/OpenClawKit/Sources/OpenClawChatUI/ChatMarkdownBlockViews.swift
) >"$WORKDIR/swiftlint.log" 2>&1
lint_status=$?
tail -n 40 "$WORKDIR/swiftlint.log"
printf -- '--- swiftlint exit=%s\n' "$lint_status"

if [ "$format_status" -ne 0 ] || [ "$lint_status" -ne 0 ]; then
  {
    echo "## OpenClawKit table proof"
    echo ""
    echo "- result: **swift format/lint failed** (swiftformat=$format_status swiftlint=$lint_status)"
  } >>"$SUMMARY"
  exit 1
fi

log "node dependencies for the native protocol generator and the mermaid assets"
npm install --global pnpm@12.15.0 >/dev/null 2>&1 || exit 94
pnpm install --frozen-lockfile --prefer-offline --optional \
  --filter '@openclaw/mermaid-renderer...' --filter '@openclaw/gateway-protocol...' \
  --config.ignore-scripts=false --config.engine-strict=false \
  --config.enable-pre-post-scripts=true --config.side-effects-cache=true \
  >"$WORKDIR/pnpm-install.log" 2>&1 || {
  tail -n 60 "$WORKDIR/pnpm-install.log"
  exit 95
}
tail -n 15 "$WORKDIR/pnpm-install.log"
node scripts/prepare-apple-mermaid.mjs >"$WORKDIR/mermaid.log" 2>&1 || {
  tail -n 40 "$WORKDIR/mermaid.log"
  exit 96
}
tail -n 10 "$WORKDIR/mermaid.log"

log "compile the changed target (head $HEAD_SHA)"
swift build --package-path "$PACKAGE" --target OpenClawChatUI --disable-index-store \
  >"$WORKDIR/build-head.log" 2>&1
build_status=$?
tail -n 60 "$WORKDIR/build-head.log"
printf -- '--- compile exit=%s\n' "$build_status"
if [ "$build_status" -ne 0 ]; then
  {
    echo "## OpenClawKit table proof"
    echo ""
    echo "- head: \`$HEAD_SHA\`"
    echo "- result: **compile failure** (see build-head.log)"
  } >>"$SUMMARY"
  exit 1
fi

log "head run: swift test --filter $FILTER"
swift test --package-path "$PACKAGE" --filter "$FILTER" --disable-index-store \
  >"$WORKDIR/test-head.log" 2>&1
head_status=$?
tail -n 100 "$WORKDIR/test-head.log"
printf -- '--- head test exit=%s\n' "$head_status"

log "restore base sources ($BASE_SHA) and drop the suite that needs the new API"
git checkout "$BASE_SHA" -- "$SOURCES" || exit 97
rm -f "$TESTS/ChatMarkdownTableColumnWidthTests.swift"
git status --short | head -20

log "base run: swift test --filter $RENDERED_SUITE (failure expected)"
swift test --package-path "$PACKAGE" --filter "$RENDERED_SUITE" --disable-index-store \
  >"$WORKDIR/test-base.log" 2>&1
base_status=$?
tail -n 120 "$WORKDIR/test-base.log"
printf -- '--- base test exit=%s\n' "$base_status"

log "restore head tree"
git checkout HEAD -- "$PACKAGE" || exit 98

base_kind="unknown"
if grep -q "error:" "$WORKDIR/test-base.log"; then
  base_kind="compile-error"
elif grep -Eq "Expectation failed|recorded an issue|Test .* failed" "$WORKDIR/test-base.log"; then
  base_kind="assertion-failure"
elif grep -q "No matching test" "$WORKDIR/test-base.log"; then
  base_kind="no-tests-selected"
fi

{
  echo "## OpenClawKit table proof"
  echo ""
  echo "- runner: $(sw_vers -productVersion 2>/dev/null), $(swift --version 2>&1 | head -n 1)"
  echo "- head: \`$HEAD_SHA\` (\`$CANDIDATE_REF\`)"
  echo "- base: \`$BASE_SHA\` (upstream main)"
  echo "- head \`swift test --filter $FILTER\`: exit $head_status"
  echo "- base \`swift test --filter $RENDERED_SUITE\`: exit $base_status ($base_kind)"
  echo ""
  echo '```text'
  grep -E "Test run|Suite .* (passed|failed)|Test .* (passed|failed)|Expectation failed|error:" \
    "$WORKDIR/test-head.log" | tail -n 40
  echo '```'
  echo ""
  echo '```text'
  grep -E "Test run|Suite .* (passed|failed)|Test .* (passed|failed)|Expectation failed|error:" \
    "$WORKDIR/test-base.log" | tail -n 40
  echo '```'
} >>"$SUMMARY"

log "result"
printf 'head_exit=%s base_exit=%s base_kind=%s\n' "$head_status" "$base_status" "$base_kind"
if [ "$head_status" -eq 0 ] && [ "$base_status" -ne 0 ] && [ "$base_kind" = "assertion-failure" ]; then
  echo "PROOF: RED on base, GREEN on head"
  exit 0
fi
echo "PROOF: inconclusive (head=$head_status base=$base_status kind=$base_kind)"
exit 1
