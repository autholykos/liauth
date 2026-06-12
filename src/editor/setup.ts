import {
  EditorView,
  keymap,
  drawSelection,
  placeholder,
  lineNumbers,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { vim, Vim, getCM } from "@replit/codemirror-vim";
import { livePreview, tableRendering } from "./livePreview";
import { typewriterScroll } from "./typewriter";
import { criticMarkup, insertNote } from "./notes";

/** Subtle source-level colors for the bits that stay visible. */
const mdHighlight = HighlightStyle.define([
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.url, color: "var(--c-muted)" },
  { tag: tags.processingInstruction, color: "var(--c-muted)" },
  { tag: tags.meta, color: "var(--c-muted)" },
]);

/**
 * Remove vim block-cursor layers that the live vim plugin doesn't own.
 * The plugin appends its layer to scrollDOM (which survives setState);
 * when its teardown is skipped or fails, the layer is orphaned and shows
 * up as a frozen ghost cursor at some past cursor position.
 */
export function sweepGhostCursorLayers(view: EditorView): void {
  const layers = view.scrollDOM.querySelectorAll(".cm-vimCursorLayer");
  if (layers.length === 0) return;
  // Internal plugin state; absent when vim mode is off (no layer is legit).
  const live =
    (
      getCM(view) as {
        state?: { vimPlugin?: { blockCursor?: { cursorLayer?: Element } } };
      } | null
    )?.state?.vimPlugin?.blockCursor?.cursorLayer ?? null;
  layers.forEach((el) => {
    if (el !== live) el.remove();
  });
}

/** Wrap the selection in `marker` (or insert it) — used for Cmd-B / Cmd-I. */
function toggleWrap(marker: string) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const changes = state.changeByRange((range) => {
      const before = state.sliceDoc(
        Math.max(0, range.from - marker.length),
        range.from,
      );
      const after = state.sliceDoc(range.to, range.to + marker.length);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from },
            { from: range.to, to: range.to + marker.length },
          ],
          range: range.extend(
            range.from - marker.length,
            range.to - marker.length,
          ),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: range.extend(
          range.from + marker.length,
          range.to + marker.length,
        ),
      };
    });
    view.dispatch(changes);
    return true;
  };
}

/** Toggle bold/italic on the selection — shared by keymap, menu, palette. */
export const toggleBold = toggleWrap("**");
export const toggleItalic = toggleWrap("*");

export interface CursorStatus {
  line: number;
  col: number;
}

export interface EditorCallbacks {
  onChange: () => void;
  onSave: () => void;
  onToggleRoom?: () => void;
  onRsvp?: () => void;
  onStatus?: (s: CursorStatus) => void;
}

export interface EditorOptions {
  readOnly?: boolean;
  vim?: boolean;
  typewriter?: boolean;
  lineNumbers?: boolean;
}

export function createEditorState(
  doc: string,
  cb: EditorCallbacks,
  opts: EditorOptions = {},
): EditorState {
  const {
    readOnly = false,
    vim: useVim = false,
    typewriter: useTypewriter = false,
    lineNumbers: useLineNumbers = false,
  } = opts;
  if (useVim) {
    // Ex commands are registered globally; rebind to the current document's
    // callbacks each time a state is built.
    Vim.defineEx("write", "w", () => cb.onSave());
    Vim.defineEx("room", "room", () => cb.onToggleRoom?.());
    Vim.defineEx("rsvp", "rsvp", () => cb.onRsvp?.());
  }
  return EditorState.create({
    doc,
    extensions: [
      // vim() must precede other keymaps to take precedence.
      useVim ? vim() : [],
      useTypewriter ? typewriterScroll : [],
      useLineNumbers ? lineNumbers() : [],
      EditorState.readOnly.of(readOnly),
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      placeholder("Start writing…"),
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(mdHighlight),
      livePreview,
      tableRendering,
      criticMarkup,
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            cb.onSave();
            return true;
          },
        },
        { key: "Mod-b", run: toggleBold },
        { key: "Mod-i", run: toggleItalic },
        { key: "Mod-Shift-m", run: insertNote },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        // Updates fire on focus changes too, so ghosts get culled right
        // when the unfocused outline style would make them visible.
        sweepGhostCursorLayers(u.view);
        if (u.docChanged) cb.onChange();
        if ((u.docChanged || u.selectionSet) && cb.onStatus) {
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          cb.onStatus({ line: line.number, col: head - line.from + 1 });
        }
      }),
    ],
  });
}
