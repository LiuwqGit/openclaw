# AI-Assisted Session Log — Issue #103956

**Model**: GPT-5 (Codex)
**Date**: 2026-07-11

## Summary

This session fixed issue #103956 — session `pruneAfter` setting ignored.

## Work Done

1. **Root cause analysis**: Identified that `pruneStaleEntries` in `loadSessionStore()` is gated by `Object.keys(store).length > maintenance.maxEntries`, causing age-based pruning to be silently skipped when session count is below the limit.

2. **Fix applied**: Removed the entry-count gate from the pruning condition in `src/config/sessions/store-load.ts`, matching the established pattern in `applyEnforcedMaintenance()`. The capping step remains correctly gated by `shouldRunSessionEntryMaintenance`.

3. **Documentation**: Created `spec-103956.md` (root cause analysis), `pr-103956-body.md` (PR body), and this session log.

## Files Changed

- `src/config/sessions/store-load.ts` — Remove `&& Object.keys(store).length > maintenance.maxEntries` gate from pruning, remove redundant `preserveSessionKeys` redeclaration

## Verification

- [x] `shouldRunSessionEntryMaintenance` imported and used
- [x] `pruneStaleEntries` runs unconditionally in enforce mode
- [x] No redundant `preserveSessionKeys` declaration
- [x] Capping still gated by `shouldRunSessionEntryMaintenance`
- [x] Pattern matches `applyEnforcedMaintenance()` in `store-maintenance-operations.ts`

## PR

[PR link will be added after creation]
