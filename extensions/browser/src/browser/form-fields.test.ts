// Browser tests cover form field normalization.
import { describe, expect, it } from "vitest";
import { normalizeBrowserFormField } from "./form-fields.js";

describe("normalizeBrowserFormField", () => {
  it("keeps a valid field with ref, type, and value", () => {
    expect(normalizeBrowserFormField({ ref: "e1", type: "text", value: "Ada" })).toEqual({
      ref: "e1",
      type: "text",
      value: "Ada",
    });
  });

  it("defaults a missing type to text", () => {
    expect(normalizeBrowserFormField({ ref: "e1", value: "Ada" })).toEqual({
      ref: "e1",
      type: "text",
      value: "Ada",
    });
  });

  it("accepts number and boolean values", () => {
    expect(normalizeBrowserFormField({ ref: "e1", value: 7 })).toEqual({
      ref: "e1",
      type: "text",
      value: 7,
    });
    expect(normalizeBrowserFormField({ ref: "e1", value: false })).toEqual({
      ref: "e1",
      type: "text",
      value: false,
    });
  });

  it("accepts an explicit empty string value for clearing a field", () => {
    expect(normalizeBrowserFormField({ ref: "e1", value: "" })).toEqual({
      ref: "e1",
      type: "text",
      value: "",
    });
  });

  it("rejects unsupported field keys instead of silently dropping them", () => {
    expect(() => normalizeBrowserFormField({ ref: "e1", text: "Neo" })).toThrow(
      'unsupported field key "text"; supported keys are ref, type, value',
    );
  });

  it("requires ref", () => {
    expect(() => normalizeBrowserFormField({ type: "text", value: "Ada" })).toThrow(
      "must include ref",
    );
  });

  it("requires value so a fill never silently no-ops", () => {
    expect(() => normalizeBrowserFormField({ ref: "e1", type: "text" })).toThrow(
      /must include value.*use value: "" to clear/i,
    );
  });

  it("rejects value types the fill executors cannot apply", () => {
    expect(() => normalizeBrowserFormField({ ref: "e1", value: ["Neo"] })).toThrow(
      /must include value|value must be/i,
    );
    expect(() => normalizeBrowserFormField({ ref: "e1", value: null })).toThrow(
      /must include value|value must be/i,
    );
  });
});
