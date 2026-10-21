import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { normalizeLegacyInboundContextLabels } from "../config/sessions/legacy-inbound-context-labels.js";
import { importSqliteSessionRows } from "../config/sessions/session-accessor.sqlite-import.test-support.js";
import {
  loadTranscriptEventsSync,
  readTranscriptEventRows,
} from "../config/sessions/session-accessor.sqlite-read.js";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTranscriptEventReader } from "./session-sqlite-migration-readers.js";
import { verifyTranscriptEvents } from "./session-sqlite-transcript-verification.js";

const verified = { events: 2, missingEvents: 0, sqliteEvents: 2 };
const legacyMessage = {
  role: "user",
  content: "see attached",
  MediaPath: "/tmp/photo.png",
  MediaPaths: ["/tmp/photo.png", "/tmp/document.pdf"],
  MediaType: "image/png",
  MediaTypes: ["image/png", "application/pdf"],
  __openclaw: { retained: "message metadata" },
};
const providerMessage = (provider: string) => ({
  role: "assistant",
  content: [{ type: "text", text: "stored once" }],
  provider,
  api: provider === "openai" ? "openai-chatgpt-responses" : "openai-codex-responses",
});

it("recognizes Doctor's repaired inbound-context headings without touching retained transcripts", async () => {
  await withOpenClawTestState({ label: "verify-heading-equivalence" }, async (state) => {
    const sessionId = "heading-equivalence";
    const header = { type: "session", id: sessionId, version: 3 };
    const message = (content: string) => ({
      type: "message",
      id: "m1",
      parentId: null,
      message: { role: "user", content },
    });
    const legacyContent = "Conversation info (untrusted metadata):\n```json\n{}\n```";
    const write = (content: string) =>
      state.writeText(
        "labels.jsonl",
        `${JSON.stringify(header)}\n${JSON.stringify(message(content))}\n`,
      );
    const filename = await write(legacyContent);
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await importSqliteSessionRows({
      ...scope,
      entry: { sessionId, updatedAt: 1 },
      readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
    });
    // Replay Doctor's label repair exactly: the frozen rewrite updates SQLite rows only.
    runOpenClawAgentWriteTransaction(
      (database) => {
        const updates: Array<{ seq: number; eventJson: string }> = [];
        for (const row of readTranscriptEventRows(database, sessionId)) {
          const event = JSON.parse(row.eventJson) as Parameters<
            typeof normalizeLegacyInboundContextLabels
          >[0];
          if (normalizeLegacyInboundContextLabels(event)) {
            updates.push({ seq: row.seq, eventJson: JSON.stringify(event) });
          }
        }
        updateSqliteTranscriptEventJsonInTransaction(database, sessionId, updates);
      },
      { agentId: "main", env: state.env },
    );
    const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const source = { path: filename, sessionId, originalPath: filename };
    const verify = (mode: Parameters<typeof verifyTranscriptEvents>[2]) =>
      verifyTranscriptEvents(db, source, mode);
    const repaired = loadTranscriptEventsSync(scope);
    expect(repaired[1]).toMatchObject({
      id: "m1",
      message: {
        role: "user",
        content: "Conversation info: ⟦openclaw:ctx⟧\n```json\n{}\n```",
      },
    });
    const original = fs.readFileSync(filename, "utf8");
    for (const mode of ["ordered", "contained", "appendable"] as const) {
      expect(verify(mode)).toEqual(verified);
    }
    // The retained transcript keeps its original bytes; only SQLite carries repaired headings.
    expect(fs.readFileSync(filename, "utf8")).toBe(original);
    // Differences beyond the frozen heading rewrite remain genuine conflicts.
    await write('Conversation info (untrusted metadata):\n```json\n{"edited":true}\n```');
    expect(verify("ordered")).toBeUndefined();
    expect(verify("contained")).toBeUndefined();
    expect(() => verify("appendable")).toThrow(
      "Legacy event m1 conflicts with the SQLite event of the same identity",
    );
    await write(legacyContent);
    expect(loadTranscriptEventsSync(scope)).toEqual(repaired);
  });
});

it.each(["legacy media", "openai", "openai-codex"] as const)(
  "verifies %s without changing historical receipts",
  async (kind) => {
    const media = kind === "legacy media";
    await withOpenClawTestState(
      { label: media ? "verify-legacy-media" : "verify-provider-retry" },
      async (state) => {
        const sessionId = media ? "legacy-media" : "provider-retry";
        const header = { type: "session", id: sessionId, version: 3 };
        const event = (message: unknown) => ({
          type: "message",
          id: "m1",
          parentId: null,
          message,
        });
        const write = (message: unknown) =>
          state.writeText(
            media ? "legacy.jsonl" : "source.jsonl",
            `${JSON.stringify(header)}\n${JSON.stringify(event(message))}\n`,
          );
        const filename = await write(media ? legacyMessage : providerMessage(kind));
        const scope = {
          agentId: "main",
          env: state.env,
          sessionId,
          sessionKey: media ? `agent:main:${sessionId}` : "agent:main:main",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await importSqliteSessionRows({
          ...scope,
          entry: { sessionId, updatedAt: 1 },
          readTranscriptEvents: createTranscriptEventReader(filename, sessionId),
        });
        const { db } = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const source = { path: filename, sessionId, originalPath: filename };
        const verify = (mode: Parameters<typeof verifyTranscriptEvents>[2]) =>
          verifyTranscriptEvents(db, source, mode);
        const stored = loadTranscriptEventsSync(scope);
        if (media) {
          const original = fs.readFileSync(filename, "utf8");
          expect(stored[1]).toMatchObject({
            id: "m1",
            message: {
              role: "user",
              content: "see attached",
              __openclaw: {
                retained: "message metadata",
                media: [
                  { path: "/tmp/photo.png", contentType: "image/png" },
                  { path: "/tmp/document.pdf", contentType: "application/pdf" },
                ],
              },
            },
          });
          for (const mode of ["ordered", "contained", "appendable"] as const) {
            expect(verify(mode)).toEqual(verified);
          }
          expect(fs.readFileSync(filename, "utf8")).toBe(original);
          for (const changed of [
            { content: "changed" },
            { MediaPath: "/tmp/other.png", MediaPaths: ["/tmp/other.png", "/tmp/document.pdf"] },
            { __openclaw: { retained: "changed metadata" } },
          ]) {
            await write({ ...legacyMessage, ...changed });
            expect(verify("ordered")).toBeUndefined();
            expect(verify("contained")).toBeUndefined();
            expect(() => verify("appendable")).toThrow(
              "Legacy event m1 conflicts with the SQLite event of the same identity",
            );
          }
        } else {
          await write(providerMessage(kind === "openai" ? "openai-codex" : "openai"));
          expect(verify("ordered")).toBeUndefined();
          for (const mode of ["contained", "appendable"] as const) {
            expect(verify(mode)).toEqual(verified);
          }
        }
        expect(loadTranscriptEventsSync(scope)).toEqual(stored);
      },
    );
  },
);
