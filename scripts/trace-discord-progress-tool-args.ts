/**
 * Runtime trace that demonstrates the raw Discord/CLI progress draft repair
 * when a streaming tool start fires before its args arrive and a later
 * non-start update (phase:"update") carries the resolved args. Uses the real
 * channel progress-draft compositor (buildChannelProgressDraftLine +
 * mergeChannelProgressDraftLine + formatChannelProgressDraftText) with the
 * same raw-mode config the Discord surface uses.
 *
 * See the PR body for the operator-visible rendered output and the invariant
 * being demonstrated; this script is the reproducible harness for it.
 */
import {
  buildChannelProgressDraftLine,
  formatChannelProgressDraftText,
  mergeChannelProgressDraftLine,
  type ChannelProgressDraftLine,
  type StreamingCompatEntry,
} from "../src/channels/streaming.js";

const entry: StreamingCompatEntry = {
  streaming: {
    mode: "progress",
    progress: { label: "Shelling", commandText: "raw" },
  },
};
const opts = { commandText: "raw" as const, detailMode: "raw" as const };
const maxLines = 4;

const startLine = buildChannelProgressDraftLine(
  { event: "tool", toolCallId: "call-1", name: "exec", phase: "start", args: {} },
  opts,
)!;
const updateLine = buildChannelProgressDraftLine(
  {
    event: "tool",
    toolCallId: "call-1",
    name: "exec",
    phase: "update",
    args: { command: "pnpm test -- --watch=false" },
  },
  opts,
)!;

console.log("=== name-only start row (before snapshot) ===");
console.log(JSON.stringify(startLine, null, 2));
console.log("\n=== enriched update row (late snapshot args) ===");
console.log(JSON.stringify(updateLine, null, 2));

const merged = mergeChannelProgressDraftLine(
  [startLine as ChannelProgressDraftLine],
  updateLine as ChannelProgressDraftLine,
  { maxLines },
);

console.log("\n=== merged rows after update ===");
console.log(JSON.stringify(merged, null, 2));

const draft = formatChannelProgressDraftText({
  entry,
  lines: merged,
});
console.log("\n=== rendered Discord raw-mode progress draft (operator-visible) ===");
console.log(draft);
