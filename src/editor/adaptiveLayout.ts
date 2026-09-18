import { StateField } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";

/** Infer word wrapping from ordinary paragraphs, excluding structural Markdown. */
export function detectWrapColumn(source: string): number | null {
  const pairs: { length: number; nextWord: number }[] = [];
  let textLength = 0;
  const tree = markdownLanguage.parser.parse(source);
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name !== "Paragraph") continue;
    const paragraph = source.slice(node.from, node.to);
    textLength += paragraph.length;
    const lines = paragraph.split(/\r?\n/);
    // Explicit line breaks express structure, not a formatter's width limit.
    if (lines.slice(0, -1).some((line) => /(?: {2,}|\\)$/.test(line))) continue;
    for (let i = 0; i < lines.length - 1; i++) {
      const nextWord = lines[i + 1].trimStart().match(/^\S+/)?.[0];
      if (nextWord)
        pairs.push({ length: lines[i].length, nextWord: nextWord.length });
    }
  }
  if (pairs.length < 6) return null;

  let bestColumn = 0;
  let bestMatches = 0;
  let matchedLength = 0;
  // Cover common source-formatting widths without mistaking long prose for them.
  for (let column = 40; column <= 160; column++) {
    // A wrapped line ends near the margin because its next word would not fit.
    const matching = pairs.filter(
      ({ length, nextWord }) =>
        length <= column &&
        length >= column - 16 &&
        length + 1 + nextWord > column,
    );
    if (matching.length > bestMatches) {
      bestColumn = column;
      bestMatches = matching.length;
      matchedLength = matching.reduce((sum, pair) => sum + pair.length, 0);
    }
  }
  // Mixed documents and sparse evidence keep the existing prose layout.
  return bestMatches >= 6 &&
    bestMatches / pairs.length >= 0.7 &&
    matchedLength / textLength >= 0.5
    ? bestColumn
    : null;
}

export const adaptiveLayout = StateField.define<number | null>({
  create: (state) => detectWrapColumn(state.doc.toString()),
  update(column, tr) {
    // Keep the layout stable while typing. Pasting/dropping a new document and
    // undoing those edits can change the formatting convention in one action.
    return tr.docChanged &&
      ["input.paste", "input.drop", "undo", "redo"].some((event) =>
        tr.isUserEvent(event),
      )
      ? detectWrapColumn(tr.newDoc.toString())
      : column;
  },
  provide: (field) => [
    EditorView.editorAttributes.compute(
      [field],
      (state): Record<string, string> => {
        const column = state.field(field);
        return column === null
          ? {}
          : {
              class: "cm-adaptive-layout",
              "data-wrap-column": String(column),
              style: `--wrapped-width: ${column}ch`,
            };
      },
    ),
    EditorView.contentAttributes.compute(
      [field],
      (state): Record<string, string> =>
        state.field(field) === null ? { class: "cm-lineWrapping" } : {},
    ),
  ],
});
