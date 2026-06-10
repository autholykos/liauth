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
import { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
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
  constructor(readonly checked: boolean, readonly pos: number) {
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
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

/** Does any selection range touch the line(s) covering [from, to]? */
function selectionOnLine(state: EditorState, from: number, to: number): boolean {
  const start = state.doc.lineAt(from);
  const end = to <= start.to ? start : state.doc.lineAt(to);
  return selectionTouches(state, start.from, end.to);
}

function buildDecorations(view: EditorView): DecorationSet {
  const decos: Range<Decoration>[] = [];
  const state = view.state;

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
            Decoration.line({ class: `lp-heading lp-h${heading[1]}` }).range(line.from)
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
            decos.push(Decoration.replace({}).range(node.from, hideTo));
            return;
          }

          case "EmphasisMark":
          case "CodeMark":
          case "StrikethroughMark": {
            const parent = node.node.parent;
            if (parent && selectionTouches(state, parent.from, parent.to)) {
              decos.push(Decoration.mark({ class: "lp-mark" }).range(node.from, node.to));
            } else {
              decos.push(Decoration.replace({}).range(node.from, node.to));
            }
            return;
          }

          case "Emphasis":
            decos.push(Decoration.mark({ class: "lp-em" }).range(node.from, node.to));
            return;
          case "StrongEmphasis":
            decos.push(Decoration.mark({ class: "lp-strong" }).range(node.from, node.to));
            return;
          case "Strikethrough":
            decos.push(Decoration.mark({ class: "lp-strike" }).range(node.from, node.to));
            return;
          case "InlineCode":
            decos.push(Decoration.mark({ class: "lp-inline-code" }).range(node.from, node.to));
            return;

          case "Link":
          case "Image": {
            const revealed = selectionTouches(state, node.from, node.to);
            decos.push(Decoration.mark({ class: "lp-link" }).range(node.from, node.to));
            if (revealed) return;
            // Hide everything except the [text] part.
            const n = node.node;
            for (let child = n.firstChild; child; child = child.nextSibling) {
              if (child.name === "LinkMark") {
                decos.push(Decoration.replace({}).range(child.from, child.to));
              } else if (child.name === "URL" || child.name === "LinkTitle") {
                decos.push(Decoration.replace({}).range(child.from, child.to));
              }
            }
            return;
          }

          case "QuoteMark": {
            if (selectionOnLine(state, node.from, node.to)) return;
            const after = state.doc.sliceString(node.to, node.to + 1);
            const hideTo = after === " " ? node.to + 1 : node.to;
            decos.push(Decoration.replace({}).range(node.from, hideTo));
            return;
          }

          case "Blockquote": {
            const first = state.doc.lineAt(node.from);
            const last = state.doc.lineAt(node.to);
            for (let l = first.number; l <= last.number; l++) {
              decos.push(
                Decoration.line({ class: "lp-blockquote" }).range(state.doc.line(l).from)
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
            decos.push(
              Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to)
            );
            return;
          }

          case "TaskMarker": {
            if (selectionOnLine(state, node.from, node.to)) return;
            const text = state.doc.sliceString(node.from, node.to).toLowerCase();
            const checked = text.includes("x");
            // Hide the list mark before it as well: "- [x]" -> checkbox.
            const line = state.doc.lineAt(node.from);
            const before = state.doc.sliceString(line.from, node.from);
            const listMark = before.match(/([-*+]\s*)$/);
            const start = listMark ? node.from - listMark[1].length : node.from;
            decos.push(
              Decoration.replace({
                widget: new CheckboxWidget(checked, node.from),
              }).range(start, node.to)
            );
            return;
          }

          case "HorizontalRule": {
            if (selectionOnLine(state, node.from, node.to)) return;
            decos.push(
              Decoration.replace({ widget: new HrWidget() }).range(node.from, node.to)
            );
            return;
          }

          case "FencedCode":
          case "CodeBlock": {
            const first = state.doc.lineAt(node.from);
            const last = state.doc.lineAt(node.to);
            for (let l = first.number; l <= last.number; l++) {
              decos.push(
                Decoration.line({ class: "lp-codeblock" }).range(state.doc.line(l).from)
              );
            }
            return;
          }
        }
      },
    });
  }

  return Decoration.set(decos, true);
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);
