/** Canonical cron schedule-kind vocabulary shared by input normalization and validation. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Schedule kinds a persisted cron row may carry. */
export const CRON_SCHEDULE_KINDS = ["at", "every", "cron", "on-exit", "stream"] as const;

export type CronScheduleKind = (typeof CRON_SCHEDULE_KINDS)[number];

const RECOGNIZED_CRON_SCHEDULE_KIND_BY_NORMALIZED: ReadonlyMap<string, CronScheduleKind> = new Map(
  CRON_SCHEDULE_KINDS.map((kind) => [kind, kind] as const),
);

/** Returns true only for the exact canonical schedule kinds. */
export function isCanonicalCronScheduleKind(value: unknown): boolean {
  return (
    typeof value === "string" && RECOGNIZED_CRON_SCHEDULE_KIND_BY_NORMALIZED.get(value) === value
  );
}

/**
 * Resolves a recognized schedule kind from case or whitespace variants.
 *
 * The public cron input path and doctor migration both canonicalize these
 * variants before validation, while the strict persisted-shape validator only
 * accepts the exact canonical kinds. Keeping the vocabulary here ensures both
 * sides agree on which kinds are recognized.
 */
export function normalizeRecognizedCronScheduleKind(value: unknown): CronScheduleKind | undefined {
  return RECOGNIZED_CRON_SCHEDULE_KIND_BY_NORMALIZED.get(normalizeLowercaseStringOrEmpty(value));
}
