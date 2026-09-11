import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorState } from "../src/editor/setup";
import { applyVimrc } from "../src/editor/vimrc";
import { clearKeylog, saveKeylog } from "../src/editor/keylog";
import { writeKeylog } from "../src/api";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));
vi.mock("../src/api", () => ({
  writeKeylog: vi.fn().mockResolvedValue("test-keylog"),
}));

let view: EditorView;
beforeEach(() => {
  clearKeylog();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
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
