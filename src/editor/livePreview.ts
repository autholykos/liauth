/**
 * Typora-style live preview for CodeMirror 6.
 *
 * The markdown source is the document model; this extension renders it
 * in place by hiding syntax markers (#, **, `, [](), >, -) except where
 * the selection touches the enclosing node, which "reveals" the source
 * for editing.
 */
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { EditorState, Range, StateField } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { SyntaxNodeRef } from "@lezer/common";

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "lp-bullet";
    span.textContent = "•";
    return span;
  }
  eq(): boolean {
    return true;
  }
}

class HrWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement("hr");
    hr.className = "lp-hr";
    return hr;
  }
  eq(): boolean {
    return true;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number,
  ) {
    super();
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "lp-checkbox";
    box.checked = this.checked;
    box.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: {
          from: this.pos,
          to: this.pos + 3,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });
    return box;
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.pos === this.pos;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const HEADING_RE = /^ATXHeading(\d)$/;

/** Does any selection range touch [from, to]? */
function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** Does any selection range touch the line(s) covering [from, to]? */
function selectionOnLine(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  const start = state.doc.lineAt(from);
  const end = to <= start.to ? start : state.doc.lineAt(to);
  return selectionTouches(state, start.from, end.to);
}

interface PreviewSets {
  decorations: DecorationSet;
  /** The hidden (replaced) ranges, exposed as atomic ranges so clicks and
   *  cursor motion can never land inside invisible text. */
  atomic: DecorationSet;
}

function buildDecorations(view: EditorView): PreviewSets {
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

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node: SyntaxNodeRef) => {
        const name = node.name;

        const heading = HEADING_RE.exec(name);
        if (heading) {
          const line = state.doc.lineAt(node.from);
          decos.push(
            Decoration.line({ class: `lp-heading lp-h${heading[1]}` }).range(
              line.from,
            ),
          );
          return;
        }

        switch (name) {
          case "HeaderMark": {
            // ATX `#` marks (and setext underlines). Hide together with
            // the following space when the cursor is elsewhere.
            if (selectionOnLine(state, node.from, node.to)) return;
            const after = state.doc.sliceString(node.to, node.to + 1);
            const hideTo = after === " " ? node.to + 1 : node.to;
            hide(node.from, hideTo);
            return;
          }

          case "EmphasisMark":
          case "CodeMark":
          case "StrikethroughMark": {
            const parent = node.node.parent;
            if (parent && selectionTouches(state, parent.from, parent.to)) {
              decos.push(
                Decoration.mark({ class: "lp-mark" }).range(node.from, node.to),
              );
            } else {
              hide(node.from, node.to);
            }
            return;
          }

          case "Emphasis":
            decos.push(
              Decoration.mark({ class: "lp-em" }).range(node.from, node.to),
            );
            return;
          case "StrongEmphasis":
            decos.push(
              Decoration.mark({ class: "lp-strong" }).range(node.from, node.to),
            );
            return;
          case "Strikethrough":
            decos.push(
              Decoration.mark({ class: "lp-strike" }).range(node.from, node.to),
            );
            return;
          case "InlineCode":
            decos.push(
              Decoration.mark({ class: "lp-inline-code" }).range(
                node.from,
                node.to,
              ),
            );
            return;

          case "Link":
          case "Image": {
            const revealed = selectionTouches(state, node.from, node.to);
            decos.push(
              Decoration.mark({ class: "lp-link" }).range(node.from, node.to),
            );
            if (revealed) return;
            // Hide everything except the [text] part.
            const n = node.node;
            for (let child = n.firstChild; child; child = child.nextSibling) {
              if (
                child.name === "LinkMark" ||
                child.name === "URL" ||
                child.name === "LinkTitle"
              ) {
                hide(child.from, child.to);
              }
            }
            return;
          }

          case "QuoteMark": {
            if (selectionOnLine(state, node.from, node.to)) return;
            const after = state.doc.sliceString(node.to, node.to + 1);
            const hideTo = after === " " ? node.to + 1 : node.to;
            hide(node.from, hideTo);
            return;
          }

          case "Blockquote": {
            const first = state.doc.lineAt(node.from);
            const last = state.doc.lineAt(node.to);
            for (let l = first.number; l <= last.number; l++) {
              decos.push(
                Decoration.line({ class: "lp-blockquote" }).range(
                  state.doc.line(l).from,
                ),
              );
            }
            return;
          }

          case "ListMark": {
            const mark = state.doc.sliceString(node.from, node.to);
            const isBullet = mark === "-" || mark === "*" || mark === "+";
            if (!isBullet) return; // keep ordered-list numbers visible
            // Task items get their checkbox from TaskMarker instead.
            const next = node.node.nextSibling;
            if (next && next.name === "Task") return;
            if (selectionOnLine(state, node.from, node.to)) return;
            hide(node.from, node.to, { widget: new BulletWidget() });
            return;
          }

          case "TaskMarker": {
            if (selectionOnLine(state, node.from, node.to)) return;
            const text = state.doc
              .sliceString(node.from, node.to)
              .toLowerCase();
            const checked = text.includes("x");
            // Hide the list mark before it as well: "- [x]" -> checkbox.
            const line = state.doc.lineAt(node.from);
            const before = state.doc.sliceString(line.from, node.from);
            const listMark = before.match(/([-*+]\s*)$/);
            const start = listMark ? node.from - listMark[1].length : node.from;
            hide(start, node.to, {
              widget: new CheckboxWidget(checked, node.from),
            });
            return;
          }

          case "HorizontalRule": {
            if (selectionOnLine(state, node.from, node.to)) return;
            hide(node.from, node.to, { widget: new HrWidget() });
            return;
          }

          case "FencedCode":
          case "CodeBlock": {
            const first = state.doc.lineAt(node.from);
            const last = state.doc.lineAt(node.to);
            for (let l = first.number; l <= last.number; l++) {
              decos.push(
                Decoration.line({ class: "lp-codeblock" }).range(
                  state.doc.line(l).from,
                ),
              );
            }
            return;
          }
        }
      },
    });
  }

  return {
    decorations: Decoration.set(decos, true),
    atomic: Decoration.set(hides, true),
  };
}

class LivePreviewPlugin {
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

export const livePreview = ViewPlugin.fromClass(LivePreviewPlugin, {
  decorations: (v) => v.decorations,
  provide: (plugin) =>
    EditorView.atomicRanges.of(
      (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
    ),
});

// ---------------------------------------------------------------------------
// Table rendering.
//
// A whole GFM table is replaced by a rendered <table> block widget unless the
// selection is inside it, in which case the source is shown (monospaced, so
// the pipes line up). Replacing decorations that span line breaks must be
// provided by a StateField, not a ViewPlugin, so tables live here rather
// than in LivePreviewPlugin.

interface TableCellData {
  /** Offset of the cell relative to the table start. */
  offset: number;
  text: string;
}

interface TableRowData {
  header: boolean;
  cells: TableCellData[];
}

/** Render a cell's inline markdown (code, links, bold, italic, strike). */
function renderInline(text: string, out: HTMLElement): void {
  const RE =
    /(`+)(.+?)\1|!?\[([^\]]*)\]\(([^)]*)\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const flush = (to: number) => {
    if (to > last)
      out.appendChild(
        document.createTextNode(text.slice(last, to).replace(/\\\|/g, "|")),
      );
  };
  while ((m = RE.exec(text))) {
    flush(m.index);
    const el = document.createElement("span");
    if (m[2] !== undefined) {
      el.className = "lp-inline-code";
      el.textContent = m[2];
    } else if (m[3] !== undefined) {
      el.className = "lp-link";
      renderInline(m[3], el);
    } else {
      const inner = m[5] ?? m[6] ?? m[7] ?? m[8] ?? m[9];
      el.className =
        m[9] !== undefined
          ? "lp-strike"
          : (m[7] ?? m[8])
            ? "lp-em"
            : "lp-strong";
      renderInline(inner, el);
    }
    out.appendChild(el);
    last = RE.lastIndex;
  }
  flush(text.length);
}

function parseAligns(delimiter: string): string[] {
  return delimiter
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => {
      const t = c.trim();
      if (t.startsWith(":") && t.endsWith(":")) return "center";
      if (t.endsWith(":")) return "right";
      return "left";
    });
}

class TableWidget extends WidgetType {
  constructor(
    readonly rows: TableRowData[],
    readonly aligns: string[],
    /** Full table source, used for cheap DOM reuse via eq(). */
    readonly key: string,
  ) {
    super();
  }

  eq(other: TableWidget): boolean {
    return other.key === this.key;
  }

  get estimatedHeight(): number {
    return this.rows.length * 34;
  }

  toDOM(view: EditorView): HTMLElement {
    // Wrapper allows horizontal scrolling when the table is wider than the
    // editor content area.
    const wrap = document.createElement("div");
    wrap.className = "lp-table-wrap";
    const table = wrap.appendChild(document.createElement("table"));
    table.className = "lp-table";
    const cols = Math.max(...this.rows.map((r) => r.cells.length));
    for (const row of this.rows) {
      const tr = table.appendChild(document.createElement("tr"));
      for (let i = 0; i < cols; i++) {
        const cell = row.cells[i];
        const el = tr.appendChild(
          document.createElement(row.header ? "th" : "td"),
        );
        el.style.textAlign = this.aligns[i] ?? "left";
        if (!cell) continue;
        el.dataset.offset = String(cell.offset);
        renderInline(cell.text, el);
      }
    }
    // Clicking a cell reveals the table and puts the cursor on that cell's
    // source. The widget's own position is resolved at click time so the
    // handler stays valid when eq() lets the DOM be reused after edits
    // elsewhere in the document.
    table.addEventListener("mousedown", (e) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("td,th");
      if (!cell) return;
      e.preventDefault();
      const base = view.posAtDOM(table);
      const offset = Number(cell.dataset.offset ?? 0);
      view.dispatch({
        selection: { anchor: base + offset },
        scrollIntoView: true,
      });
      view.focus();
    });
    return wrap;
  }
}

function buildTableDecos(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const tree =
    ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({
    enter: (node: SyntaxNodeRef) => {
      if (node.name !== "Table") return;
      if (selectionOnLine(state, node.from, node.to)) {
        // Revealed: keep the source, but monospace it so columns align.
        const first = state.doc.lineAt(node.from);
        const last = state.doc.lineAt(node.to);
        for (let l = first.number; l <= last.number; l++) {
          decos.push(
            Decoration.line({ class: "lp-table-source" }).range(
              state.doc.line(l).from,
            ),
          );
        }
        return false;
      }
      const rows: TableRowData[] = [];
      let aligns: string[] = [];
      for (let child = node.node.firstChild; child; child = child.nextSibling) {
        if (child.name === "TableDelimiter") {
          aligns = parseAligns(state.doc.sliceString(child.from, child.to));
        } else if (child.name === "TableHeader" || child.name === "TableRow") {
          const cells: TableCellData[] = [];
          for (let c = child.firstChild; c; c = c.nextSibling) {
            if (c.name === "TableCell") {
              cells.push({
                offset: c.from - node.from,
                text: state.doc.sliceString(c.from, c.to),
              });
            }
          }
          rows.push({ header: child.name === "TableHeader", cells });
        }
      }
      if (!rows.length) return false;
      const key = state.doc.sliceString(node.from, node.to);
      decos.push(
        Decoration.replace({
          widget: new TableWidget(rows, aligns, key),
          block: true,
        }).range(node.from, node.to),
      );
      return false;
    },
  });
  return Decoration.set(decos, true);
}

export const tableRendering = StateField.define<DecorationSet>({
  create: buildTableDecos,
  update(decos, tr) {
    if (!tr.docChanged && !tr.selection) return decos;
    return buildTableDecos(tr.state);
  },
  provide: (f) => EditorView.decorations.from(f),
});
