#!/usr/bin/env bash
# Evidence harness for openclaw/openclaw PR #194180 (issue #194163).
#
# Runs the shared OpenClawKit Swift suite on a real macOS runner, because the
# upstream `macos-swift` lane that owns `swift test --package-path
# apps/shared/OpenClawKit` is gated behind `!ordinaryPullRequest`
# (scripts/ci-build-manifest.mjs) and therefore never executes for a fork PR.
#
# Phases:
#   prepare         toolchain, node assets, scratch dir
#   head-regression execute the PR's own regression suites at the PR head (GREEN)
#   head-wire       execute the wire-payload harness at the PR head (GREEN)
#   revert          replace the two fixed sources with the recorded base versions
#   base-regression re-execute the PR's regression suites (expected RED)
#   base-wire       re-execute the wire harness (expected RED, captures base wire)
#   base-seed       write the durable outbox with base logic (upgrade phase 1)
#   restore         put the PR head sources back
#   head-upgrade    read + replay the base-written rows with patched code
#   head-restart    inherited row survives a simulated restart and replays
#   dump <label>    raw sqlite3 dump of the durable outbox directory
#   summary         write the step summary
#
# Harness only. It lives on the fork-local proof branch, never in the PR diff.
set -uo pipefail

PHASE="${1:-}"
PROOF_DIR="${PROOF_DIR:-${RUNNER_TEMP:-/tmp}/proof-194180}"
LOGS="$PROOF_DIR/logs"
PACKAGE="apps/shared/OpenClawKit"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/openclaw/openclaw.git}"
BASE_SHA="${BASE_SHA:?BASE_SHA must be set}"
SUMMARY_FILE="$PROOF_DIR/summary.txt"
MARKERS="$PROOF_DIR/proof-markers.txt"
STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"
DB_DIR="$PROOF_DIR/durable"
REVERTED_SOURCES=(
  "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel.swift"
  "apps/shared/OpenClawKit/Sources/OpenClawChatUI/ChatViewModel+Thinking.swift"
)
SWIFT_ARGS=(
  --package-path "$PACKAGE"
  --scratch-path "$PROOF_DIR/scratch"
  --disable-index-store -Xswiftc -gline-tables-only
  --no-parallel
)

mkdir -p "$LOGS" "$DB_DIR"
export PROOF_194180_DB_DIR="$DB_DIR"
touch "$SUMMARY_FILE" "$MARKERS"

log() { printf '\n=== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

# run_tests <label> <filter> <green|red>
run_tests() {
  local label="$1" filter="$2" expected="$3"
  local logfile="$LOGS/$label.log"
  log "$label (filter=$filter expected=$expected)"
  mkdir -p "$PROOF_DIR/markers"
  export PROOF_194180_MARKERS="$PROOF_DIR/markers/$label.txt"
  : >"$PROOF_194180_MARKERS"
  swift test "${SWIFT_ARGS[@]}" --filter "$filter" >"$logfile" 2>&1
  local status=$?
  tail -n 60 "$logfile"
  grep -E 'PROOF194180_' "$logfile" >>"$MARKERS" 2>/dev/null || true
  sed "s|^|[$label] |" "$PROOF_194180_MARKERS" >>"$MARKERS" 2>/dev/null || true
  cat "$PROOF_194180_MARKERS" 2>/dev/null || true
  printf -- '--- %s exit=%s expected=%s\n' "$label" "$status" "$expected"
  echo "$label exit=$status expected=$expected" >>"$SUMMARY_FILE"
  if [[ "$expected" == "green" ]]; then
    if [[ "$status" -ne 0 ]]; then
      echo "::error::$label was expected to pass but exited $status"
      return 1
    fi
  else
    if [[ "$status" -eq 0 ]]; then
      echo "::error::$label was expected to fail on base logic but passed; the regressions do not capture the defect."
      return 1
    fi
  fi
  return 0
}

dump_outbox() {
  local label="$1"
  log "raw sqlite dump ($label)"
  {
    echo "# durable outbox dump: $label"
    echo "# directory: $DB_DIR"
    ls -la "$DB_DIR"
    for file in "$DB_DIR"/*.sqlite*; do
      [[ -e "$file" ]] || continue
      echo
      echo "## file: $(basename "$file")"
      sqlite3 "$file" ".tables" 2>&1
      echo "-- schema outbox_commands"
      sqlite3 "$file" "SELECT sql FROM sqlite_master WHERE name = 'outbox_commands';" 2>&1
      echo "-- rows (client_uuid, session_key, thinking, status, created_at)"
      sqlite3 -header -column "$file" \
        "SELECT client_uuid, session_key, thinking, status, created_at FROM outbox_commands ORDER BY created_at, enqueue_sequence;" 2>&1
      echo "-- typeof(thinking) and length per row"
      sqlite3 -header -column "$file" \
        "SELECT client_uuid, typeof(thinking) AS thinking_type, length(thinking) AS thinking_length FROM outbox_commands ORDER BY created_at, enqueue_sequence;" 2>&1
    done
  } >"$PROOF_DIR/sqlite-dump-$label.txt" 2>&1
  cat "$PROOF_DIR/sqlite-dump-$label.txt"
}

case "$PHASE" in
  prepare)
    log "host and toolchain"
    sw_vers | tee "$PROOF_DIR/toolchain.txt"
    uname -a | tee -a "$PROOF_DIR/toolchain.txt"
    ls -d /Applications/Xcode*.app || true
    if [[ -f .ci-harness/scripts/lib/swift-toolchain.sh ]]; then
      # shellcheck disable=SC1091
      source .ci-harness/scripts/lib/swift-toolchain.sh
      select_xcode_toolchain | tee -a "$PROOF_DIR/toolchain.txt" || true
    else
      newest_xcode="$(ls -d /Applications/Xcode*.app | sort -V | tail -1)"
      sudo xcode-select -s "$newest_xcode"
    fi
    {
      xcode-select -p
      xcodebuild -version
      swift --version
      node --version
    } | tee -a "$PROOF_DIR/toolchain.txt"
    log "head under proof"
    {
      echo "HEAD_SHA=$(git rev-parse HEAD)"
      git log --oneline -1
      echo "BASE_SHA=$BASE_SHA"
    } | tee "$PROOF_DIR/head.txt"

    log "node assets for the SwiftPM build plugins"
    corepack enable || npm install --global pnpm@12.15.0
    pnpm --version
    pnpm install --frozen-lockfile --prefer-offline --optional \
      --filter '@openclaw/mermaid-renderer...' \
      --filter '@openclaw/gateway-protocol...' \
      --config.ignore-scripts=false \
      --config.engine-strict=false \
      --config.enable-pre-post-scripts=true \
      --config.side-effects-cache=true >"$LOGS/pnpm-install.log" 2>&1
    tail -n 20 "$LOGS/pnpm-install.log"
    node scripts/prepare-apple-mermaid.mjs >"$LOGS/prepare-apple-mermaid.log" 2>&1
    tail -n 20 "$LOGS/prepare-apple-mermaid.log"

    log "fetch base and confirm it still matches upstream main"
    git remote add upstream "$UPSTREAM_URL" 2>/dev/null || true
    git fetch --quiet --depth 1 upstream "$BASE_SHA"
    git rev-parse FETCH_HEAD | tee "$PROOF_DIR/base-sha.txt"
    git fetch --quiet --depth 1 upstream main
    MAIN_SHA="$(git rev-parse FETCH_HEAD)"
    echo "UPSTREAM_MAIN_SHA=$MAIN_SHA" | tee -a "$PROOF_DIR/base-sha.txt"
    {
      echo "# diff of the fixed sources between the recorded base and current upstream main"
      git diff --stat "$BASE_SHA" "$MAIN_SHA" -- "${REVERTED_SOURCES[@]}"
      git diff "$BASE_SHA" "$MAIN_SHA" -- "${REVERTED_SOURCES[@]}"
    } >"$PROOF_DIR/base-vs-main.txt" 2>&1
    cat "$PROOF_DIR/base-vs-main.txt"
    ;;

  head-regression)
    run_tests "head-chatviewmodeltests" "ChatViewModelTests" green
    run_tests "head-chatviewmodeloutboxtests" "ChatViewModelOutboxTests" green
    run_tests "head-chatgatewayrequesttests" "ChatGatewayRequestTests" green
    ;;

  head-wire)
    run_tests "head-proof-wire" "Proof194180ColdSendWireTests" green
    ;;

  revert)
    log "behaviour revert: restore the fixed sources to the recorded base"
    git checkout "$BASE_SHA" -- "${REVERTED_SOURCES[@]}"
    git status --porcelain | tee "$PROOF_DIR/revert-status.txt"
    git diff --stat | tee "$PROOF_DIR/behaviour-revert.txt"
    git diff >"$PROOF_DIR/behaviour-revert.patch"
    ;;

  base-regression)
    status=0
    run_tests "base-chatviewmodeltests" "ChatViewModelTests" red || status=1
    run_tests "base-chatviewmodeloutboxtests" "ChatViewModelOutboxTests" red || status=1
    run_tests "base-chatgatewayrequesttests" "ChatGatewayRequestTests" green || status=1
    exit "$status"
    ;;

  base-wire)
    run_tests "base-proof-wire" "Proof194180ColdSendWireTests" red
    ;;

  base-seed)
    run_tests "base-legacy-seed" "Proof194180LegacySeedTests" green
    dump_outbox "base-seed"
    ;;

  restore)
    log "restore the PR head sources"
    git checkout HEAD -- "${REVERTED_SOURCES[@]}"
    git status --porcelain | tee "$PROOF_DIR/restore-status.txt"
    ;;

  head-upgrade)
    run_tests "head-upgrade-replay" "Proof194180UpgradeReplayTests" green
    dump_outbox "head-after-upgrade-replay"
    ;;

  head-restart)
    run_tests "head-inherited-restart" "Proof194180InheritedRestartTests" green
    dump_outbox "head-after-inherited-restart"
    ;;

  report)
    log "per-test outcome for the five regressions added by the PR"
    {
      echo "# outcome of the PR's new tests in every executed phase"
      for name in \
        "send before gateway thinking metadata omits the override" \
        "explicit thinking choice is still sent before gateway metadata" \
        "offline queue keeps an unchosen thinking level inherited" \
        "flush replays an inherited thinking level without an override" \
        "send request omits the inherited thinking level sentinel"
      do
        echo
        echo "## $name"
        found=0
        for logfile in "$LOGS"/*.log; do
          [[ -e "$logfile" ]] || continue
          matches="$(grep -F "\"$name\"" "$logfile" 2>/dev/null | sed "s|^|[$(basename "$logfile" .log)] |")"
          if [[ -n "$matches" ]]; then
            printf '%s\n' "$matches"
            found=1
          fi
        done
        [[ "$found" -eq 1 ]] || echo "(not executed)"
      done
    } >"$PROOF_DIR/new-test-matrix.txt" 2>&1
    cat "$PROOF_DIR/new-test-matrix.txt"
    ;;

  summary)
    {
      echo "## OpenClawKit thinking-inheritance proof (PR #194180)"
      echo ""
      echo "- head: \`$(git rev-parse HEAD)\`"
      echo "- base: \`$BASE_SHA\`"
      echo "- durable dir: \`$DB_DIR\`"
      echo ""
      echo '```'
      cat "$SUMMARY_FILE"
      echo '```'
      echo ""
      echo "### Captured markers"
      echo ""
      echo '```'
      cat "$MARKERS"
      echo '```'
    } >>"$STEP_SUMMARY"
    cat "$SUMMARY_FILE"
    ;;

  *)
    echo "unknown phase: $PHASE" >&2
    exit 2
    ;;
esac
