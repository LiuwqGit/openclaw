import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { composerDraftValue } from "./chat-composer-draft-value.ts";

const nativeValueDescriptor = Object.getOwnPropertyDescriptor(
  HTMLTextAreaElement.prototype,
  "value",
) as PropertyDescriptor & { get(): string; set(next: string): void };

type InstrumentedTextarea = HTMLTextAreaElement & { valueWriteSpy: ReturnType<typeof vi.fn> };

function instrument(textarea: HTMLTextAreaElement): InstrumentedTextarea {
  const writes = vi.fn();
  Object.defineProperty(textarea, "value", {
    get: nativeValueDescriptor.get,
    set(next: string) {
      writes(next);
      nativeValueDescriptor.set.call(textarea, next);
    },
    configurable: true,
  });
  return Object.assign(textarea, { valueWriteSpy: writes });
}

function renderDraft(container: HTMLElement, value: string): void {
  render(html`<textarea .value=${composerDraftValue(value)}></textarea>`, container);
}

describe("composerDraftValue", () => {
  it("writes when the bound value changes and the DOM holds a different value", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderDraft(container, "");
    const textarea = instrument(container.querySelector("textarea")!);

    renderDraft(container, "history recall");
    expect(textarea.value).toBe("history recall");
    expect(textarea.valueWriteSpy).toHaveBeenCalledTimes(1);
    container.remove();
  });

  it("does not re-apply a value the DOM already holds after native input", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderDraft(container, "");
    const textarea = instrument(container.querySelector("textarea")!);

    // Native typing: the DOM advances ahead of the bound value.
    nativeValueDescriptor.set.call(textarea, "still typing");
    renderDraft(container, "still typing");
    expect(textarea.valueWriteSpy).not.toHaveBeenCalled();

    // Native undo/redo bookkeeping must survive unchanged-value rerenders too.
    renderDraft(container, "still typing");
    expect(textarea.valueWriteSpy).not.toHaveBeenCalled();
    container.remove();
  });

  it("preserves local input across rerenders with an unchanged bound value", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderDraft(container, "");
    const textarea = instrument(container.querySelector("textarea")!);

    nativeValueDescriptor.set.call(textarea, "still typing locally");
    renderDraft(container, "");
    expect(textarea.value).toBe("still typing locally");
    expect(textarea.valueWriteSpy).not.toHaveBeenCalled();
    container.remove();
  });

  it("replaces local input once the bound value actually changes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    renderDraft(container, "");
    const textarea = instrument(container.querySelector("textarea")!);

    nativeValueDescriptor.set.call(textarea, "still typing locally");
    renderDraft(container, "history recall");
    expect(textarea.value).toBe("history recall");
    expect(textarea.valueWriteSpy).toHaveBeenCalledTimes(1);
    container.remove();
  });
});
