import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorState, setEditorOption } from "../src/editor/setup";
import { applyVimrc } from "../src/editor/vimrc";
import { clearKeylog, saveKeylog } from "../src/editor/keylog";
import { writeKeylog } from "../src/api";
import { wrappedMarkdown } from "./fixtures/wrappedMarkdown";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));
vi.mock("../src/api", () => ({
  writeKeylog: vi.fn().mockResolvedValue("test-keylog"),
}));

let view: EditorView;
beforeEach(() => {
  Vim.resetVimGlobalState_();
  clearKeylog();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});

it("searches after replacing a long document with a shorter one", () => {
  const original = "word\n".repeat(100);
  const callbacks = { onChange() {}, onSave() {} };
  view = new EditorView({
    parent: document.body,
    state: createEditorState(original, callbacks, { vim: true }),
  });
  applyVimrc("test", "nnoremap n nzzzv\nnnoremap N Nzzzv");
  const previous = getCM(view)!;
  previous.setCursor({ line: 90, ch: 0 });
  for (const key of ['"', "a", "y", "y"]) Vim.handleKey(previous, key, "user");
  const bookmark = previous.setBookmark({ line: 0, ch: 0 });
  Vim.handleKey(previous, "*", "user");
  view.setState(
    createEditorState("word one\nword two\nword three", callbacks, {
      vim: true,
    }),
  );
  expect(bookmark.find()).toBeNull();
  expect(Vim.getRegisterController().getRegister("a").toString()).toBe(
    "word\n",
  );
  const current = getCM(view)!;
  Vim.handleKey(current, "/", "user");
  const input = view.dom.querySelector("input")!;
  input.value = "word";
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(input.isConnected).toBe(false);
  expect(current.getCursor()).toEqual({ line: 1, ch: 0 });
  const next = new KeyboardEvent("keydown", {
    key: "n",
    keyCode: 78,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(next);
  expect(next.defaultPrevented).toBe(true);
  expect(current.getCursor()).toEqual({ line: 2, ch: 0 });
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "N",
      keyCode: 78,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(current.getCursor()).toEqual({ line: 1, ch: 0 });
});

it("keeps search and n/N working across adaptive layout changes", () => {
  const doc = wrappedMarkdown();
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      doc,
      { onChange() {}, onSave() {} },
      { vim: true },
    ),
  });
  expect(view.dom.classList.contains("cm-adaptive-layout")).toBe(true);
  Vim.handleKey(getCM(view)!, "/", "user");
  const input = view.dom.querySelector("input")!;
  input.value = "service";
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  const first = doc.indexOf("service");
  const second = doc.indexOf("service", first + 1);
  expect(view.state.selection.main.head).toBe(first);
  setEditorOption(view, "adaptiveLayout", false);
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "n",
      keyCode: 78,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(view.state.selection.main.head).toBe(second);
  setEditorOption(view, "adaptiveLayout", true);
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "N",
      keyCode: 78,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(view.state.selection.main.head).toBe(first);
  expect(view.state.doc.toString()).toBe(doc);
});

it("repeats the existing search after disabling Vim and shortening the document", () => {
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      "word\n".repeat(100),
      { onChange() {}, onSave() {} },
      { vim: true },
    ),
  });
  const previous = getCM(view)!;
  previous.setCursor({ line: 90, ch: 0 });
  Vim.handleKey(previous, "*", "user");
  setEditorOption(view, "vim", false);
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: "word one\nword two",
    },
    selection: { anchor: 0 },
  });
  setEditorOption(view, "vim", true);
  const current = getCM(view)!;
  expect(Vim.handleKey(current, "n", "user")).toBe(true);
  expect(current.getCursor()).toEqual({ line: 1, ch: 0 });
});

it("keeps active bookmarks mapped through edits and ordinary option changes", () => {
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      "one\ntwo",
      { onChange() {}, onSave() {} },
      { vim: true },
    ),
  });
  const cm = getCM(view)!;
  const bookmark = cm.setBookmark({ line: 1, ch: 1 });
  view.dispatch({ changes: { from: 0, insert: "prefix\n" } });
  setEditorOption(view, "lineNumbers", true);
  expect(bookmark.find()).toEqual({ line: 2, ch: 1 });
  view.dispatch({
    changes: { from: view.state.doc.line(3).from, to: view.state.doc.length },
  });
  expect(bookmark.find()).toBeNull();
});
afterEach(() => {
  view?.destroy();
  Vim.unmap("n", "normal");
  Vim.unmap("N", "normal");
  vi.restoreAllMocks();
});

it("repeats an accented search with the configured centered n/N mappings", () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      "Una realtà.\nUn'altra realtà.\nLa realtà.",
      { onChange() {}, onSave() {} },
      { vim: true },
    ),
  });
  applyVimrc("test", "nnoremap n nzzzv\nnnoremap N Nzzzv");
  const cm = getCM(view)!;
  Vim.handleKey(cm, "/", "user");
  const input = view.dom.querySelector("input")!;
  input.value = "realtà";
  input.dispatchEvent(
    new KeyboardEvent("keyup", { key: "a", keyCode: 65, bubbles: true }),
  );
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
  input.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }),
  );
  expect(input.isConnected).toBe(false);
  expect(cm.getCursor()).toEqual({ line: 0, ch: 4 });
  Vim.handleKey(cm, "n", "user");
  expect(cm.getCursor()).toEqual({ line: 1, ch: 9 });
  Vim.handleKey(cm, "N", "user");
  expect(cm.getCursor()).toEqual({ line: 0, ch: 4 });
});

it.each(["missing", "[", ""])(
  "handles n after a query with no match: %s",
  (query) => {
    Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    view = new EditorView({
      parent: document.body,
      state: createEditorState(
        "Some text",
        { onChange() {}, onSave() {} },
        { vim: true },
      ),
    });
    applyVimrc("test", "nnoremap n nzzzv\nnnoremap N Nzzzv");
    const cm = getCM(view)!;
    Vim.handleKey(cm, "/", "user");
    const input = view.dom.querySelector("input")!;
    input.value = query;
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(input.isConnected).toBe(false);
    const handled = Vim.handleKey(cm, "n", "user");
    expect(handled).toBe(true);
  },
);

it("closes a search prompt and records the exception when search execution fails", async () => {
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      "Some text",
      { onChange() {}, onSave() {} },
      { vim: true },
    ),
  });
  const cm = getCM(view)!;
  Vim.handleKey(cm, "/", "user");
  const input = view.dom.querySelector("input")!;
  input.value = "text";
  vi.spyOn(cm, "getSearchCursor").mockImplementationOnce(() => {
    throw new Error("search cursor failed");
  });
  const handledError = (event: ErrorEvent) => event.preventDefault();
  window.addEventListener("error", handledError);
  try {
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(input.isConnected).toBe(false);
    expect(view.hasFocus).toBe(true);
    await saveKeylog(view);
    const records = vi
      .mocked(writeKeylog)
      .mock.calls.at(-1)![0]
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      records.some(
        (record) =>
          record.type === "editor:error" &&
          record.detail.includes("search cursor failed"),
      ),
    ).toBe(true);
  } finally {
    window.removeEventListener("error", handledError);
  }
});

it("records a repeat-search exception caught by CodeMirror after Vim is toggled on", async () => {
  const { setEditorOption } = await import("../src/editor/setup");
  view = new EditorView({
    parent: document.body,
    state: createEditorState("Some text", { onChange() {}, onSave() {} }),
  });
  setEditorOption(view, "vim", true);
  view.focus();
  vi.spyOn(Vim, "multiSelectHandleKey").mockImplementationOnce(() => {
    throw new Error("repeat failed");
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "n",
      keyCode: 78,
      bubbles: true,
      cancelable: true,
    }),
  );
  await saveKeylog(view);
  const records = vi
    .mocked(writeKeylog)
    .mock.calls.at(-1)![0]
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    records.some((record) => record.type === "vim:key" && record.key === "n"),
  ).toBe(true);
  expect(
    records.some(
      (record) =>
        record.type === "editor:error" &&
        record.detail.includes("repeat failed"),
    ),
  ).toBe(true);
});
