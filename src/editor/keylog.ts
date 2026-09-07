import { EditorView, ViewPlugin } from "@codemirror/view";
import { getCM } from "@replit/codemirror-vim";
import { getVersion } from "@tauri-apps/api/app";
import { writeKeylog } from "../api";

/**
 * Always-on flight recorder for keyboard bugs. Every key, input,
 * composition, focus, and mouse-down event in the window is kept in a ring
 * buffer alongside what the Vim engine made of it and the editor's state at
 * that instant. `:keylog` (or the palette's "Write Key Log") dumps the
 * buffer to ~/.config/liauth/keylog.jsonl, so one reproduction of a
 * WebKit-only glitch that no harness can trigger is enough to diagnose it.
 */

const CAPACITY = 500;
/** Inserted-text sample kept per event; a whole paste is not the point. */
const DATA_LIMIT = 40;
const CURSOR_LAYERS = ".cm-cursorLayer, .cm-vimCursorLayer";

const DOM_EVENTS = [
  "keydown",
  "keypress",
  "keyup",
  "beforeinput",
  "input",
  // WebKit's legacy TextEvent: text services commit through it.
  "textInput",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "focusin",
  "focusout",
  "mousedown",
];

interface KeylogEntry {
  /** Milliseconds since page load, one decimal. */
  t: number;
  /** DOM event type, `vim:*` for engine-side events, `editor:*` for lifecycle. */
  type: string;
  key?: string;
  code?: string;
  keyCode?: number;
  /** Modifiers held: C(trl) A(lt) S(hift) M(eta). */
  mods?: string;
  repeat?: boolean;
  /** KeyboardEvent/InputEvent.isComposing. */
  composing?: boolean;
  inputType?: string;
  data?: string;
  /** Where it fired: `editor` is the content, `vim-panel>input` the prompt. */
  target?: string;
  /** The other side of a focus change (relatedTarget). */
  other?: string;
  /** document.activeElement at that moment. */
  active?: string;
  /** Vim mode from the engine's flags; absent when vim is off. */
  mode?: string;
  /** Keys of the command still being typed (Vim's showcmd). */
  pending?: string;
  /** Main selection as line:col, or anchor-head when not empty. */
  sel?: string;
  focus?: boolean;
  /** EditorView.composing. */
  cmComposing?: boolean;
  /** Cursor-layer census, for ghost-cursor diagnosis. */
  layers?: string;
  detail?: string;
}

type Recorded = Omit<KeylogEntry, "t">;
type Context = Omit<Recorded, "type">;

const buffer: KeylogEntry[] = [];
let dropped = 0;

export function recordKeylog({ type, ...rest }: Recorded): void {
  // Every line starts with t and type, whatever order the caller used.
  buffer.push({ t: Math.round(performance.now() * 10) / 10, type, ...rest });
  if (buffer.length > CAPACITY) {
    buffer.shift();
    dropped++;
  }
}

export function clearKeylog(): void {
  buffer.length = 0;
  dropped = 0;
}

function clip(text: string | null | undefined): string | undefined {
  if (text == null) return undefined;
  return text.length > DATA_LIMIT ? `${text.slice(0, DATA_LIMIT)}…` : text;
}

function describe(node: EventTarget | null, view: EditorView): string {
  if (!(node instanceof Element)) return "none";
  const tag = node.tagName.toLowerCase();
  if (node === view.contentDOM) return "editor";
  if (view.contentDOM.contains(node)) return `editor>${tag}`;
  if (node.closest(".cm-vim-panel")) return `vim-panel>${tag}`;
  const id = node.id ? `#${node.id}` : "";
  const cls = node.classList.length ? `.${node.classList[0]}` : "";
  return `${tag}${id}${cls}`;
}

function vimMode(
  vim: {
    insertMode: boolean;
    visualMode: boolean;
    visualLine: boolean;
    visualBlock: boolean;
  },
  overwrite: boolean,
): string {
  // Replace mode (R) is insert mode with the adapter's overwrite flag set.
  if (vim.insertMode) return overwrite ? "replace" : "insert";
  if (!vim.visualMode) return "normal";
  if (vim.visualLine) return "visual-line";
  return vim.visualBlock ? "visual-block" : "visual";
}

/** Editor and Vim state at the instant of an event. */
function context(view: EditorView): Context {
  const { doc, selection } = view.state;
  const { main } = selection;
  const head = doc.lineAt(main.head);
  let sel = `${head.number}:${main.head - head.from + 1}`;
  if (!main.empty) {
    const anchor = doc.lineAt(main.anchor);
    sel = `${anchor.number}:${main.anchor - anchor.from + 1}-${sel}`;
  }
  const cm = getCM(view);
  const vim = cm?.state.vim;
  return {
    active: describe(document.activeElement, view),
    mode: cm && vim ? vimMode(vim, !!cm.state.overwrite) : undefined,
    pending: vim?.status || undefined,
    sel,
    focus: view.hasFocus,
    cmComposing: view.composing || undefined,
  };
}

function layerCensus(view: EditorView): string {
  const layers = view.dom.querySelectorAll(CURSOR_LAYERS);
  let vim = 0;
  let cursors = 0;
  layers.forEach((layer) => {
    if (layer.classList.contains("cm-vimCursorLayer")) vim++;
    cursors += layer.children.length;
  });
  const ranges = view.state.selection.ranges.length;
  return `layers=${layers.length} vim=${vim} cursors=${cursors} ranges=${ranges}`;
}

function modifiers(e: KeyboardEvent): string | undefined {
  const mods =
    (e.ctrlKey ? "C" : "") +
    (e.altKey ? "A" : "") +
    (e.shiftKey ? "S" : "") +
    (e.metaKey ? "M" : "");
  return mods || undefined;
}

function describeEvent(e: Event, view: EditorView): Recorded {
  const specifics: Recorded = { type: e.type };
  if (e instanceof KeyboardEvent) {
    specifics.key = e.key;
    specifics.code = e.code;
    specifics.keyCode = e.keyCode;
    specifics.mods = modifiers(e);
    specifics.repeat = e.repeat || undefined;
    specifics.composing = e.isComposing || undefined;
  } else if (e instanceof InputEvent) {
    specifics.inputType = e.inputType;
    specifics.data = clip(e.data);
    specifics.composing = e.isComposing || undefined;
  } else if (e instanceof FocusEvent) {
    specifics.other = describe(e.relatedTarget, view);
    specifics.layers = layerCensus(view);
  } else if ("data" in e) {
    // CompositionEvent and WebKit's TextEvent both carry the text as data.
    specifics.data = clip((e as { data?: string }).data);
  }
  return { ...specifics, target: describe(e.target, view), ...context(view) };
}

/** Mirror what the Vim engine sees, via the signals its plugin emits. */
function hookVim(view: EditorView): void {
  const cm = getCM(view);
  if (!cm) return;
  cm.on("inputEvent", (e: { type: string; key?: string; text?: string }) => {
    if (e.type === "handleKey") {
      recordKeylog({ ...context(view), type: "vim:key", key: e.key });
    } else if (e.type === "text") {
      recordKeylog({ ...context(view), type: "vim:text", data: clip(e.text) });
    }
  });
  cm.on("vim-keypress", (key: string) => {
    recordKeylog({ ...context(view), type: "vim:handled", key });
  });
  cm.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
    const detail = e.subMode ? `${e.mode}/${e.subMode}` : e.mode;
    recordKeylog({ type: "vim:mode", detail });
  });
  cm.on("dialog", () => {
    recordKeylog({
      ...context(view),
      type: "vim:dialog",
      detail: cm.state.dialog ? "open" : "closed",
      layers: layerCensus(view),
    });
  });
}

/**
 * Records for the life of one editor state. Listed last among the
 * extensions so the vim and cursor-layer plugins exist when it starts, and
 * capture-phase on document so it sees events wherever focus has wandered.
 */
export const keylogRecorder = ViewPlugin.define((view) => {
  const onEvent = (e: Event) => recordKeylog(describeEvent(e, view));
  for (const type of DOM_EVENTS) {
    document.addEventListener(type, onEvent, true);
  }
  hookVim(view);
  recordKeylog({
    ...context(view),
    type: "editor:state",
    layers: layerCensus(view),
  });
  return {
    destroy() {
      for (const type of DOM_EVENTS) {
        document.removeEventListener(type, onEvent, true);
      }
      recordKeylog({ type: "editor:destroy", layers: layerCensus(view) });
    },
  };
});

/** Write the buffer as JSON lines behind a header; resolves to the path. */
export async function saveKeylog(view: EditorView): Promise<string> {
  // Snapshot first: keys still arrive while the version lookup is pending.
  const entries = [...buffer];
  const header = {
    type: "header",
    written: new Date().toISOString(),
    now: Math.round(performance.now()),
    userAgent: navigator.userAgent,
    entries: entries.length,
    dropped,
    ...context(view),
    layers: layerCensus(view),
    layerHtml: Array.from(view.dom.querySelectorAll(CURSOR_LAYERS), (el) =>
      el.outerHTML.slice(0, 2000),
    ),
    version: await getVersion().catch(() => "unknown"),
  };
  const lines = [header, ...entries].map((entry) => JSON.stringify(entry));
  return writeKeylog(`${lines.join("\n")}\n`);
}

/** Save and report the outcome through `notify`. */
export function dumpKeylog(
  view: EditorView,
  notify: (message: string) => void,
): void {
  void saveKeylog(view).then(
    (path) => notify(`Key log written to ${path}`),
    (e) => notify(`Could not write key log: ${e}`),
  );
}
