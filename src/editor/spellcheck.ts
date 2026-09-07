import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";

/**
 * Native spell checking. WebKit checks the contenteditable with the macOS
 * dictionaries once the attribute is on; markup that is not prose is
 * opted out again through descendant attributes, which WebKit honours.
 */

/** Syntax nodes whose text is never prose. */
const NOT_PROSE = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "URL",
  "Autolink",
  "LinkTitle",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
]);

const notProse = Decoration.mark({ attributes: { spellcheck: "false" } });

function excludedRanges(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!NOT_PROSE.has(node.name) || node.from === node.to) return;
        marks.push(notProse.range(node.from, node.to));
        return false;
      },
    });
  }
  return Decoration.set(marks, true);
}

const exclusions = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = excludedRanges(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = excludedRanges(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const spellcheck = [
  EditorView.contentAttributes.of({ spellcheck: "true" }),
  exclusions,
];
