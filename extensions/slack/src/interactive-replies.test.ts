// Slack tests cover interactive replies plugin behavior.
import { describe, expect, it } from "vitest";
import { compileSlackInteractiveReplies } from "./interactive-replies.js";

describe("parseChoice behavior (Issue #99823 fix)", () => {
  it("handles labels with colons in the middle (time labels)", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Fr 10.07. 9:00:slot_fr_0900, Mo 13.07. 10:45:slot_mo_1045]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Fr 10.07. 9:00", value: "slot_fr_0900" },
            { label: "Mo 13.07. 10:45", value: "slot_mo_1045" },
          ],
        },
      ],
    });
  });

  it("handles labels with colons and style suffixes", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Approve:approve:primary, Reject:reject:danger]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Approve", value: "approve", style: "primary" },
            { label: "Reject", value: "reject", style: "danger" },
          ],
        },
      ],
    });
  });

  it("handles labels with colons, time, and style suffixes", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: 9:00 AM:slot_morning:success, 5:00 PM:slot_evening:secondary]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "9:00 AM", value: "slot_morning", style: "success" },
            { label: "5:00 PM", value: "slot_evening", style: "secondary" },
          ],
        },
      ],
    });
  });

  it("handles simple label:value pairs without colons in label", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Retry:retry, Ignore:ignore]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Retry", value: "retry" },
            { label: "Ignore", value: "ignore" },
          ],
        },
      ],
    });
  });

  it("handles labels without any colons (label === value)", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: JustText, AnotherOption]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "JustText", value: "JustText" },
            { label: "AnotherOption", value: "AnotherOption" },
          ],
        },
      ],
    });
  });
});

describe("compileSlackInteractiveReplies", () => {
  it("compiles inline Slack button directives into shared interactive blocks", () => {
    const result = compileSlackInteractiveReplies({
      text: "[bot] hello [[slack_buttons: Retry:retry, Ignore:ignore]]",
    });

    expect(result.text).toBe("[bot] hello");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "[bot] hello",
        },
        {
          type: "buttons",
          buttons: [
            {
              label: "Retry",
              value: "retry",
            },
            {
              label: "Ignore",
              value: "ignore",
            },
          ],
        },
      ],
    });
  });

  it("compiles simple trailing Options lines into Slack buttons", () => {
    const result = compileSlackInteractiveReplies({
      text: "Current verbose level: off.\nOptions: on, full, off.",
    });

    expect(result.text).toBe("Current verbose level: off.");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "Current verbose level: off.",
        },
        {
          type: "buttons",
          buttons: [
            { label: "on", value: "on" },
            { label: "full", value: "full" },
            { label: "off", value: "off" },
          ],
        },
      ],
    });
  });

  it("uses a Slack select when Options lines exceed button capacity", () => {
    const result = compileSlackInteractiveReplies({
      text: "Choose a reasoning level.\nOptions: off, minimal, low, medium, high, adaptive.",
    });

    expect(result.text).toBe("Choose a reasoning level.");
    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "text",
          text: "Choose a reasoning level.",
        },
        {
          type: "select",
          placeholder: "Choose an option",
          options: [
            { label: "off", value: "off" },
            { label: "minimal", value: "minimal" },
            { label: "low", value: "low" },
            { label: "medium", value: "medium" },
            { label: "high", value: "high" },
            { label: "adaptive", value: "adaptive" },
          ],
        },
      ],
    });
  });

  it("leaves complex Options lines as plain text", () => {
    const result = compileSlackInteractiveReplies({
      text: "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    });

    expect(result.text).toBe(
      "ACP runtime choices.\nOptions: host=auto|sandbox|gateway|node, security=deny|allowlist|full.",
    );
    expect(result.interactive).toBeUndefined();
  });
});
