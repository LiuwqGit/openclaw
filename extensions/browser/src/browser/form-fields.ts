/**
 * Browser form field normalization.
 *
 * Converts model/client fill field payloads into the compact field shape used
 * by Playwright and Chrome MCP fill actions.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserFormField } from "./client-actions.types.js";

/** Default field type for fill actions when no type is provided. */
export const DEFAULT_FILL_FIELD_TYPE = "text";

/** Keys accepted in one fill field entry. */
const FIELD_ENTRY_KEYS = new Set(["ref", "type", "value"]);

type BrowserFormFieldValue = NonNullable<BrowserFormField["value"]>;

function normalizeBrowserFormFieldRef(value: unknown): string {
  return normalizeOptionalString(value) ?? "";
}

function normalizeBrowserFormFieldType(value: unknown): string {
  const type = normalizeOptionalString(value) ?? "";
  return type || DEFAULT_FILL_FIELD_TYPE;
}

/** Normalize a form field value to the types accepted by fill actions. */
function normalizeBrowserFormFieldValue(value: unknown): BrowserFormFieldValue | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

/** Normalize one form field descriptor from untrusted route/tool input. */
export function normalizeBrowserFormField(record: Record<string, unknown>): BrowserFormField {
  const ref = normalizeBrowserFormFieldRef(record.ref);
  if (!ref) {
    throw new Error("must include ref");
  }
  for (const key of Object.keys(record)) {
    if (!FIELD_ENTRY_KEYS.has(key)) {
      throw new Error(`unsupported field key "${key}"; supported keys are ref, type, value`);
    }
  }
  if (record.value === undefined) {
    throw new Error('must include value; use value: "" to clear a field');
  }
  const value = normalizeBrowserFormFieldValue(record.value);
  if (value === undefined) {
    throw new Error("value must be a string, number, or boolean");
  }
  const type = normalizeBrowserFormFieldType(record.type);
  return { ref, type, value };
}
