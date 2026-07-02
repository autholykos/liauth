/**
 * CriticMarkup notes: review annotations that live in the markdown text
 * itself, so versioning, branching, and merging work on them for free.
 *
 *   {>> standalone comment <<}
 *   {== highlighted text ==}{>> comment on it <<}
 *   {~~old text~>suggested replacement~~}
 *
 * The live view hides the syntax and renders a highlight plus a hoverable
 * note bubble — or, for suggestions, the old text struck through beside
 * the proposed text; placing the cursor inside reveals the raw markup.
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

interface NoteBase {
  from: number;
  to: number;
  raw: string;
}

/** A {>> <<} comment, optionally attached to a {== ==} highlight. */
export interface CommentNote extends NoteBase {
  kind: "comment";
  excerpt: string; // highlighted text, "" for standalone comments
  comment: string;
  highlighted: boolean;
  hlFrom: number;
  hlTo: number;
  commentFrom: number; // start of the {>> <<} block (incl. leading ws), -1 if none
  commentTo: number;
  commentTextPos: number; // caret position inside the comment text
}

/** A {~~old~>new~~} substitution the author can accept or reject. */
export interface SuggestionNote extends NoteBase {
  kind: "suggestion";
  oldText: string;
  newText: string;
  oldFrom: number;
  oldTo: number;
  newFrom: number;
  newTo: number;
}

export type NoteMatch = CommentNote | SuggestionNote;

const CRITIC_RE =
  /\{==([\s\S]*?)==\}(\s*\{>>([\s\S]*?)<<\})?|\{>>([\s\S]*?)<<\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g;

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
        kind: "comment",
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
    } else if (m[5] !== undefined) {
      const oldFrom = from + 3;
      const oldTo = oldFrom + m[5].length;
      const newFrom = oldTo + 2;
      out.push({
        kind: "suggestion",
        from,
        to,
        raw: m[0],
        oldText: m[5],
        newText: m[6]!,
        oldFrom,
        oldTo,
        newFrom,
        newTo: newFrom + m[6]!.length,
      });
    } else {
      out.push({
        kind: "comment",
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

/** Remove all notes for export: comments dropped, highlights unwrapped,
 *  unaccepted suggestions keep the original text. */
export function stripCriticMarkup(text: string): string {
  return text
    .replace(/\{==([\s\S]*?)==\}\s*\{>>[\s\S]*?<<\}/g, "$1")
    .replace(/\{==([\s\S]*?)==\}/g, "$1")
    .replace(/ ?\{>>[\s\S]*?<<\}/g, "")
    .replace(/\{~~([\s\S]*?)~>[\s\S]*?~~\}/g, "$1");
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

/** Wrap the selection in a suggestion with the proposed text selected for
 *  overtyping; with no selection, insert an empty insertion proposal. */
export function insertSuggestion(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  if (from === to) {
    view.dispatch({
      changes: { from, insert: "{~~~>~~}" },
      selection: { anchor: from + 5 },
    });
  } else {
    const sel = view.state.sliceDoc(from, to);
    const newFrom = from + 3 + sel.length + 2;
    view.dispatch({
      changes: { from, to, insert: `{~~${sel}~>${sel}~~}` },
      selection: { anchor: newFrom, head: newFrom + sel.length },
    });
  }
  view.focus();
  return true;
}

const CRITIC_TOKENS = /\{~~|~>|~~\}|\{>>|<<\}|\{==|==\}/;

/** Typographic normalization for tolerant matching: models straighten curly
 *  apostrophes/quotes, flatten ellipses, and collapse space runs when quoting
 *  a document back, which breaks verbatim search. `map[i]` is the source
 *  index of the char that produced `norm[i]`. */
function normalize(text: string): { norm: string; map: number[] } {
  const map: number[] = [];
  let norm = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    let out: string;
    if (c === "‘" || c === "’" || c === "‛") out = "'";
    else if (c === "“" || c === "”" || c === "„") out = '"';
    else if (c === "…") out = "...";
    else if (c === " " || c === "\t") {
      if (norm.endsWith(" ")) continue;
      out = " ";
    } else {
      out = c;
    }
    for (const ch of out) {
      norm += ch;
      map.push(i);
    }
  }
  return { norm, map };
}

/** Undo the model's typographic normalization in a replacement, but only
 *  for character classes the matched original text proves the document
 *  actually uses. */
function repairReplace(replace: string, original: string): string {
  let out = replace;
  if (original.includes("’")) out = out.replace(/'/g, "’");
  if (original.includes("…")) out = out.replace(/\.\.\./g, "…");
  return out;
}

/** Resolve model find→replace pairs against the document: exact matches
 *  first, then typographically normalized ones. Matches inside existing
 *  CriticMarkup, no-op pairs, and pairs whose text would corrupt the
 *  markup are skipped. Exported for headless verification. */
export function matchEditPairs(
  doc: string,
  pairs: { find: string; replace: string }[],
): { changes: { from: number; to: number; insert: string }[]; missed: number } {
  const taken: [number, number][] = scanNotes(doc).map((n) => [n.from, n.to]);
  const overlaps = (from: number, to: number) =>
    taken.some(([f, t]) => from < t && to > f);
  const changes: { from: number; to: number; insert: string }[] = [];
  let ndoc: { norm: string; map: number[] } | null = null;
  let missed = 0;
  for (const p of pairs) {
    if (
      !p.find ||
      p.find === p.replace ||
      CRITIC_TOKENS.test(p.find + p.replace)
    ) {
      missed++;
      continue;
    }
    let found = false;
    const push = (
      from: number,
      to: number,
      original: string,
      replace: string,
    ) => {
      if (overlaps(from, to) || original === replace) return;
      changes.push({ from, to, insert: `{~~${original}~>${replace}~~}` });
      taken.push([from, to]);
      found = true;
    };
    // Exact occurrences take the model's replacement verbatim — matching
    // typography proves the model was not normalizing, and a note may
    // intentionally change quotes or ellipses.
    for (
      let idx = doc.indexOf(p.find);
      idx !== -1;
      idx = doc.indexOf(p.find, idx + p.find.length)
    ) {
      push(idx, idx + p.find.length, p.find, p.replace);
    }
    // Always also scan normalized: a document can mix straight and curly
    // forms, and `taken` already skips the spans the exact pass claimed.
    ndoc ??= normalize(doc);
    const nfind = normalize(p.find).norm;
    for (
      let nidx = nfind ? ndoc.norm.indexOf(nfind) : -1;
      nidx !== -1;
      nidx = ndoc.norm.indexOf(nfind, nidx + nfind.length)
    ) {
      const from = ndoc.map[nidx];
      const to = ndoc.map[nidx + nfind.length - 1] + 1;
      const original = doc.slice(from, to);
      push(from, to, original, repairReplace(p.replace, original));
    }
    if (!found) missed++;
  }
  return { changes, missed };
}

/** Insert a {~~find~>replace~~} suggestion at every match of each pair
 *  that lies outside existing CriticMarkup, in ONE transaction so a single
 *  undo reverts the whole drafted batch. */
export function applyEditsAsSuggestions(
  view: EditorView,
  pairs: { find: string; replace: string }[],
): { applied: number; missed: number } {
  const { changes, missed } = matchEditPairs(view.state.doc.toString(), pairs);
  if (changes.length) {
    // Land on the earliest suggestion so the result is immediately visible;
    // scroll positions are computed on the pre-change doc, and the earliest
    // change's start is unaffected by the other insertions.
    const first = Math.min(...changes.map((c) => c.from));
    view.dispatch({
      changes,
      selection: { anchor: first },
      effects: EditorView.scrollIntoView(first, { y: "center" }),
    });
  }
  return { applied: changes.length, missed };
}

/** Move the cursor to the next note or suggestion after it, wrapping to
 *  the first — one key cycles through everything awaiting review. */
export function gotoNextNote(view: EditorView): boolean {
  const notes = scanNotes(view.state.doc.toString());
  if (notes.length === 0) return false;
  const head = view.state.selection.main.head;
  const next = notes.find((n) => n.from > head) ?? notes[0];
  view.dispatch({
    selection: { anchor: next.from },
    effects: EditorView.scrollIntoView(next.from, { y: "center" }),
  });
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
      if (n.kind === "suggestion") {
        hide(n.from, n.oldFrom); // {~~
        if (n.oldFrom < n.oldTo) {
          decos.push(
            Decoration.mark({ class: "lp-sug-old" }).range(n.oldFrom, n.oldTo),
          );
        }
        hide(n.oldTo, n.newFrom); // ~>
        if (n.newFrom < n.newTo) {
          decos.push(
            Decoration.mark({ class: "lp-sug-new" }).range(n.newFrom, n.newTo),
          );
        }
        hide(n.newTo, n.to); // ~~}
      } else if (n.highlighted) {
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
