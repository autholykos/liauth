import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import {
  open as openDialog,
  save as saveDialog,
  ask,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCM } from "@replit/codemirror-vim";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { createEditorState } from "./editor/setup";
import { applyVimrc, VimrcSummary } from "./editor/vimrc";
import {
  scanNotes,
  insertNote,
  stripCriticMarkup,
  NoteMatch,
} from "./editor/notes";
import { buildRsvpWords, RsvpWord } from "./editor/rsvp";
import { RsvpOverlay } from "./RsvpOverlay";
import * as api from "./api";
import "./App.css";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

type Panel = "none" | "history" | "review" | "notes";
type Theme = "paper" | "sepia" | "dark" | "room";

const THEMES: { id: Theme; label: string }[] = [
  { id: "paper", label: "Paper" },
  { id: "sepia", label: "Sepia" },
  { id: "dark", label: "Dark" },
  { id: "room", label: "Room" },
];

type FontPref = "serif" | "sans" | "mono";

const FONTS: { id: FontPref; label: string }[] = [
  { id: "serif", label: "Serif" },
  { id: "sans", label: "Sans" },
  { id: "mono", label: "Mono" },
];

const ZOOM_MIN = 0.8;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.1;

function initialFont(): FontPref {
  const stored = localStorage.getItem("liauth.font");
  return stored === "sans" || stored === "mono" ? stored : "serif";
}

function initialZoom(): number {
  const stored = Number(localStorage.getItem("liauth.zoom"));
  return stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : 1;
}

function initialTheme(): Theme {
  const stored = localStorage.getItem("liauth.theme");
  if (THEMES.some((t) => t.id === stored)) {
    return stored as Theme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "paper";
}

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function App() {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadingRef = useRef(false);
  const saveRef = useRef<() => void>(() => {});

  const [filePath, setFilePath] = useState<string | null>(null);
  const [repo, setRepo] = useState<api.RepoInfo | null>(null);
  const [dirty, setDirty] = useState(false);
  const [panel, setPanel] = useState<Panel>("none");
  const [history, setHistory] = useState<api.CommitInfo[]>([]);
  const [branches, setBranches] = useState<api.BranchInfo[]>([]);
  const [viewing, setViewing] = useState<api.CommitInfo | null>(null);
  const [status, setStatus] = useState<string>("");
  const [vimMode, setVimMode] = useState(
    () => localStorage.getItem("liauth.vim") === "1",
  );
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [vimrc, setVimrc] = useState<VimrcSummary | null>(null);
  const [room, setRoom] = useState(false);
  const [font, setFont] = useState<FontPref>(initialFont);
  const [zoom, setZoom] = useState<number>(initialZoom);
  const [lineNums, setLineNums] = useState(
    () => localStorage.getItem("liauth.lines") === "1",
  );
  const lineNumsRef = useRef(lineNums);
  const [notes, setNotes] = useState<NoteMatch[]>([]);
  const notesTimerRef = useRef<number | undefined>(undefined);
  const [rsvp, setRsvp] = useState<{
    words: RsvpWord[];
    startIndex: number;
  } | null>(null);
  const rsvpRef = useRef<() => void>(() => {});
  const rsvpOpenRef = useRef(false);
  rsvpOpenRef.current = rsvp !== null;
  const vimRef = useRef(vimMode);
  const roomRef = useRef(room);
  const roomMountedRef = useRef(false);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;
  // Tracks "buffer differs from disk" — distinct from `dirty`, which now
  // means "uncommitted changes" and only clears on a real (commit) save.
  const diskDirtyRef = useRef(false);

  const fileName = filePath ? filePath.split("/").pop() : "Untitled";

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 4000);
  }, []);

  const refreshNotes = useCallback(() => {
    const view = viewRef.current;
    if (view) setNotes(scanNotes(view.state.doc.toString()));
  }, []);

  // Autosave: plain disk write, never a commit (and so never able to
  // conclude a merge). Triggered on leaving vim insert mode and on
  // window blur.
  const autoSave = useCallback(async () => {
    const view = viewRef.current;
    const path = filePathRef.current;
    if (!view || !path || viewingRef.current || !diskDirtyRef.current) return;
    try {
      await api.saveDocument(path, view.state.doc.toString(), undefined, false);
      diskDirtyRef.current = false;
    } catch (e) {
      console.warn("[liauth] autosave failed:", e);
    }
  }, []);

  useEffect(() => {
    const onBlur = () => void autoSave();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [autoSave]);

  // RSVP speed reading: starts at the cursor's word.
  const startRsvp = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const words = buildRsvpWords(view.state.doc.toString());
    if (words.length === 0) {
      flash("Nothing to read");
      return;
    }
    const head = view.state.selection.main.head;
    let startIndex = words.findIndex((w) => w.offset >= head);
    if (startIndex < 0) startIndex = words.length - 1;
    setRsvp({ words, startIndex });
  }, [flash]);

  useEffect(() => {
    rsvpRef.current = startRsvp;
  }, [startRsvp]);

  const exitRsvp = useCallback((offset: number) => {
    setRsvp(null);
    const view = viewRef.current;
    if (!view) return;
    const pos = Math.min(offset, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }, []);

  // Cmd/Ctrl-Shift-R opens the reader.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "r" &&
        !rsvpOpenRef.current
      ) {
        e.preventDefault();
        rsvpRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const setEditorContent = useCallback(
    (content: string, readOnly = false) => {
      const view = viewRef.current;
      if (!view) return;
      loadingRef.current = true;
      view.setState(
        createEditorState(
          content,
          {
            onChange: () => {
              if (!loadingRef.current) {
                setDirty(true);
                diskDirtyRef.current = true;
              }
              // Keep the Notes panel in sync while typing, debounced.
              if (panelRef.current === "notes") {
                window.clearTimeout(notesTimerRef.current);
                notesTimerRef.current = window.setTimeout(refreshNotes, 300);
              }
            },
            onSave: () => saveRef.current(),
            onToggleRoom: () => setRoom((r) => !r),
            onRsvp: () => rsvpRef.current(),
          },
          {
            readOnly,
            vim: vimRef.current,
            typewriter: roomRef.current,
            lineNumbers: lineNumsRef.current,
          },
        ),
      );
      // Autosave when leaving vim insert mode.
      if (vimRef.current) {
        const cm = getCM(view);
        if (cm) {
          let lastMode = "normal";
          cm.on("vim-mode-change", (e: { mode: string }) => {
            if (lastMode === "insert" && e.mode !== "insert") void autoSave();
            lastMode = e.mode;
          });
        }
      }
      loadingRef.current = false;
    },
    [autoSave, refreshNotes],
  );

  useEffect(() => {
    localStorage.setItem("liauth.theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("liauth.font", font);
    document.documentElement.dataset.font = font;
  }, [font]);

  useEffect(() => {
    localStorage.setItem("liauth.zoom", String(zoom));
    document.documentElement.style.setProperty("--editor-zoom", String(zoom));
  }, [zoom]);

  // Cmd/Ctrl +/-/0 text zoom.
  useEffect(() => {
    const clamp = (z: number) =>
      Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => clamp(z + ZOOM_STEP));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => clamp(z - ZOOM_STEP));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Load the user's vimrc subset once at startup. Mappings register in the
  // vim engine's global registry, so this works regardless of when (or how
  // often) vim mode is toggled.
  useEffect(() => {
    api
      .readVimConfig()
      .then((cfg) => {
        if (!cfg) return;
        const summary = applyVimrc(cfg.path, cfg.content);
        setVimrc(summary);
        if (vimRef.current && summary.applied > 0) {
          flash(
            `Vim config: ${summary.applied} entries from ${cfg.path}` +
              (summary.skipped.length
                ? ` (${summary.skipped.length} skipped)`
                : ""),
          );
        }
        if (summary.skipped.length) {
          console.info("[liauth] vimrc lines skipped:", summary.skipped);
        }
      })
      .catch((e) => console.warn("[liauth] vimrc load failed:", e));
  }, [flash]);

  // Rebuild the editor state when vim mode toggles, keeping the content.
  useEffect(() => {
    localStorage.setItem("liauth.vim", vimMode ? "1" : "0");
    vimRef.current = vimMode;
    const view = viewRef.current;
    if (view) {
      setEditorContent(view.state.doc.toString(), viewingRef.current !== null);
    }
  }, [vimMode, setEditorContent]);

  // Same for the line-number gutter.
  useEffect(() => {
    localStorage.setItem("liauth.lines", lineNums ? "1" : "0");
    lineNumsRef.current = lineNums;
    const view = viewRef.current;
    if (view) {
      setEditorContent(view.state.doc.toString(), viewingRef.current !== null);
    }
  }, [lineNums, setEditorContent]);

  // Room mode: fullscreen, chrome hidden, typewriter scrolling. Theme and
  // font stay as they are — the Room theme is just an option in the picker.
  useEffect(() => {
    roomRef.current = room;
    if (!roomMountedRef.current) {
      roomMountedRef.current = true;
      return;
    }
    getCurrentWindow()
      .setFullscreen(room)
      .catch((e) => console.warn("[liauth] fullscreen failed:", e));
    if (room) {
      setPanel("none");
    }
    const view = viewRef.current;
    if (view) {
      setEditorContent(view.state.doc.toString(), viewingRef.current !== null);
      view.focus();
    }
  }, [room, setEditorContent]);

  // Cmd/Ctrl-Shift-F toggles room mode from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f"
      ) {
        e.preventDefault();
        setRoom((r) => !r);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const refreshGit = useCallback(async (path: string) => {
    const info = await api.repoInfo(path);
    setRepo(info);
    if (info.repo_root) {
      setHistory(await api.fileHistory(path));
      setBranches(await api.listBranches(path));
    } else {
      setHistory([]);
      setBranches([]);
    }
  }, []);

  const loadFile = useCallback(
    async (path: string) => {
      try {
        const content = await api.readDocument(path);
        setFilePath(path);
        setViewing(null);
        setDirty(false);
        diskDirtyRef.current = false;
        setEditorContent(content);
        await refreshGit(path);
      } catch (e) {
        flash(`Could not open file: ${e}`);
      }
    },
    [setEditorContent, refreshGit, flash],
  );

  const doSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view || viewing) return;
    let path = filePath;
    if (!path) {
      path = await saveDialog({
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!path) return;
      setFilePath(path);
    }
    try {
      const commit = await api.saveDocument(path, view.state.doc.toString());
      setDirty(false);
      diskDirtyRef.current = false;
      flash(commit ? `Saved · committed ${commit.id.slice(0, 7)}` : "Saved");
      await refreshGit(path);
    } catch (e) {
      flash(`Save failed: ${e}`);
    }
  }, [filePath, viewing, refreshGit, flash]);

  useEffect(() => {
    saveRef.current = () => void doSave();
  }, [doSave]);

  // Mount the editor once.
  useEffect(() => {
    if (!editorHost.current || viewRef.current) return;
    const view = new EditorView({ parent: editorHost.current });
    viewRef.current = view;
    setEditorContent("");
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doOpen = useCallback(async () => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (typeof path === "string") await loadFile(path);
  }, [loadFile]);

  const enableVersioning = useCallback(async () => {
    if (!filePath) {
      flash("Save the document first");
      return;
    }
    const ok = await ask(
      "This will create a git repository in the document's folder. Continue?",
      { title: "Enable versioning" },
    );
    if (!ok) return;
    await api.initRepo(filePath);
    const view = viewRef.current;
    if (view) {
      await api.saveDocument(
        filePath,
        view.state.doc.toString(),
        "Initial version",
      );
    }
    await refreshGit(filePath);
    flash("Versioning enabled");
  }, [filePath, refreshGit, flash]);

  const viewVersion = useCallback(
    async (commit: api.CommitInfo) => {
      if (!filePath) return;
      const content = await api.fileAtCommit(filePath, commit.id);
      setViewing(commit);
      setEditorContent(content, true);
    },
    [filePath, setEditorContent],
  );

  const backToCurrent = useCallback(async () => {
    if (!filePath) return;
    await loadFile(filePath);
  }, [filePath, loadFile]);

  const restoreVersion = useCallback(async () => {
    if (!filePath || !viewing) return;
    const content = await api.fileAtCommit(filePath, viewing.id);
    setViewing(null);
    setEditorContent(content);
    setDirty(true);
    flash(
      `Restored ${viewing.id.slice(0, 7)} into the editor — save to commit`,
    );
  }, [filePath, viewing, setEditorContent, flash]);

  const newReviewBranch = useCallback(async () => {
    if (!filePath) return;
    const name = window.prompt("Review branch name", "review/reviewer");
    if (!name) return;
    try {
      await api.createBranch(filePath, name, true);
      await loadFile(filePath);
      flash(`On branch ${name} — edits here stay separate until merged`);
    } catch (e) {
      flash(`Could not create branch: ${e}`);
    }
  }, [filePath, loadFile, flash]);

  const switchBranch = useCallback(
    async (name: string) => {
      if (!filePath) return;
      if (dirty) {
        flash("Save your changes before switching branches");
        return;
      }
      try {
        await api.checkoutBranch(filePath, name);
        await loadFile(filePath);
        flash(`Switched to ${name}`);
      } catch (e) {
        flash(`Could not switch: ${e}`);
      }
    },
    [filePath, dirty, loadFile, flash],
  );

  const doMerge = useCallback(
    async (name: string) => {
      if (!filePath) return;
      if (dirty) {
        flash("Save your changes before merging");
        return;
      }
      try {
        const result = await api.mergeBranch(filePath, name);
        await loadFile(filePath);
        if (result.status === "conflicts") {
          flash(
            "Conflicts — resolve the <<< >>> markers, then Save to conclude the merge",
          );
        } else if (result.status === "up_to_date") {
          flash("Already up to date");
        } else {
          flash(`Merged ${name}`);
        }
      } catch (e) {
        flash(`Merge failed: ${e}`);
      }
    },
    [filePath, dirty, loadFile, flash],
  );

  const doAbortMerge = useCallback(async () => {
    if (!filePath) return;
    await api.abortMerge(filePath);
    await loadFile(filePath);
    flash("Merge aborted");
  }, [filePath, loadFile, flash]);

  const exportPdf = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const root = document.getElementById("print-root");
    if (!root) return;
    root.innerHTML = DOMPurify.sanitize(
      md.render(stripCriticMarkup(view.state.doc.toString())),
    );
    document.title =
      fileName?.replace(/\.(md|markdown|txt)$/i, "") ?? "document";
    window.print();
  }, [fileName]);

  const addNote = useCallback(() => {
    const view = viewRef.current;
    if (!view || viewing) return;
    insertNote(view);
    refreshNotes();
  }, [viewing, refreshNotes]);

  const jumpToNote = useCallback((n: NoteMatch) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: Math.min(n.from, view.state.doc.length) },
      effects: EditorView.scrollIntoView(
        Math.min(n.from, view.state.doc.length),
        {
          y: "center",
        },
      ),
    });
    view.focus();
  }, []);

  const resolveNote = useCallback(
    (n: NoteMatch) => {
      const view = viewRef.current;
      if (!view || viewing) return;
      if (view.state.sliceDoc(n.from, n.to) !== n.raw) {
        refreshNotes();
        flash("Document changed under the note — list refreshed, try again");
        return;
      }
      view.dispatch({
        changes: {
          from: n.from,
          to: n.to,
          insert: n.highlighted ? n.excerpt : "",
        },
      });
      refreshNotes();
      flash("Note resolved");
    },
    [viewing, refreshNotes, flash],
  );

  const toggleNotesPanel = useCallback(() => {
    setPanel((p) => {
      if (p === "notes") return "none";
      refreshNotes();
      return "notes";
    });
  }, [refreshNotes]);

  const versioned = !!repo?.repo_root;

  return (
    <div className={`app${room ? " room" : ""}`}>
      <div className="toolbar-hotzone" />
      <header className="toolbar">
        <div className="toolbar-left">
          <button onClick={doOpen}>Open</button>
          <button onClick={() => void doSave()} disabled={!!viewing}>
            Save
          </button>
          <button onClick={exportPdf}>Export PDF</button>
          <button
            className={room ? "active" : ""}
            title="Distraction-free writing room (⌘⇧F, or :room in vim mode)"
            onClick={() => setRoom(!room)}
          >
            Room
          </button>
          <button
            title="Speed-read from the cursor (⌘⇧R, or :rsvp in vim mode)"
            onClick={startRsvp}
          >
            Read
          </button>
        </div>
        <div className="toolbar-title">
          <span className="doc-name">
            {fileName}
            {dirty ? (
              <span
                className="dirty-dot"
                title="Uncommitted changes (autosaved to disk; ⌘S commits)"
              >
                {" "}
                ●
              </span>
            ) : null}
          </span>
          {versioned && repo?.branch ? (
            <span className={`branch-badge${repo.merging ? " merging" : ""}`}>
              ⎇ {repo.branch}
              {repo.merging ? " · merging" : ""}
            </span>
          ) : null}
        </div>
        <div className="toolbar-right">
          <button
            className={vimMode ? "active" : ""}
            title={
              vimrc
                ? `Toggle vim keybindings (:w saves)\n${vimrc.path}: ${vimrc.applied} entries applied` +
                  (vimrc.skipped.length
                    ? `, ${vimrc.skipped.length} skipped (see console)`
                    : "")
                : "Toggle vim keybindings (:w saves)"
            }
            onClick={() => setVimMode(!vimMode)}
          >
            Vim
          </button>
          <button
            className={lineNums ? "active" : ""}
            title="Toggle line numbers"
            onClick={() => setLineNums(!lineNums)}
          >
            №
          </button>
          <select
            className="theme-select"
            value={theme}
            title="Color theme"
            onChange={(e) => setTheme(e.target.value as Theme)}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            className="theme-select"
            value={font}
            title="Prose font"
            onChange={(e) => setFont(e.target.value as FontPref)}
          >
            {FONTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          {zoom !== 1 ? (
            <button
              className="zoom-indicator"
              title="Text zoom (⌘+ / ⌘− / ⌘0 to reset)"
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </button>
          ) : null}
          <button
            className={panel === "notes" ? "active" : ""}
            title="Notes (insert with ⌘⇧M)"
            onClick={toggleNotesPanel}
          >
            Notes
          </button>
          {versioned ? (
            <>
              <button
                className={panel === "history" ? "active" : ""}
                onClick={() =>
                  setPanel(panel === "history" ? "none" : "history")
                }
              >
                History
              </button>
              <button
                className={panel === "review" ? "active" : ""}
                onClick={() => setPanel(panel === "review" ? "none" : "review")}
              >
                Review
              </button>
            </>
          ) : (
            <button
              onClick={() => void enableVersioning()}
              disabled={!filePath}
            >
              Enable versioning
            </button>
          )}
        </div>
      </header>

      {repo?.merging ? (
        <div className="banner warning">
          Merge in progress — resolve conflicts in the editor, then Save to
          conclude.
          <button onClick={() => void doAbortMerge()}>Abort merge</button>
        </div>
      ) : null}

      {viewing ? (
        <div className="banner">
          Viewing version {viewing.id.slice(0, 7)} from {fmtTime(viewing.time)}{" "}
          (read-only)
          <button onClick={() => void restoreVersion()}>
            Restore this version
          </button>
          <button onClick={() => void backToCurrent()}>Back to current</button>
        </div>
      ) : null}

      <main className="content">
        <div className="editor-wrap" ref={editorHost} />

        {panel === "history" && versioned ? (
          <aside className="side-panel">
            <h3>History</h3>
            {history.length === 0 ? (
              <p className="muted">No versions yet.</p>
            ) : null}
            <ul className="commit-list">
              {history.map((c) => (
                <li
                  key={c.id}
                  className={viewing?.id === c.id ? "selected" : ""}
                  onClick={() => void viewVersion(c)}
                >
                  <span className="commit-summary">{c.summary}</span>
                  <span className="commit-meta">
                    {c.author} · {fmtTime(c.time)} · {c.id.slice(0, 7)}
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        {panel === "review" && versioned ? (
          <aside className="side-panel">
            <h3>Review</h3>
            <button className="wide" onClick={() => void newReviewBranch()}>
              New review branch
            </button>
            <ul className="branch-list">
              {branches.map((b) => (
                <li key={b.name} className={b.is_head ? "selected" : ""}>
                  <span className="branch-name">
                    ⎇ {b.name}
                    {b.is_head ? " (current)" : ""}
                  </span>
                  {!b.is_head ? (
                    <span className="branch-actions">
                      <button onClick={() => void switchBranch(b.name)}>
                        Switch
                      </button>
                      <button onClick={() => void doMerge(b.name)}>
                        Merge in
                      </button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="muted">
              A reviewer works on their own branch; “Merge in” brings their
              edits into the current branch. Conflicts appear inline and are
              concluded by saving.
            </p>
          </aside>
        ) : null}

        {panel === "notes" ? (
          <aside className="side-panel">
            <h3>Notes</h3>
            <button className="wide" onClick={addNote} disabled={!!viewing}>
              Add note at cursor (⌘⇧M)
            </button>
            {notes.length === 0 ? (
              <p className="muted">
                No notes. Select text and press ⌘⇧M to annotate it; notes are
                stored as CriticMarkup in the document and stripped from PDF
                export.
              </p>
            ) : null}
            <ul className="note-list">
              {notes.map((n, i) => (
                <li key={`${n.from}-${i}`} onClick={() => jumpToNote(n)}>
                  {n.highlighted ? (
                    <span className="note-excerpt">
                      “
                      {n.excerpt.length > 60
                        ? `${n.excerpt.slice(0, 60)}…`
                        : n.excerpt}
                      ”
                    </span>
                  ) : (
                    <span className="note-excerpt muted">(standalone)</span>
                  )}
                  <span className="note-comment">
                    {n.comment.trim() || "(empty)"}
                  </span>
                  <span className="branch-actions">
                    <button
                      disabled={!!viewing}
                      onClick={(e) => {
                        e.stopPropagation();
                        resolveNote(n);
                      }}
                    >
                      Resolve
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}
      </main>

      {status ? <div className="status-toast">{status}</div> : null}
      {rsvp ? (
        <RsvpOverlay
          words={rsvp.words}
          startIndex={rsvp.startIndex}
          onExit={exitRsvp}
        />
      ) : null}
      <div id="print-root" />
    </div>
  );
}

export default App;
