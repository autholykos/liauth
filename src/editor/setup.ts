import {
  EditorView,
  keymap,
  drawSelection,
  placeholder,
  lineNumbers,
} from "@codemirror/view";
import { EditorState, EditorSelection } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { vim, Vim, getCM, CodeMirror } from "@replit/codemirror-vim";
import { livePreview, tableRendering } from "./livePreview";
import { typewriterScroll } from "./typewriter";
import {
  criticMarkup,
  insertNote,
  insertSuggestion,
  gotoNextNote,
} from "./notes";
import { historyDiff } from "./historyDiff";

function installWrappedLineVimNavigation(): void {
  // Bind directly to the display-line motion instead of feeding `g` and
  // the motion key back through Vim's key-sequence parser. Besides avoiding
  // transient key-sequence feedback, this keeps counts and operators (e.g.
  // `2dj`) on the same motion path as the built-in `gj`/`gk` commands.
  Vim.mapCommand("j", "motion", "moveByDisplayLines", { forward: true }, {});
  Vim.mapCommand("k", "motion", "moveByDisplayLines", { forward: false }, {});
}

installWrappedLineVimNavigation();

type VimDialogClose = (newValue?: string) => void;
type VimDialogKeyHandler = (
  event: KeyboardEvent,
  value: string,
  close: VimDialogClose,
) => boolean | void;

interface VimDialogOptions {
  onKeyDown?: VimDialogKeyHandler;
  onKeyUp?: VimDialogKeyHandler;
  onClose?: (dialog: Element) => void;
  closeOnBlur?: boolean;
  [key: string]: unknown;
}

/**
 * Disable browser completion and let the dialog adapter own its normal
 * keydown → accept → blur → close sequence. macOS completion can consume
 * Enter's keydown and move focus before keyup, so search prompts stay open on
 * blur and a window-level keyup supplies the same accept sequence as fallback.
 */
function installVimSearchPromptExitFix(): void {
  const openDialog = CodeMirror.prototype.openDialog;
  CodeMirror.prototype.openDialog = function (
    this: CodeMirror,
    template: Element,
    callback: Function | undefined,
    options: VimDialogOptions | undefined,
  ) {
    const prefix = template.textContent?.trimStart()[0];
    if (prefix !== "/" && prefix !== "?") {
      return openDialog.call(this, template, callback, options);
    }

    const input = template.querySelector<HTMLInputElement>("input");
    if (!input) return openDialog.call(this, template, callback, options);
    input.setAttribute("autocomplete", "off");
    const promptOptions = options ?? {};
    const onKeyDown = promptOptions.onKeyDown;
    const onClose = promptOptions.onClose;
    let finished = false;
    const accept = (value: string) => {
      if (finished) return;
      finished = true;
      callback?.(value);
    };
    let closeDialog: VimDialogClose = () => {};
    const onWindowKeyUp = (event: KeyboardEvent) => {
      if (!input.isConnected || !this.state.dialog?.contains(input)) {
        window.removeEventListener("keyup", onWindowKeyUp, true);
        return;
      }
      const acceptKey =
        event.key === "Enter" ||
        event.key === "Return" ||
        event.code === "Enter" ||
        event.code === "NumpadEnter" ||
        event.keyCode === 13;
      const cancelKey =
        event.key === "Escape" ||
        event.key === "Esc" ||
        event.code === "Escape" ||
        event.keyCode === 27;
      if ((!acceptKey && !cancelKey) || finished) return;

      if (cancelKey) {
        finished = true;
        if (onKeyDown) {
          onKeyDown(event, input.value, closeDialog);
        } else {
          CodeMirror.e_stop(event);
          closeDialog();
          this.focus();
        }
        return;
      }

      try {
        accept(input.value);
      } finally {
        input.blur();
        CodeMirror.e_stop(event);
        closeDialog();
        this.focus();
      }
    };
    closeDialog = openDialog.call(this, template, accept, {
      ...promptOptions,
      closeOnBlur: false,
      onClose: (dialog: Element) => {
        window.removeEventListener("keyup", onWindowKeyUp, true);
        onClose?.(dialog);
      },
    });
    window.addEventListener("keyup", onWindowKeyUp, true);
    return closeDialog;
  };
}

installVimSearchPromptExitFix();

/**
 * Upstream findPosV builds its vertical-motion probe cursor with a
 * hard-coded forward association. On a wrapped line, gk from the lower
 * visual row lands exactly on the wrap boundary, re-enters as "start of
 * the lower row", and every further gk recomputes the same spot — k gets
 * stuck on wrapped paragraphs (gj never fights the forward bias). Same
 * loop parks the cursor inside atomic (hidden-markup) spans. Rebuilt
 * here with the motion's direction as the association.
 */
function installFindPosVFix(): void {
  CodeMirror.prototype.findPosV = function (
    this: CodeMirror,
    start: { line: number; ch: number },
    amount: number,
    unit: string,
    goalColumn?: number,
  ) {
    const cm6 = (this as unknown as { cm6: EditorView }).cm6;
    const doc = cm6.state.doc;
    const pixels = unit === "page" ? cm6.dom.clientHeight : undefined;
    const startLine = doc.line(Math.min(start.line + 1, doc.lines));
    const startOffset = startLine.from + Math.min(start.ch, startLine.length);
    let range = EditorSelection.cursor(
      startOffset,
      amount < 0 ? -1 : 1,
      undefined,
      goalColumn,
    );
    const count = Math.round(Math.abs(amount));
    for (let i = 0; i < count; i++) {
      range = cm6.moveVertically(range, amount > 0, pixels);
    }
    const resLine = doc.lineAt(range.head);
    const pos: { line: number; ch: number; hitSide?: boolean } = {
      line: resLine.number - 1,
      ch: range.head - resLine.from,
    };
    // hitSide flags a clipped move at the document edge (gj/gk need it).
    if (
      (amount < 0 &&
        range.head === 0 &&
        goalColumn !== 0 &&
        start.line === 0 &&
        start.ch !== 0) ||
      (amount > 0 &&
        range.head === doc.length &&
        pos.ch !== goalColumn &&
        start.line === pos.line)
    ) {
      pos.hitSide = true;
    }
    return pos;
  } as unknown as typeof CodeMirror.prototype.findPosV;
}

installFindPosVFix();

/** Subtle source-level colors for the bits that stay visible. */
const mdHighlight = HighlightStyle.define([
  { tag: tags.monospace, fontFamily: "var(--font-mono)" },
  { tag: tags.url, color: "var(--c-muted)" },
  { tag: tags.processingInstruction, color: "var(--c-muted)" },
  { tag: tags.meta, color: "var(--c-muted)" },
]);

/**
 * Remove cursor artifacts the live plugins don't own. Layers append to
 * scrollDOM (which survives setState); when a plugin's teardown is
 * skipped or fails, its layer is orphaned and shows up as frozen ghost
 * cursors at past positions. This hits both the vim block-cursor layer
 * and drawSelection's cursor layer, and also drops stale extra cursors a
 * live layer keeps painted after a multi-range selection collapses
 * (e.g. leaving visual block mode) until its next repaint.
 */
export function sweepGhostCursorLayers(view: EditorView): void {
  const vimLayers = view.scrollDOM.querySelectorAll(".cm-vimCursorLayer");
  if (vimLayers.length > 0) {
    // Internal plugin state; absent when vim mode is off (no layer is legit).
    const live =
      (
        getCM(view) as {
          state?: { vimPlugin?: { blockCursor?: { cursorLayer?: Element } } };
        } | null
      )?.state?.vimPlugin?.blockCursor?.cursorLayer ?? null;
    vimLayers.forEach((el) => {
      if (el !== live) el.remove();
    });
  }
  // drawSelection's layer orphans the same way; the live one is always the
  // most recently appended.
  const cursorLayers = Array.from(
    view.scrollDOM.querySelectorAll(".cm-cursorLayer:not(.cm-vimCursorLayer)"),
  );
  for (const el of cursorLayers.slice(0, -1)) el.remove();
  // Stale children: more painted cursors than selection ranges means the
  // layer missed a collapse; clear it and let its next repaint rebuild.
  const ranges = view.state.selection.ranges.length;
  const layers = view.scrollDOM.querySelectorAll(
    ".cm-cursorLayer, .cm-vimCursorLayer",
  );
  layers.forEach((layer) => {
    if (layer.children.length > ranges) layer.replaceChildren();
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
      // Visual block mode emits one range per selected line.
      useVim ? EditorState.allowMultipleSelections.of(true) : [],
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
      historyDiff,
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
        { key: "Mod-Shift-u", run: insertSuggestion },
        { key: "Mod-Shift-j", run: gotoNextNote },
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
