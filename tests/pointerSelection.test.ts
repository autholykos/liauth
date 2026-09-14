import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorState } from "../src/editor/setup";
import { clearKeylog, saveKeylog } from "../src/editor/keylog";
import { writeKeylog } from "../src/api";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("test"),
}));
vi.mock("../src/api", () => ({
  writeKeylog: vi.fn().mockResolvedValue("test-keylog"),
}));

let view: EditorView;
const clicked = 108 * 6 + 2;
const scrolled = 95 * 6;

beforeEach(() => {
  Vim.resetVimGlobalState_();
  clearKeylog();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      "prose\n".repeat(120),
      { onChange() {}, onSave() {} },
      { vim: true },
    ),
  });
});
afterEach(() => {
  view.destroy();
  vi.restoreAllMocks();
});

function mouse(type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "mouseup" ? 0 : 1,
    detail: 1,
    clientX: 100,
    clientY: 200,
    ...init,
  });
  (type === "mousedown" ? view.contentDOM : document).dispatchEvent(event);
  return event;
}

function focusThatScrolls() {
  view.scrollDOM.scrollTop = 500;
  view.scrollDOM.scrollLeft = 30;
  const nativeFocus = view.contentDOM.focus.bind(view.contentDOM);
  vi.spyOn(view.contentDOM, "focus").mockImplementation((options) => {
    void options?.preventScroll;
    nativeFocus(options);
    // WebKit can scroll despite preventScroll. The same screen point then
    // refers to an earlier line between the two CodeMirror hit tests.
    view.scrollDOM.scrollTop = 300;
    view.scrollDOM.scrollLeft = 0;
  });
  const geometry = view as unknown as {
    posAndSideAtCoords: (
      point: { x: number; y: number },
      precise: boolean,
    ) => { pos: number; assoc: number };
  };
  return vi.spyOn(geometry, "posAndSideAtCoords").mockImplementation(() => ({
    pos: view.scrollDOM.scrollTop === 500 ? clicked : scrolled,
    assoc: 1,
  }));
}

it.each([false, true])(
  "keeps a refocusing click at the clicked line (Vim: %s)",
  (vim) => {
    view.setState(
      createEditorState(
        "prose\n".repeat(120),
        { onChange() {}, onSave() {} },
        { vim },
      ),
    );
    focusThatScrolls();
    mouse("mousedown");
    mouse("mouseup");
    expect(view.state.selection.main.empty).toBe(true);
    expect(view.state.selection.main.head).toBe(clicked);
    if (vim) expect(getCM(view)!.state.vim.visualMode).toBe(false);
    expect(view.scrollDOM.scrollTop).toBe(500);
    expect(view.scrollDOM.scrollLeft).toBe(30);
  },
);

it("still extends a selection on Shift-click after refocusing", () => {
  view.dispatch({ selection: { anchor: 2 } });
  focusThatScrolls();
  mouse("mousedown", { shiftKey: true });
  mouse("mouseup", { shiftKey: true });
  expect(view.state.selection.main.anchor).toBe(2);
  expect(view.state.selection.main.head).toBe(clicked);
  expect(getCM(view)!.state.vim.visualMode).toBe(true);
});

it("still selects by dragging after refocusing", () => {
  const geometry = focusThatScrolls();
  mouse("mousedown");
  geometry.mockReturnValue({ pos: clicked + 9, assoc: 1 });
  mouse("mousemove", { clientX: 125 });
  mouse("mouseup", { clientX: 125 });
  expect(view.state.selection.main.anchor).toBe(clicked);
  expect(view.state.selection.main.head).toBe(clicked + 9);
});

it("collapses a prior Visual selection on a plain click", () => {
  view.dispatch({ selection: { anchor: 2, head: clicked + 9 } });
  expect(getCM(view)!.state.vim.visualMode).toBe(true);
  focusThatScrolls();
  mouse("mousedown");
  mouse("mouseup");
  expect(view.state.selection.main.empty).toBe(true);
  expect(view.state.selection.main.head).toBe(clicked);
  expect(getCM(view)!.state.vim.visualMode).toBe(false);
});

it("records pointer modifiers, release, scroll and resulting selection", async () => {
  focusThatScrolls();
  mouse("mousedown", { shiftKey: true });
  mouse("mouseup", { shiftKey: true });
  await saveKeylog(view);
  const records = vi
    .mocked(writeKeylog)
    .mock.calls.at(-1)![0]
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.find((r) => r.type === "mousedown")).toMatchObject({
    button: 0,
    buttons: 1,
    clicks: 1,
    x: 100,
    y: 200,
    mods: "S",
    scrollTop: 500,
  });
  expect(records.find((r) => r.type === "mouseup")).toMatchObject({
    buttons: 0,
    scrollTop: 500,
  });
  expect(records.find((r) => r.type === "editor:selection")).toMatchObject({
    detail: "select.pointer",
    sel: "1:1-109:3",
  });
});

it.each([2, 3])("preserves selection from a %i-click gesture", (detail) => {
  focusThatScrolls();
  mouse("mousedown", { detail });
  mouse("mouseup", { detail });
  expect(view.state.selection.main.from).toBe(108 * 6);
  expect(view.state.selection.main.to).toBe(108 * 6 + (detail === 2 ? 5 : 6));
});
