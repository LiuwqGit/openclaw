import { describe, expect, it } from "vitest";
import { safeStringifyError } from "./error-utils.js";

describe("safeStringifyError", () => {
  it("returns error.message for Error instances", () => {
    const error = new Error("something went wrong");
    expect(safeStringifyError(error)).toBe("something went wrong");
  });

  it("returns error.message for subclassed errors", () => {
    const error = new TypeError("type mismatch");
    expect(safeStringifyError(error)).toBe("type mismatch");
  });

  it("stringifies plain objects", () => {
    expect(safeStringifyError({ code: 42 })).toBe('{"code":42}');
  });

  it("stringifies primitives", () => {
    expect(safeStringifyError("hello")).toBe('"hello"');
    expect(safeStringifyError(123)).toBe("123");
    expect(safeStringifyError(true)).toBe("true");
    expect(safeStringifyError(null)).toBe("null");
  });

  it("falls back to String() for circular references", () => {
    const obj: Record<string, unknown> = { name: "circular" };
    obj.self = obj;
    const result = safeStringifyError(obj);
    expect(result).toBe("[object Object]");
  });

  it("falls back to String() for objects that throw on stringify", () => {
    const obj = {
      get toJSON() {
        throw new Error("nope");
      },
    };
    const result = safeStringifyError(obj);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
