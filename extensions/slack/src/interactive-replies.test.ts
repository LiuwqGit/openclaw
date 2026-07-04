// Slack tests cover interactive replies plugin behavior.
import { describe, expect, it } from "vitest";
import { compileSlackInteractiveReplies } from "./interactive-replies.js";

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

  it("supports explicit double-colon syntax for time labels", () => {
    // New syntax: Label::value allows colons in labels
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Fr 10.07. 9:00::slot_fr_0900, Mo 13.07. 10:45::slot_mo_1045]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Fr 10.07. 9:00",
              value: "slot_fr_0900",
            },
            {
              label: "Mo 13.07. 10:45",
              value: "slot_mo_1045",
            },
          ],
        },
      ],
    });
  });

  it("preserves legacy single-colon syntax (backward compatible)", () => {
    // Legacy syntax: Label:value - splits at first colon
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Retry:retry, Ignore:ignore, Approve:approve:primary]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            { label: "Retry", value: "retry" },
            { label: "Ignore", value: "ignore" },
            { label: "Approve", value: "approve", style: "primary" },
          ],
        },
      ],
    });
  });

  it("preserves callback values containing colons (legacy behavior)", () => {
    // Legacy syntax preserves callback values with colons
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Allow:pluginbind:approval-123:o]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow",
              value: "pluginbind:approval-123:o", // Callback value preserved
            },
          ],
        },
      ],
    });
  });

  it("supports complex time labels with double-colon syntax and style", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Mon 15.07. 14:30-16:00::slot_mon_afternoon:secondary]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Mon 15.07. 14:30-16:00",
              value: "slot_mon_afternoon",
              style: "secondary",
            },
          ],
        },
      ],
    });
  });

  it("handles mixed new and legacy syntax in same directive", () => {
    const result = compileSlackInteractiveReplies({
      text: "[[slack_buttons: Time Label::value1, Legacy:legacy_value]]",
    });

    expect(result.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Time Label",
              value: "value1",
            },
            {
              label: "Legacy",
              value: "legacy_value",
            },
          ],
        },
      ],
    });
  });
});
