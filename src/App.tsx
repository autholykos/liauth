import { useCallback, useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import {
  open as openDialog,
  save as saveDialog,
  ask,
} from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { createEditorState } from "./editor/setup";
import { applyVimrc, VimrcSummary } from "./editor/vimrc";
import * as api from "./api";
import "./App.css";

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

type Panel = "none" | "history" | "review";
type Theme = "paper" | "sepia" | "dark" | "room";

const THEMES: { id: Theme; label: string }[] = [
  { id: "paper", label: "Paper" },
  { id: "sepia", label: "Sepia" },
  { id: "dark", label: "Dark" },
  { id: "room", label: "Room" },
];

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
  const vimRef = useRef(vimMode);
  const roomRef = useRef(room);
  const prevThemeRef = useRef<Theme>("paper");
  const roomMountedRef = useRef(false);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;

  const fileName = filePath ? filePath.split("/").pop() : "Untitled";

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 4000);
  }, []);

  const setEditorContent = useCallback((content: string, readOnly = false) => {
    const view = viewRef.current;
    if (!view) return;
    loadingRef.current = true;
    view.setState(
      createEditorState(
        content,
        {
          onChange: () => {
            if (!loadingRef.current) setDirty(true);
          },
          onSave: () => saveRef.current(),
          onToggleRoom: () => setRoom((r) => !r),
        },
        {
          readOnly,
          vim: vimRef.current,
          typewriter: roomRef.current,
        },
      ),
    );
    loadingRef.current = false;
  }, []);

  useEffect(() => {
    localStorage.setItem("liauth.theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

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

  // Room mode: fullscreen, chrome hidden, typewriter scrolling, and the
  // terminal theme (previous theme restored on exit unless changed inside).
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
      setTheme((t) => {
        prevThemeRef.current = t;
        return "room";
      });
    } else {
      setTheme((t) => (t === "room" ? prevThemeRef.current : t));
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
    root.innerHTML = DOMPurify.sanitize(md.render(view.state.doc.toString()));
    document.title =
      fileName?.replace(/\.(md|markdown|txt)$/i, "") ?? "document";
    window.print();
  }, [fileName]);

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
        </div>
        <div className="toolbar-title">
          <span className="doc-name">
            {fileName}
            {dirty ? <span className="dirty-dot"> ●</span> : null}
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
      </main>

      {status ? <div className="status-toast">{status}</div> : null}
      <div id="print-root" />
    </div>
  );
}

export default App;
