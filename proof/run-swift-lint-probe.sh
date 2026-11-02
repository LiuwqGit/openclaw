#!/usr/bin/env bash
# Run the repository's own SwiftFormat and SwiftLint over the candidate branch on a macOS runner,
# which is the only place these pinned tools can execute. Harness only; not part of the PR.
set -uo pipefail

CANDIDATE_REF="${1:-chore/proof-candidate-191076}"
FORK_URL="${FORK_URL:-https://github.com/LiuwqGit/openclaw.git}"
WORKDIR="${RUNNER_TEMP:-/tmp}/swift-lint-probe"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

log() { printf '\n=== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
cd "$WORKDIR" || exit 90

log "clone candidate $CANDIDATE_REF"
git clone --quiet --depth 1 --branch "$CANDIDATE_REF" "$FORK_URL" repo || exit 91
cd repo || exit 92
git log -1 --format='head %H %s'

log "install pinned swift tools"
./scripts/install-swift-tools.sh "$WORKDIR/swift-tools"
export PATH="$WORKDIR/swift-tools:$PATH"
swiftformat --version
swiftlint version

log "swiftformat --lint (OpenClawChatUI)"
swiftformat --lint apps/shared/OpenClawKit/Sources/OpenClawChatUI \
  --config config/swiftformat \
  --unexclude "$PWD/apps/shared/OpenClawKit/Sources/OpenClawChatUI" \
  >"$WORKDIR/swiftformat.log" 2>&1
format_status=$?
tail -n 60 "$WORKDIR/swiftformat.log"
printf -- '--- swiftformat exit=%s\n' "$format_status"

log "swiftlint --strict (apps/ios config, includes the shared chat UI)"
(
  cd apps/ios
  swiftlint lint --strict --quiet --config .swiftlint.yml
) >"$WORKDIR/swiftlint.log" 2>&1
lint_status=$?
tail -n 60 "$WORKDIR/swiftlint.log"
printf -- '--- swiftlint exit=%s\n' "$lint_status"

{
  echo "## Swift format and lint probe"
  echo ""
  echo "- head: \`$(git rev-parse HEAD)\` (\`$CANDIDATE_REF\`)"
  echo "- swiftformat: exit $format_status"
  echo "- swiftlint: exit $lint_status"
} >>"$SUMMARY"

[ "$format_status" -eq 0 ] && [ "$lint_status" -eq 0 ]
