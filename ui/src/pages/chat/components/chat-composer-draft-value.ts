// Composer textarea draft-value binding.
//
// The composer textarea is state-backed but must stay hands-off toward the
// browser's native editing state. A plain property binding re-applies the
// value after every native input (each keystroke rerenders with the new draft),
// which resets the textarea's native undo/redo bookkeeping; `live` alone would
// instead clobber local input whenever the host draft lags the DOM across an
// unrelated rerender. This directive writes only when the bound value changed
// since the previous render AND the DOM does not already hold it, so typing,
// native undo, and uncommitted local input all survive rerenders untouched.
import { noChange, type PropertyPart } from "lit";
import { setCommittedValue } from "lit/directive-helpers.js";
import { Directive, PartType, directive, type PartInfo } from "lit/directive.js";

class ComposerDraftValueDirective extends Directive {
  private committed: string | undefined;
  private hasCommitted = false;

  constructor(part: PartInfo) {
    super(part);
    if (part.type !== PartType.PROPERTY) {
      throw new Error("composerDraftValue is only allowed on property bindings");
    }
  }

  render(value: string): string {
    return value;
  }

  override update(part: PropertyPart, [value]: [string]): string | typeof noChange {
    // SAFETY: the constructor rejects non-property bindings, so element is the bound textarea.
    const element = part.element as HTMLTextAreaElement;
    const changed = !this.hasCommitted || this.committed !== value;
    this.committed = value;
    this.hasCommitted = true;
    if (!changed || element.value === value) {
      return noChange;
    }
    // `noChange` deliberately leaves Lit's outer property cache stale while the
    // DOM advances natively. Reset it before a real host write so repeated values commit.
    setCommittedValue(part);
    return value;
  }
}

/** Binds the composer draft to a textarea without disturbing native edits. */
export const composerDraftValue = directive(ComposerDraftValueDirective);
