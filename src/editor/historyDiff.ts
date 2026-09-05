import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Range, StateEffect, StateField } from "@codemirror/state";

export interface HistoryDiffHunk {
  index: number;
  current: string;
  historical_start: number;
  historical_lines: number;
}

export interface HistoryDiffConfig {
  hunks: readonly HistoryDiffHunk[];
  disabled: boolean;
  onReinstate: (index: number) => void;
}

export const setHistoryDiff = StateEffect.define<HistoryDiffConfig | null>();

class HistoryChangeWidget extends WidgetType {
  constructor(
    readonly hunk: HistoryDiffHunk,
    readonly disabled: boolean,
    readonly onReinstate: (index: number) => void,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const change = document.createElement("div");
    change.className = "history-inline-change";

    if (this.hunk.current) {
      const current = document.createElement("div");
      current.className = "history-inline-current";
      const label = document.createElement("span");
      label.className = "history-inline-label";
      label.textContent = "Current";
      const text = document.createElement("pre");
      text.textContent = this.hunk.current;
      current.append(label, text);
      change.append(current);
    }

    const action = document.createElement("div");
    action.className = "history-inline-action";
    if (this.hunk.historical_lines === 0) {
      action.classList.add("history-inline-absent");
    }
    const label = document.createElement("span");
    label.textContent = this.hunk.historical_lines
      ? "Historical"
      : "Not present in this version";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Reinstate";
    button.disabled = this.disabled;
    button.setAttribute(
      "aria-label",
      "Reinstate this change in the current document",
    );
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onReinstate(this.hunk.index);
    });
    action.append(label, button);
    change.append(action);
    return change;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function insertionAnchor(state: EditorState, precedingLines: number): number {
  if (precedingLines <= 0) return 0;
  if (precedingLines < state.doc.lines) {
    return state.doc.line(precedingLines + 1).from;
  }
  return state.doc.length;
}

function buildDecorations(
  state: EditorState,
  config: HistoryDiffConfig,
): DecorationSet {
  const decorations: Range<Decoration>[] = [];

  for (const hunk of config.hunks) {
    let anchor: number;
    if (hunk.historical_lines > 0) {
      const firstLine = Math.min(
        state.doc.lines,
        Math.max(1, hunk.historical_start),
      );
      const lastLine = Math.min(
        state.doc.lines,
        firstLine + hunk.historical_lines - 1,
      );
      anchor = state.doc.line(firstLine).from;
      for (let line = firstLine; line <= lastLine; line++) {
        decorations.push(
          Decoration.line({ class: "history-inline-historical-line" }).range(
            state.doc.line(line).from,
          ),
        );
      }
    } else {
      anchor = insertionAnchor(state, hunk.historical_start);
    }

    const line = state.doc.lineAt(anchor);
    const side = anchor === line.from ? -1 : 1;
    decorations.push(
      Decoration.widget({
        widget: new HistoryChangeWidget(
          hunk,
          config.disabled,
          config.onReinstate,
        ),
        block: true,
        side,
      }).range(anchor),
    );
  }

  return Decoration.set(decorations, true);
}

export const historyDiff = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = transaction.docChanged
      ? decorations.map(transaction.changes)
      : decorations;
    for (const effect of transaction.effects) {
      if (effect.is(setHistoryDiff)) {
        next = effect.value
          ? buildDecorations(transaction.state, effect.value)
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Move the cursor to the next history change after it, wrapping around. */
export function gotoNextHistoryChange(view: EditorView): boolean {
  const anchors: number[] = [];
  const changes = view.state.field(historyDiff).iter();
  for (; changes.value; changes.next()) {
    if (changes.value.spec.widget instanceof HistoryChangeWidget) {
      anchors.push(changes.from);
    }
  }
  if (anchors.length === 0) return false;
  const head = view.state.selection.main.head;
  const next = anchors.find((pos) => pos > head) ?? anchors[0];
  view.dispatch({
    selection: { anchor: next },
    effects: EditorView.scrollIntoView(next, { y: "center" }),
  });
  view.focus();
  return true;
}
