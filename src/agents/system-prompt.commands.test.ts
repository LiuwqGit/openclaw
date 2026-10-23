import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

type PromptParams = Parameters<typeof buildAgentSystemPrompt>[0];

function renderPrompt(params: Partial<PromptParams> = {}) {
  return buildAgentSystemPrompt({ workspaceDir: "/tmp/openclaw", ...params });
}

describe("system prompt chat command guidance", () => {
  it("keeps /update and /restart chat guidance by default", () => {
    const prompt = renderPrompt({ toolNames: ["gateway"] });
    expect(prompt).toContain("owner can send `/update`");
    expect(prompt).toContain("the owner can send `/restart` in chat.");
    expect(prompt).toContain("Toggle /reasoning; /status shows when enabled.");
  });

  it("drops chat /update and /restart guidance when restart commands are disabled", () => {
    const prompt = renderPrompt({ toolNames: ["gateway"], commandsRestartEnabled: false });
    expect(prompt).toContain("Update OpenClaw: `gateway` action update.run");
    expect(prompt).toContain("Config writes and restarts need the `openclaw` tool.");
    expect(prompt).not.toContain("owner can send `/update`");
    expect(prompt).not.toContain("`/restart` in chat");
  });

  it("replaces the chat /update fallback when restart commands are disabled", () => {
    const prompt = renderPrompt({ commandsRestartEnabled: false });
    expect(prompt).toContain(
      "Control UI or ask the operator to run `openclaw update` in a terminal",
    );
    expect(prompt).not.toContain("direct the user to `/update`");
    expect(prompt).not.toContain("owner can send `/update`");
  });
});
