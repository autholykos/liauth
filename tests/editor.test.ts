import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { getCM, Vim } from "@replit/codemirror-vim";
import { createEditorState, setEditorOption } from "../src/editor/setup";
import {
  applyEditsAsSuggestions,
  gotoNextNote,
  notesField,
  scanNotes,
  stripCriticMarkup,
} from "../src/editor/notes";
import { buildRsvpWords } from "../src/editor/rsvp";

const views: EditorView[] = [];
function editor(doc: string, onSave = () => {}) {
  const view = new EditorView({
    state: createEditorState(doc, { onChange() {}, onSave }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

describe("editor options", () => {
  it.each(["vim", "lineNumbers", "typewriter", "spellcheck"] as const)(
    "%s preserves selection and Undo when toggled both ways",
    (option) => {
      const view = editor("Opening.");
      view.dispatch({
        changes: { from: 8, insert: " Next." },
        selection: { anchor: 3 },
      });
      for (const on of [true, false]) {
        setEditorOption(view, option, on);
        expect(view.state.doc.toString()).toBe("Opening. Next.");
        expect(view.state.selection.main.head).toBe(3);
      }
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("Opening.");
    },
  );

  it("registers Ex commands when Vim is enabled after opening", () => {
    const save = vi.fn();
    const view = editor("Opening.", save);
    setEditorOption(view, "vim", true);
    Vim.handleEx(getCM(view)!, "w");
    expect(save).toHaveBeenCalledOnce();
  });
});

describe("CriticMarkup", () => {
  it("omits comments inside highlighted prose and preserves their source offsets", () => {
    const text = "{==before {>>inner note<<} after==}{>>outer note<<}";
    expect(stripCriticMarkup(text)).toBe("before after");
    const words = buildRsvpWords(text);
    expect(words.map((word) => word.text)).toEqual(["before", "after"]);
    expect(words[1].offset).toBe(text.indexOf("after"));
  });

  it("keeps ordinary strikethrough rendering inside a deletion suggestion", () => {
    const view = editor("{--old ~~strike~~--} tail");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.dom.querySelector(".lp-strike")?.textContent).toBe("strike");
  });
  it("updates the shared note list only on document edits", () => {
    let state = EditorState.create({
      doc: "Text {>>note<<}",
      extensions: notesField,
    });
    const notes = state.field(notesField);
    state = state.update({ selection: { anchor: 2 } }).state;
    expect(state.field(notesField)).toBe(notes);
    state = state.update({ changes: { from: 0, insert: "More " } }).state;
    expect(state.field(notesField)[0].from).toBe(notes[0].from + 5);
    expect(state.field(notesField)[0].raw).toBe("{>>note<<}");
  });

  it("reads and exports the original prose for every annotation form", () => {
    const text =
      "First {==lit==}{>>two word note<<} {~~old~>new~~} {++added++} {--kept--} {~~~>insert~~} ~~plain~~ last.";
    expect(stripCriticMarkup(text)).toBe("First lit old kept  ~~plain~~ last.");
    const words = buildRsvpWords(text);
    expect(words.map((word) => word.text)).toEqual([
      "First",
      "lit",
      "old",
      "kept",
      "plain",
      "last.",
    ]);
    const old = words.find((word) => word.text === "old")!;
    expect(text.slice(old.offset, old.end)).toBe("{~~old~>new~~}");
  });

  it("handles adjacent comments and comments spanning tokens without losing prose", () => {
    const text = "before{>>one<<}{>>two\nwords<<}after end";
    expect(buildRsvpWords(text).map((word) => word.text)).toEqual([
      "before",
      "after",
      "end",
    ]);
    expect(stripCriticMarkup(text)).toBe("beforeafter end");
  });

  it("keeps notes navigable and applies a draft as one undoable change", () => {
    const view = editor("{==old sentence==}{>>rewrite<<} and old sentence");
    const note = view.state.field(notesField)[0];
    if (note.kind !== "comment") throw new Error("Expected comment");
    expect(
      applyEditsAsSuggestions(
        view,
        [{ find: "old sentence", replace: "new sentence" }],
        note,
      ),
    ).toEqual({ applied: 2, missed: 0 });
    expect(view.state.doc.toString()).toBe(
      "{~~old sentence~>new sentence~~}{>>rewrite<<} and {~~old sentence~>new sentence~~}",
    );
    expect(gotoNextNote(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(
      view.state.field(notesField)[1].from,
    );
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(note.raw + " and old sentence");
  });

  it("renders a multiline note when the cursor is elsewhere", () => {
    const view = editor("{==first\nsecond==}{>>a long\ncomment<<}\n\nTail");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    expect(view.dom.querySelector(".lp-note-icon")?.textContent).toBe("✎");
    expect(view.state.field(notesField)).toEqual(
      scanNotes(view.state.doc.toString()),
    );
  });
});
