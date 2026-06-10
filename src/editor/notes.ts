/**
 * CriticMarkup notes: review annotations that live in the markdown text
 * itself, so versioning, branching, and merging work on them for free.
 *
 *   {>> standalone comment <<}
 *   {== highlighted text ==}{>> comment on it <<}
 *
 * The live view hides the syntax and renders a highlight plus a hoverable
 * note bubble; placing the cursor inside reveals the raw markup.
 */
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Range } from "@codemirror/state";

export interface NoteMatch {
  from: number;
  to: number;
  raw: string;
  excerpt: string; // highlighted text, "" for standalone comments
  comment: string;
  highlighted: boolean;
  hlFrom: number;
  hlTo: number;
  commentFrom: number; // start of the {>> <<} block (incl. leading ws), -1 if none
  commentTo: number;
  commentTextPos: number; // caret position inside the comment text
}

const CRITIC_RE =
  /\{==([\s\S]*?)==\}(\s*\{>>([\s\S]*?)<<\})?|\{>>([\s\S]*?)<<\}/g;

export function scanNotes(text: string, base = 0): NoteMatch[] {
  const out: NoteMatch[] = [];
  CRITIC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CRITIC_RE.exec(text))) {
    const from = base + m.index;
    const to = from + m[0].length;
    if (m[1] !== undefined) {
      const hlFrom = from + 3;
      const hlTo = hlFrom + m[1].length;
      const hasComment = m[2] !== undefined;
      const commentFrom = hasComment ? hlTo + 3 : -1;
      const commentTo = hasComment ? commentFrom + m[2]!.length : -1;
      out.push({
        from,
        to,
        raw: m[0],
        excerpt: m[1],
        comment: m[3] ?? "",
        highlighted: true,
        hlFrom,
        hlTo,
        commentFrom,
        commentTo,
        commentTextPos: hasComment ? commentTo - 3 - m[3]!.length : -1,
      });
    } else {
      out.push({
        from,
        to,
        raw: m[0],
        excerpt: "",
        comment: m[4] ?? "",
        highlighted: false,
        hlFrom: -1,
        hlTo: -1,
        commentFrom: from,
        commentTo: to,
        commentTextPos: from + 3,
      });
    }
  }
  return out;
}

/** Remove all notes for export: comments dropped, highlights unwrapped. */
export function stripCriticMarkup(text: string): string {
  return text
    .replace(/\{==([\s\S]*?)==\}\s*\{>>[\s\S]*?<<\}/g, "$1")
    .replace(/\{==([\s\S]*?)==\}/g, "$1")
    .replace(/ ?\{>>[\s\S]*?<<\}/g, "");
}

/** Wrap the selection in a note (or insert a standalone one) and place
 *  the caret inside the comment. */
export function insertNote(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  if (from === to) {
    view.dispatch({
      changes: { from, insert: "{>>  <<}" },
      selection: { anchor: from + 4 },
    });
  } else {
    const sel = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: `{==${sel}==}{>>  <<}` },
      selection: { anchor: from + sel.length + 10 },
    });
  }
  view.focus();
  return true;
}

class NoteWidget extends WidgetType {
  constructor(
    readonly comment: string,
    readonly caretPos: number,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "lp-note";
    const icon = document.createElement("span");
    icon.className = "lp-note-icon";
    icon.textContent = "✎";
    const pop = document.createElement("span");
    pop.className = "lp-note-pop";
    pop.textContent = this.comment.trim() || "(empty note)";
    wrap.append(icon, pop);
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: this.caretPos } });
      view.focus();
    });
    return wrap;
  }
  eq(other: NoteWidget): boolean {
    return other.comment === this.comment && other.caretPos === this.caretPos;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

interface NoteSets {
  decorations: DecorationSet;
  atomic: DecorationSet;
}

function buildDecorations(view: EditorView): NoteSets {
  const decos: Range<Decoration>[] = [];
  const hides: Range<Decoration>[] = [];
  const state = view.state;
  const hide = (
    from: number,
    to: number,
    spec: Parameters<typeof Decoration.replace>[0] = {},
  ) => {
    const d = Decoration.replace(spec).range(from, to);
    decos.push(d);
    hides.push(d);
  };
  for (const range of view.visibleRanges) {
    const text = state.sliceDoc(range.from, range.to);
    for (const n of scanNotes(text, range.from)) {
      if (selectionTouches(state, n.from, n.to)) {
        // Cursor inside: show the raw markup, lightly tinted.
        decos.push(
          Decoration.mark({ class: "lp-note-active" }).range(n.from, n.to),
        );
        continue;
      }
      if (n.highlighted) {
        hide(n.from, n.hlFrom); // {==
        if (n.hlFrom < n.hlTo) {
          decos.push(
            Decoration.mark({ class: "lp-note-hl" }).range(n.hlFrom, n.hlTo),
          );
        }
        hide(n.hlTo, n.hlTo + 3); // ==}
        if (n.commentFrom >= 0) {
          hide(n.commentFrom, n.commentTo, {
            widget: new NoteWidget(n.comment, n.commentTextPos),
          });
        }
      } else {
        hide(n.from, n.to, {
          widget: new NoteWidget(n.comment, n.commentTextPos),
        });
      }
    }
  }
  return {
    decorations: Decoration.set(decos, true),
    atomic: Decoration.set(hides, true),
  };
}

class CriticMarkupPlugin {
  decorations: DecorationSet;
  atomic: DecorationSet;
  constructor(view: EditorView) {
    ({ decorations: this.decorations, atomic: this.atomic } =
      buildDecorations(view));
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged) {
      ({ decorations: this.decorations, atomic: this.atomic } =
        buildDecorations(update.view));
    }
  }
}

export const criticMarkup = ViewPlugin.fromClass(CriticMarkupPlugin, {
  decorations: (v) => v.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
    ),
});
