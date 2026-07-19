// Discord tests cover voice participant classification.
import { describe, expect, it } from "vitest";
import {
  countDiscordVoiceHumanParticipants,
  formatDiscordVoiceParticipantStateLine,
} from "./participant-context.js";

describe("countDiscordVoiceHumanParticipants", () => {
  it("counts people while excluding the agent and other bots", () => {
    expect(
      countDiscordVoiceHumanParticipants({
        states: [
          {
            user_id: "agent",
            member: { user: { id: "agent", bot: true } },
          },
          {
            user_id: "owner",
            member: { user: { id: "owner", bot: false } },
          },
          {
            user_id: "helper-bot",
            member: { user: { id: "helper-bot", bot: true } },
          },
        ] as never,
        botUserId: "agent",
      }),
    ).toBe(1);
  });

  it("conservatively counts inferred speakers with missing member metadata", () => {
    expect(
      countDiscordVoiceHumanParticipants({
        states: [
          {
            user_id: "known-bot",
            member: { user: { id: "known-bot", bot: true } },
          },
        ] as never,
        additionalUserIds: ["known-bot", "cache-race-speaker"],
      }),
    ).toBe(1);
  });
});

describe("normalizeLabel (via formatDiscordVoiceParticipantStateLine)", () => {
  it("truncates emoji nicknames without splitting surrogate pairs", () => {
    const emojiNickname = "😀".repeat(60);
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "user-1",
      state: {
        user_id: "user-1",
        member: { nick: emojiNickname, user: { id: "user-1", bot: false } },
      } as never,
    });
    const match = line.match(/display_name="(.*)"/);
    expect(match).not.toBeNull();
    const displayName = match![1]!;
    expect(displayName.length).toBeLessThanOrEqual(201);
    expect(displayName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(displayName).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("preserves short ASCII nicknames unchanged", () => {
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "user-2",
      state: {
        user_id: "user-2",
        member: { nick: "Alice", user: { id: "user-2", bot: false } },
      } as never,
    });
    expect(line).toContain('display_name="Alice"');
  });

  it("truncates CJK-heavy nicknames at correct code-unit boundary", () => {
    const cjkNickname = "测试".repeat(60);
    const line = formatDiscordVoiceParticipantStateLine({
      userId: "user-3",
      state: {
        user_id: "user-3",
        member: { nick: cjkNickname, user: { id: "user-3", bot: false } },
      } as never,
    });
    const match = line.match(/display_name="(.*)"/);
    expect(match).not.toBeNull();
    const displayName = match![1]!;
    expect(displayName.length).toBeLessThanOrEqual(101);
  });
});
