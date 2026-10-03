import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { createEditorState, setEditorOption } from "../src/editor/setup";
import {
  openSpellingContextMenu,
  setSpellingLanguage,
} from "../src/editor/spellcheck";
import * as api from "../src/api";
import { showSpellingMenu } from "../src/menu";

vi.mock("../src/api", () => ({
  checkSpelling: vi.fn(),
  spellingSuggestions: vi.fn(),
  learnSpellingWord: vi.fn(),
  writeKeylog: vi.fn(),
}));
vi.mock("../src/menu", () => ({
  showSpellingMenu: vi.fn().mockResolvedValue(undefined),
}));
let view: EditorView;
const typo = "cosìgranitico";
const notice = vi.fn();
const create = (text: string) => {
  view = new EditorView({
    parent: document.body,
    state: createEditorState(
      text,
      { onChange() {}, onSave() {}, onNotice: notice },
      { spellcheck: true, spellingLanguage: "it" },
    ),
  });
  return view;
};
const marks = () =>
  [...view.dom.querySelectorAll(".cm-spelling-error")].map(
    (el) => el.textContent,
  );
const settle = () => vi.advanceTimersByTimeAsync(600);
const contextMenu = async () => {
  view.dispatch({ selection: { anchor: 0 } });
  expect(
    openSpellingContextMenu(view, view.dom.querySelector(".cm-spelling-error")),
  ).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  return vi.mocked(showSpellingMenu).mock.calls.at(-1)!;
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  vi.mocked(api.checkSpelling).mockImplementation(async (text) => ({
    supported: true,
    ranges: [...text.matchAll(/cosìgranitico/g)].map((m) => ({
      from: m.index!,
      to: m.index! + typo.length,
    })),
  }));
  vi.mocked(api.spellingSuggestions).mockResolvedValue(["così granitico"]);
  vi.mocked(api.learnSpellingWord).mockResolvedValue(undefined);
});
afterEach(() => {
  view?.destroy();
  vi.useRealTimers();
});

it("discards old responses after a document or dictionary change", async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.checkSpelling>>) => void;
  vi.mocked(api.checkSpelling).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  create(typo);
  await settle();
  view.dispatch({ changes: { from: 0, insert: "😀 " } });
  setSpellingLanguage(view, "en_US");
  finish({ supported: true, ranges: [{ from: 0, to: typo.length }] });
  await vi.advanceTimersByTimeAsync(0);
  expect(marks()).toEqual([]);
  await settle();
  expect(api.checkSpelling).toHaveBeenLastCalledWith(`😀 ${typo}`, "en_US");
  expect(marks()).toEqual([typo]);
  expect(view.posAtDOM(view.dom.querySelector(".cm-spelling-error")!)).toBe(3);
});

it("keeps marks of untouched words visible while an edit is rechecked", async () => {
  create(`Inizio ${typo} e ${typo}`);
  await settle();
  expect(marks()).toEqual([typo, typo]);
  view.dispatch({ changes: { from: 0, insert: "Nuovo " } });
  expect(marks()).toEqual([typo, typo]);
  const end = view.state.doc.length;
  view.dispatch({ changes: { from: end - 1, to: end, insert: "a" } });
  expect(marks()).toEqual([typo]);
  await settle();
  expect(api.checkSpelling).toHaveBeenLastCalledWith(
    `Nuovo Inizio ${typo} e ${typo.slice(0, -1)}a`,
    "it",
  );
  expect(marks()).toEqual([typo]);
});

it("corrects with Undo and keeps ignored words across spelling toggles", async () => {
  create(typo);
  await settle();
  const first = await contextMenu();
  expect(api.spellingSuggestions).toHaveBeenCalledWith(typo, "it");
  first[1]!("così granitico");
  expect(view.state.doc.toString()).toBe("così granitico");
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe(typo);
  await settle();
  const second = await contextMenu();
  second[2]();
  expect(marks()).toEqual([]);
  setEditorOption(view, "spellcheck", false);
  setEditorOption(view, "spellcheck", true);
  await settle();
  expect(marks()).toEqual([]);
  expect(view.state.doc.toString()).toBe(typo);
});

it("learns a spelling without editing the document and ignores stale menu callbacks", async () => {
  create(typo);
  await settle();
  const first = await contextMenu();
  first[3]();
  await vi.advanceTimersByTimeAsync(0);
  expect(api.learnSpellingWord).toHaveBeenCalledWith(typo);
  expect(marks()).toEqual([]);
  expect(view.state.doc.toString()).toBe(typo);
  view.dispatch({ changes: { from: 0, insert: "New " } });
  first[1]!("così granitico");
  expect(view.state.doc.toString()).toBe(`New ${typo}`);
});

it("bounds large requests and falls back visibly if native checking fails", async () => {
  create(("Parole corrette 😀 " + typo + " ").repeat(260));
  await settle();
  // The large paragraph finishes parsing/layout after the first viewport.
  await settle();
  expect(api.checkSpelling).toHaveBeenCalled();
  expect(
    vi
      .mocked(api.checkSpelling)
      .mock.calls.every(([text]) => text.length <= 4000),
  ).toBe(true);
  expect(marks().length).toBeGreaterThan(0);
  vi.mocked(api.checkSpelling).mockRejectedValue(new Error("service stopped"));
  view.dispatch({ changes: { from: 0, insert: "Ancora " } });
  await settle();
  expect(notice).toHaveBeenCalledWith(
    expect.stringContaining("Spelling service unavailable"),
  );
  expect(view.contentDOM.getAttribute("spellcheck")).toBe("true");
  expect(marks()).toEqual([]);
});
