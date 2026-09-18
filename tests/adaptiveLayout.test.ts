import { afterEach, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { detectWrapColumn } from "../src/editor/adaptiveLayout";
import { createEditorState, setEditorOption } from "../src/editor/setup";
import { wrappedMarkdown } from "./fixtures/wrappedMarkdown";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
});

it.each([40, 60, 80, 100, 120, 160])(
  "recognizes paragraphs wrapped around %i columns",
  (width) => {
    const detected = detectWrapColumn(wrappedMarkdown(width));
    expect(detected).not.toBeNull();
    expect(detected!).toBeGreaterThanOrEqual(width - 5);
    expect(detected!).toBeLessThanOrEqual(width);
  },
);

it("keeps prose, sentence-per-line writing and sparse evidence in the usual layout", () => {
  expect(
    detectWrapColumn(wrappedMarkdown().replace(/(?<!\n)\n(?!\n)/g, " ")),
  ).toBeNull();
  expect(
    detectWrapColumn("A short sentence.\nAnd another.\n".repeat(20)),
  ).toBeNull();
  expect(
    detectWrapColumn(wrappedMarkdown().split("\n").slice(0, 6).join("\n")),
  ).toBeNull();
  expect(detectWrapColumn("")).toBeNull();
});

it("ignores code, tables, lists, quotations and explicit hard line breaks", () => {
  const body = wrappedMarkdown().split("\n\n")[1];
  for (const document of [
    "```text\n" + body + "\n```",
    body
      .split("\n")
      .map((line) => "    " + line)
      .join("\n"),
    body
      .split("\n")
      .map((line) => "- " + line)
      .join("\n"),
    body
      .split("\n")
      .map((line) => "> " + line)
      .join("\n"),
    "| Heading | Value |\n| --- | --- |\n" +
      body
        .split("\n")
        .map((line) => `| ${line} | value |`)
        .join("\n"),
    body.replaceAll("\n", "  \n"),
    body.replaceAll("\n", "\\\n"),
  ])
    expect(detectWrapColumn(document)).toBeNull();
});

it("keeps mixed documents with predominantly unwrapped prose in the usual layout", () => {
  const wrapped = wrappedMarkdown();
  expect(
    detectWrapColumn(wrapped + "\n\n" + "Ordinary prose. ".repeat(600)),
  ).toBeNull();
});

it("preserves text, selection, editability and Undo when automatic layout is disabled", () => {
  const doc = wrappedMarkdown();
  view = new EditorView({
    parent: document.body,
    state: createEditorState(doc, { onChange() {}, onSave() {} }),
  });
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(true);
  expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
  expect(view.state.readOnly).toBe(false);
  view.dispatch({
    changes: { from: 0, insert: "Edited " },
    selection: { anchor: 5 },
  });
  setEditorOption(view, "adaptiveLayout", false);
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(false);
  expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
  expect(view.state.selection.main.head).toBe(5);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(doc);
  setEditorOption(view, "adaptiveLayout", true);
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(true);
});

it("detects pasted formatting and follows undo, redo and document replacement", () => {
  view = new EditorView({
    parent: document.body,
    state: createEditorState("", { onChange() {}, onSave() {} }),
  });
  const doc = wrappedMarkdown();
  view.dispatch({
    changes: { from: 0, insert: doc },
    userEvent: "input.paste",
  });
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(true);
  expect(undo(view)).toBe(true);
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(false);
  expect(redo(view)).toBe(true);
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(true);
  view.setState(
    createEditorState("Normal prose.", { onChange() {}, onSave() {} }),
  );
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(false);
  expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
});
