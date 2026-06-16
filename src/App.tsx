import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { EditorView } from "@codemirror/view";
import {
  open as openDialog,
  save as saveDialog,
  ask,
  message,
} from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { watch, type UnwatchFn } from "@tauri-apps/plugin-fs";
import { getCM } from "@replit/codemirror-vim";
import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import {
  createEditorState,
  toggleBold,
  toggleItalic,
  sweepGhostCursorLayers,
  CursorStatus,
} from "./editor/setup";
import { buildAppMenu } from "./menu";
import { CommandPalette, PaletteCommand } from "./CommandPalette";
import { applyVimrc, VimrcSummary } from "./editor/vimrc";
import { HelpPanel } from "./HelpPanel";
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

type Panel = "none" | "history" | "review" | "notes" | "help" | "vimrc";
type Theme = "paper" | "sepia" | "dark" | "room";
type AutoSaveResult = "ok" | "blocked-conflict" | "failed";

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

const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));

const DEFAULT_VIMRC = `" Liauth vim config — supported: the map/noremap/unmap families,
" let mapleader, and a few set options. Examples:
"
" let mapleader = ","
" nnoremap j gj
" nnoremap k gk
`;

function loadRecents(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem("liauth.recents") ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function timeNow(): string {
  return new Date().toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

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
  const [room, setRoom] = useState(false);
  const [font, setFont] = useState<FontPref>(initialFont);
  const [zoom, setZoom] = useState<number>(initialZoom);
  const [lineNums, setLineNums] = useState(
    () => localStorage.getItem("liauth.lines") === "1",
  );
  const [pageLayout, setPageLayout] = useState(
    () => localStorage.getItem("liauth.page") === "1",
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
  // Last disk content this app loaded or wrote: the merge base for
  // reconciling concurrent external writes, and the way our own saves
  // are told apart from someone else's.
  const lastDiskRef = useRef("");
  const unwatchRef = useRef<UnwatchFn | null>(null);
  const [extConflict, setExtConflict] = useState<string | null>(null); // disk content
  const extConflictRef = useRef<string | null>(null);
  extConflictRef.current = extConflict;
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [vimrc, setVimrc] = useState<VimrcSummary | null>(null);
  const [vimrcDraft, setVimrcDraft] = useState("");
  const [navOpen, setNavOpen] = useState(
    () => localStorage.getItem("liauth.nav") === "1",
  );
  const [project, setProject] = useState<api.ProjectFiles | null>(null);
  // A folder opened directly (File ▸ Open Folder…): anchors the navigator
  // while the buffer is still untitled, and is where ⌘S will default to.
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cursor, setCursor] = useState<CursorStatus>({ line: 1, col: 1 });
  const [counts, setCounts] = useState({ words: 0, chars: 0 });
  const [lastSave, setLastSave] = useState("");
  const countsTimerRef = useRef<number | undefined>(undefined);
  const runRef = useRef<(id: string) => void>(() => {});

  const fileName = filePath ? filePath.split("/").pop() : "Untitled";

  const flash = useCallback((msg: string) => {
    setStatus(msg);
    window.setTimeout(() => setStatus(""), 4000);
  }, []);

  const refreshNotes = useCallback(() => {
    const view = viewRef.current;
    if (view) setNotes(scanNotes(view.state.doc.toString()));
  }, []);

  const updateCounts = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    setCounts({
      words: (text.match(/\S+/g) ?? []).length,
      chars: text.length,
    });
  }, []);

  const scheduleCounts = useCallback(() => {
    window.clearTimeout(countsTimerRef.current);
    countsTimerRef.current = window.setTimeout(updateCounts, 300);
  }, [updateCounts]);

  useEffect(() => {
    setLastSave("");
    updateCounts();
  }, [filePath, updateCounts]);

  useEffect(() => {
    const name = fileName ?? "Untitled";
    void getCurrentWindow()
      .setTitle(`${name}${dirty ? " — Edited" : ""}`)
      .catch(() => {});
  }, [fileName, dirty]);

  // Autosave: plain disk write, never a commit (and so never able to
  // conclude a merge). Triggered on leaving vim insert mode and on
  // window blur.
  const autoSave = useCallback(async (): Promise<AutoSaveResult> => {
    const view = viewRef.current;
    const path = filePathRef.current;
    if (!view || !path || viewingRef.current || !diskDirtyRef.current) {
      return "ok";
    }
    if (extConflictRef.current !== null) return "blocked-conflict";
    try {
      const content = view.state.doc.toString();
      await api.saveDocument(path, content, undefined, false);
      diskDirtyRef.current = false;
      lastDiskRef.current = content;
      setLastSave(`autosaved ${timeNow()}`);
      return "ok";
    } catch (e) {
      console.warn("[liauth] autosave failed:", e);
      return "failed";
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
    let startIndex = words.findIndex(
      (w) => head >= w.offset && head < w.end,
    );
    if (startIndex < 0) startIndex = words.findIndex((w) => w.offset >= head);
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
              scheduleCounts();
              // Keep the Notes panel in sync while typing, debounced.
              if (panelRef.current === "notes") {
                window.clearTimeout(notesTimerRef.current);
                notesTimerRef.current = window.setTimeout(refreshNotes, 300);
              }
            },
            onSave: () => saveRef.current(),
            onToggleRoom: () => setRoom((r) => !r),
            onRsvp: () => rsvpRef.current(),
            onStatus: (s) => setCursor(s),
          },
          {
            readOnly,
            vim: vimRef.current,
            typewriter: roomRef.current,
            lineNumbers: lineNumsRef.current,
          },
        ),
      );
      sweepGhostCursorLayers(view);
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
    [autoSave, refreshNotes, scheduleCounts],
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

  // Cmd/Ctrl +/-/0 text zoom and Cmd/Ctrl-K palette (fallbacks for when
  // the native menu accelerators don't fire, e.g. dev reload states).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setZoom((z) => clampZoom(z + ZOOM_STEP));
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setZoom((z) => clampZoom(z - ZOOM_STEP));
      } else if (e.key === "0") {
        e.preventDefault();
        setZoom(1);
      } else if (e.key.toLowerCase() === "k" && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    localStorage.setItem("liauth.recents", JSON.stringify(recents));
  }, [recents]);

  useEffect(() => {
    localStorage.setItem("liauth.nav", navOpen ? "1" : "0");
  }, [navOpen]);

  // Navigator contents: the markdown files of the document's project
  // (its git repo, or just its folder when unversioned). Re-roots when
  // versioning is enabled, since that creates the repo. An explicitly
  // opened folder anchors it while no document is open.
  useEffect(() => {
    const anchor = filePath ?? openFolder;
    if (!navOpen || !anchor) {
      setProject(null);
      return;
    }
    api
      .listProjectFiles(anchor)
      .then(setProject)
      .catch(() => setProject(null));
  }, [navOpen, filePath, openFolder, repo?.repo_root]);

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

  const openVimrcPanel = useCallback(async () => {
    try {
      const cfg = await api.readVimConfig();
      setVimrcDraft(cfg?.content ?? DEFAULT_VIMRC);
    } catch (e) {
      flash(`Could not read vim config: ${e}`);
      setVimrcDraft("");
    }
    setPanel("vimrc");
  }, [flash]);

  const saveVimrc = useCallback(async () => {
    try {
      const saved = await api.writeVimConfig(vimrcDraft);
      const summary = applyVimrc(saved.path, saved.content);
      setVimrc(summary);
      flash(
        `Saved — ${summary.applied} entries applied` +
          (summary.skipped.length
            ? `, ${summary.skipped.length} skipped (devtools console lists why)`
            : ""),
      );
    } catch (e) {
      flash(`Could not save vim config: ${e}`);
    }
  }, [vimrcDraft, flash]);

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

  // Page layout: the content column styled as a paper sheet (pure CSS).
  useEffect(() => {
    localStorage.setItem("liauth.page", pageLayout ? "1" : "0");
    document.documentElement.dataset.page = pageLayout ? "1" : "0";
  }, [pageLayout]);

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
    return info;
  }, []);

  // External-change handling: called by the file watcher. Our own writes
  // are recognized by comparing disk against what we last wrote.
  const handleExternalChange = useCallback(async () => {
    const path = filePathRef.current;
    const view = viewRef.current;
    // While viewing history the buffer holds an old version on purpose;
    // loadFile re-reads the disk when returning to current.
    if (!path || !view || viewingRef.current) return;
    let disk: string;
    try {
      disk = await api.readDocument(path);
    } catch {
      return; // deleted/renamed mid-event; ignore
    }
    if (disk === lastDiskRef.current) return; // our own write
    const buffer = view.state.doc.toString();
    if (disk === buffer) {
      lastDiskRef.current = disk;
      return;
    }
    if (!diskDirtyRef.current) {
      // Buffer is clean: just take the external version.
      lastDiskRef.current = disk;
      setEditorContent(disk);
      const info = await refreshGit(path);
      if (!diskDirtyRef.current) setDirty(info.file_dirty);
      flash("Reloaded — file changed on disk");
      return;
    }
    // Concurrent writes: try a three-way merge with the last common
    // disk state as the ancestor (the same algorithm git merge uses).
    const merged = await api.mergeContents(lastDiskRef.current, buffer, disk);
    if (!merged.conflicts) {
      lastDiskRef.current = disk;
      setEditorContent(merged.content);
      setDirty(true);
      diskDirtyRef.current = true;
      flash("Merged concurrent changes from disk — save to commit");
    } else {
      setExtConflict(disk);
    }
  }, [setEditorContent, refreshGit, flash]);

  const watchFile = useCallback(
    async (path: string) => {
      unwatchRef.current?.();
      unwatchRef.current = null;
      try {
        unwatchRef.current = await watch(
          path,
          () => void handleExternalChange(),
          { delayMs: 500 },
        );
      } catch (e) {
        console.warn("[liauth] file watch failed:", e);
      }
    },
    [handleExternalChange],
  );

  useEffect(() => () => unwatchRef.current?.(), []);

  const checkForUpdates = useCallback(async () => {
    flash("Checking for updates...");
    try {
      const update = await check();
      if (!update) {
        await message("Liauth is up to date.", {
          title: "Check for Updates",
          kind: "info",
        });
        return;
      }

      const notes = update.body ? `\n\n${update.body}` : "";
      const install = await ask(
        `Liauth ${update.version} is available.${notes}\n\nInstall it and relaunch now?`,
        { title: "Update Available", kind: "info" },
      );
      if (!install) {
        await update.close();
        flash("Update postponed");
        return;
      }

      flash(`Downloading Liauth ${update.version}...`);
      await update.downloadAndInstall();
      await message("The update was installed. Liauth will relaunch now.", {
        title: "Update Installed",
        kind: "info",
      });
      await relaunch();
    } catch (e) {
      await message(`Could not check for updates:\n${e}`, {
        title: "Check for Updates",
        kind: "error",
      });
    }
  }, [flash]);

  const loadFile = useCallback(
    async (path: string) => {
      try {
        const content = await api.readDocument(path);
        setFilePath(path);
        setViewing(null);
        setDirty(false);
        setExtConflict(null);
        diskDirtyRef.current = false;
        lastDiskRef.current = content;
        setEditorContent(content);
        setRecents((r) => [path, ...r.filter((p) => p !== path)].slice(0, 8));
        const info = await refreshGit(path);
        if (!diskDirtyRef.current) setDirty(info.file_dirty);
        await watchFile(path);
      } catch (e) {
        flash(`Could not open file: ${e}`);
      }
    },
    [setEditorContent, refreshGit, flash, watchFile],
  );

  const leaveCurrentDocument = useCallback(
    async (title: string): Promise<boolean> => {
      const view = viewRef.current;
      if (!view) return true;
      if (!filePathRef.current && view.state.doc.length > 0) {
        return ask("Discard the untitled document?", {
          title,
          kind: "warning",
        });
      }
      const saved = await autoSave();
      if (saved === "blocked-conflict") {
        flash("Resolve the disk conflict before opening another document");
        return false;
      }
      if (saved === "failed") {
        flash("Autosave failed; current document left open");
        return false;
      }
      return true;
    },
    [autoSave, flash],
  );

  const openPath = useCallback(
    async (path: string) => {
      if (!(await leaveCurrentDocument("Open file"))) return;
      await loadFile(path);
    },
    [leaveCurrentDocument, loadFile],
  );

  const doSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view || viewing) return;
    let path = filePath;
    if (!path) {
      path = await saveDialog({
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        // An explicitly opened folder is where the untitled buffer lives.
        defaultPath: openFolder ?? undefined,
      });
      if (!path) return;
      setFilePath(path);
    }
    try {
      const content = view.state.doc.toString();
      const commit = await api.saveDocument(path, content);
      setDirty(false);
      setExtConflict(null);
      diskDirtyRef.current = false;
      lastDiskRef.current = content;
      setLastSave(
        commit
          ? `committed ${commit.id.slice(0, 7)} · ${timeNow()}`
          : `saved ${timeNow()}`,
      );
      const info = await refreshGit(path);
      if (!diskDirtyRef.current) setDirty(info.file_dirty);
      if (!unwatchRef.current) await watchFile(path);
    } catch (e) {
      flash(`Save failed: ${e}`);
    }
  }, [filePath, viewing, openFolder, refreshGit, flash, watchFile]);

  const doSaveAs = useCallback(async () => {
    const view = viewRef.current;
    if (!view || viewing) return;
    const path = await saveDialog({
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      defaultPath: fileName ?? undefined,
    });
    if (!path) return;
    try {
      await api.saveDocument(path, view.state.doc.toString());
      await loadFile(path);
      setLastSave(`saved as ${path.split("/").pop()} · ${timeNow()}`);
    } catch (e) {
      flash(`Save As failed: ${e}`);
    }
  }, [viewing, fileName, loadFile, flash]);

  useEffect(() => {
    saveRef.current = () => void doSave();
  }, [doSave]);

  const doReload = useCallback(async () => {
    const path = filePathRef.current;
    if (!path) return;
    if (diskDirtyRef.current) {
      const ok = await ask("Discard unsaved changes and reload from disk?", {
        title: "Reload",
      });
      if (!ok) return;
    }
    await loadFile(path);
    flash("Reloaded from disk");
  }, [loadFile, flash]);

  const resolveExternal = useCallback(
    async (mode: "merge" | "mine" | "theirs") => {
      const view = viewRef.current;
      const path = filePathRef.current;
      if (!view || !path || extConflict === null) return;
      const buffer = view.state.doc.toString();
      if (mode === "mine") {
        await api.saveDocument(path, buffer, undefined, false);
        lastDiskRef.current = buffer;
        diskDirtyRef.current = false;
        const info = await refreshGit(path);
        if (!diskDirtyRef.current) setDirty(info.file_dirty);
        setExtConflict(null);
        flash("Kept your version — disk overwritten");
      } else if (mode === "theirs") {
        setExtConflict(null);
        await loadFile(path);
        flash("Took the disk version");
      } else {
        const merged = await api.mergeContents(
          lastDiskRef.current,
          buffer,
          extConflict,
        );
        lastDiskRef.current = extConflict;
        setEditorContent(merged.content);
        setDirty(true);
        diskDirtyRef.current = true;
        setExtConflict(null);
        flash(
          merged.conflicts
            ? "Conflict markers inserted — resolve them, then save"
            : "Merged — save to commit",
        );
      }
    },
    [extConflict, loadFile, refreshGit, setEditorContent, flash],
  );

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

  // Remember the open document across launches.
  useEffect(() => {
    if (filePath) localStorage.setItem("liauth.lastFile", filePath);
  }, [filePath]);

  // On startup: a file handed to us by the OS (Finder "Open with",
  // double-click) wins; otherwise reopen the last document.
  useEffect(() => {
    void (async () => {
      const pending = await api.takePendingOpen().catch(() => null);
      if (pending) {
        await loadFile(pending);
        return;
      }
      const last = localStorage.getItem("liauth.lastFile");
      if (!last) return;
      try {
        await api.readDocument(last); // existence check, quiet on failure
        await loadFile(last);
      } catch {
        localStorage.removeItem("liauth.lastFile");
      }
    })();
    // Run once on mount; loadFile is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Files opened from the OS while the app is already running.
  useEffect(() => {
    const un = listen<string>("open-file", (e) => {
      void api.takePendingOpen().catch(() => null); // consume the stash
      void openPath(e.payload);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [openPath]);

  // Drop a markdown file anywhere on the window to open it.
  useEffect(() => {
    const un = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type !== "drop") return;
      const path = e.payload.paths.find((p) =>
        /\.(md|markdown|txt)$/i.test(p),
      );
      if (path) void openPath(path);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [openPath]);

  // Closing/quitting: a named document autosaves to disk; an untitled
  // buffer with content asks before being discarded.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async (e) => {
      const view = viewRef.current;
      const path = filePathRef.current;
      if (view && path && extConflictRef.current !== null) {
        const ok = await ask(
          "The file has an unresolved disk conflict. Quit and discard your in-memory version?",
          { title: "Quit Liauth", kind: "warning" },
        );
        if (!ok) {
          e.preventDefault();
          flash("Resolve the disk conflict before closing");
        }
        return;
      }
      if (view && path && diskDirtyRef.current) {
        try {
          const content = view.state.doc.toString();
          await api.saveDocument(
            path,
            content,
            undefined,
            false,
          );
          diskDirtyRef.current = false;
          lastDiskRef.current = content;
        } catch {
          const ok = await ask(
            "Autosave failed. Quit and discard unsaved in-memory changes?",
            { title: "Quit Liauth", kind: "warning" },
          );
          if (!ok) {
            e.preventDefault();
            flash("Autosave failed; close canceled");
          }
        }
        return;
      }
      if (view && !path && view.state.doc.length > 0) {
        const ok = await ask(
          "The untitled document has unsaved content. Quit anyway?",
          { title: "Quit Liauth", kind: "warning" },
        );
        if (!ok) e.preventDefault();
      }
    });
    return () => {
      void un.then((f) => f());
    };
    // Close handling is registered once; it reads live state through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doOpen = useCallback(async () => {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (typeof path === "string") await openPath(path);
  }, [openPath]);

  // Open Folder…: navigator rooted at the folder (or its repo), and a
  // fresh untitled buffer that will save into it. Untitled means no
  // autosave — nothing exists on disk until the user names the file.
  const doOpenFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true });
    if (typeof dir !== "string") return;
    if (!(await leaveCurrentDocument("Open folder"))) return;
    unwatchRef.current?.();
    unwatchRef.current = null;
    setFilePath(null);
    setViewing(null);
    setDirty(false);
    setExtConflict(null);
    diskDirtyRef.current = false;
    lastDiskRef.current = "";
    setEditorContent("");
    setRepo(null);
    setHistory([]);
    setBranches([]);
    setOpenFolder(dir);
    setNavOpen(true);
  }, [leaveCurrentDocument, setEditorContent]);

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
      const content = view.state.doc.toString();
      await api.saveDocument(
        filePath,
        content,
        "Initial version",
      );
      diskDirtyRef.current = false;
      lastDiskRef.current = content;
      setDirty(false);
    }
    const info = await refreshGit(filePath);
    if (!diskDirtyRef.current) setDirty(info.file_dirty);
    flash("Versioning enabled");
  }, [filePath, refreshGit, flash]);

  const viewVersion = useCallback(
    async (commit: api.CommitInfo) => {
      if (!filePath) return;
      const saved = await autoSave();
      if (saved === "blocked-conflict") {
        flash("Resolve the disk conflict before viewing history");
        return;
      }
      if (saved === "failed") {
        flash("Autosave failed; current version left open");
        return;
      }
      const content = await api.fileAtCommit(filePath, commit.id);
      setViewing(commit);
      setEditorContent(content, true);
    },
    [filePath, autoSave, flash, setEditorContent],
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
    diskDirtyRef.current = true;
    setDirty(true);
    flash(
      `Restored ${viewing.id.slice(0, 7)} into the editor — save to commit`,
    );
  }, [filePath, viewing, setEditorContent, flash]);

  const newReviewBranch = useCallback(async () => {
    if (!filePath) return;
    const name = window.prompt("Review branch name", "review/reviewer");
    if (!name) return;
    const saved = await autoSave();
    if (saved === "blocked-conflict") {
      flash("Resolve the disk conflict before creating a review branch");
      return;
    }
    if (saved === "failed") {
      flash("Autosave failed; review branch not created");
      return;
    }
    try {
      await api.createBranch(filePath, name, true);
      await loadFile(filePath);
      flash(`On branch ${name} — edits here stay separate until merged`);
    } catch (e) {
      flash(`Could not create branch: ${e}`);
    }
  }, [filePath, autoSave, loadFile, flash]);

  const switchBranch = useCallback(
    async (name: string) => {
      if (!filePath) return;
      if (dirty) {
        flash("Commit uncommitted changes before switching branches");
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
        flash("Commit uncommitted changes before merging");
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
    // Give the DOM a frame to flush #print-root before the native snapshot.
    requestAnimationFrame(() => {
      api.printPage().catch(() => window.print());
    });
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

  // Central command runner: native menus, the command palette, and the
  // remaining toolbar buttons all route through here.
  const execCommand = useCallback(
    (id: string) => {
      if (id.startsWith("recent:")) {
        void openPath(id.slice(7));
        return;
      }
      if (id.startsWith("theme:")) {
        setTheme(id.slice(6) as Theme);
        return;
      }
      if (id.startsWith("font:")) {
        setFont(id.slice(5) as FontPref);
        return;
      }
      const view = viewRef.current;
      switch (id) {
        case "open":
          void doOpen();
          break;
        case "open-folder":
          void doOpenFolder();
          break;
        case "save":
          void doSave();
          break;
        case "save-as":
          void doSaveAs();
          break;
        case "reload":
          void doReload();
          break;
        case "export-pdf":
          exportPdf();
          break;
        case "check-updates":
          void checkForUpdates();
          break;
        case "quit":
          void getCurrentWindow().close();
          break;
        case "clear-recents":
          setRecents([]);
          break;
        case "bold":
          if (view) {
            toggleBold(view);
            view.focus();
          }
          break;
        case "italic":
          if (view) {
            toggleItalic(view);
            view.focus();
          }
          break;
        case "insert-note":
          addNote();
          break;
        case "zoom-in":
          setZoom((z) => clampZoom(z + ZOOM_STEP));
          break;
        case "zoom-out":
          setZoom((z) => clampZoom(z - ZOOM_STEP));
          break;
        case "zoom-reset":
          setZoom(1);
          break;
        case "toggle-lines":
          setLineNums((v) => !v);
          break;
        case "toggle-vim":
          setVimMode((v) => !v);
          break;
        case "toggle-room":
          setRoom((r) => !r);
          break;
        case "toggle-page":
          setPageLayout((p) => !p);
          break;
        case "rsvp":
          startRsvp();
          break;
        case "panel-notes":
          toggleNotesPanel();
          break;
        case "panel-history":
          setPanel((p) => (p === "history" ? "none" : "history"));
          break;
        case "panel-review":
          setPanel((p) => (p === "review" ? "none" : "review"));
          break;
        case "panel-help":
          setPanel((p) => (p === "help" ? "none" : "help"));
          break;
        case "edit-vimrc":
          if (panelRef.current === "vimrc") setPanel("none");
          else void openVimrcPanel();
          break;
        case "toggle-nav":
          setNavOpen((v) => !v);
          break;
        case "enable-versioning":
          void enableVersioning();
          break;
        case "new-review-branch":
          void newReviewBranch();
          break;
        case "palette":
          setPaletteOpen(true);
          break;
      }
    },
    [
      openPath,
      doOpen,
      doOpenFolder,
      doSave,
      doSaveAs,
      doReload,
      exportPdf,
      checkForUpdates,
      addNote,
      startRsvp,
      toggleNotesPanel,
      enableVersioning,
      newReviewBranch,
      openVimrcPanel,
    ],
  );

  useEffect(() => {
    runRef.current = execCommand;
  }, [execCommand]);

  // Native menu bar: rebuilt whenever the state it reflects changes.
  useEffect(() => {
    void buildAppMenu((id) => runRef.current(id), {
      theme,
      font,
      vim: vimMode,
      lineNumbers: lineNums,
      pageLayout,
      room,
      navOpen,
      versioned,
      panel,
      recents,
    }).catch((e) => console.warn("[liauth] menu build failed:", e));
  }, [
    theme,
    font,
    vimMode,
    lineNums,
    pageLayout,
    room,
    navOpen,
    versioned,
    panel,
    recents,
  ]);

  const paletteCommands: PaletteCommand[] = [
    { id: "open", title: "Open…", shortcut: "⌘O" },
    { id: "open-folder", title: "Open Folder…", shortcut: "⇧⌘O" },
    { id: "save", title: "Save (Commit)", shortcut: "⌘S" },
    { id: "save-as", title: "Save As…", shortcut: "⇧⌘S" },
    { id: "reload", title: "Reload from Disk", shortcut: "⌘R" },
    { id: "export-pdf", title: "Export as PDF", shortcut: "⇧⌘E" },
    { id: "check-updates", title: "Check for Updates…" },
    { id: "bold", title: "Bold", shortcut: "⌘B" },
    { id: "italic", title: "Italic", shortcut: "⌘I" },
    { id: "insert-note", title: "Insert Note", shortcut: "⇧⌘M" },
    {
      id: "toggle-room",
      title: room ? "Exit Writing Room" : "Enter Writing Room",
      shortcut: "⇧⌘F",
    },
    { id: "rsvp", title: "Speed Read", shortcut: "⇧⌘R" },
    {
      id: "toggle-lines",
      title: lineNums ? "Hide Line Numbers" : "Show Line Numbers",
      shortcut: "⇧⌘L",
    },
    {
      id: "toggle-page",
      title: pageLayout ? "Exit Page Layout" : "Page Layout",
      shortcut: "⇧⌘P",
    },
    {
      id: "toggle-vim",
      title: vimMode ? "Disable Vim Keybindings" : "Enable Vim Keybindings",
    },
    { id: "edit-vimrc", title: "Edit Vim Config…" },
    { id: "zoom-in", title: "Zoom In", shortcut: "⌘+" },
    { id: "zoom-out", title: "Zoom Out", shortcut: "⌘−" },
    { id: "zoom-reset", title: "Actual Size", shortcut: "⌘0" },
    ...THEMES.map((t) => ({ id: `theme:${t.id}`, title: `Theme: ${t.label}` })),
    ...FONTS.map((f) => ({ id: `font:${f.id}`, title: `Font: ${f.label}` })),
    {
      id: "toggle-nav",
      title: navOpen ? "Hide Files Sidebar" : "Show Files Sidebar",
      shortcut: "⇧⌘B",
    },
    { id: "panel-notes", title: "Toggle Notes Panel" },
    { id: "panel-help", title: "Help" },
    ...(versioned
      ? [
          { id: "panel-history", title: "Toggle History Panel" },
          { id: "panel-review", title: "Toggle Review Panel" },
          { id: "new-review-branch", title: "New Review Branch…" },
        ]
      : [{ id: "enable-versioning", title: "Enable Versioning…" }]),
    ...recents.map((p) => ({
      id: `recent:${p}`,
      title: `Open Recent: ${p.split("/").pop()}`,
    })),
  ];

  return (
    <div className={`app${room ? " room" : ""}`}>
      <div className="toolbar-hotzone" />
      <header className="toolbar">
        <div className="toolbar-left">
          <button
            className={navOpen ? "active" : ""}
            title="Files sidebar (⌘⇧B)"
            onClick={() => execCommand("toggle-nav")}
          >
            Files
          </button>
          {/* Outside room mode the native title bar already shows the
              file name and edited state; repeat it only in room mode,
              where fullscreen hides the title bar. */}
          {room ? (
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
          ) : null}
        </div>
        <div className="toolbar-right">
          <button
            onClick={() => execCommand("reload")}
            disabled={!filePath}
            title="Reload from disk (⌘R)"
          >
            ↻
          </button>
          <button
            className={panel === "notes" ? "active" : ""}
            title="Notes (insert with ⌘⇧M)"
            onClick={() => execCommand("panel-notes")}
          >
            Notes
          </button>
          {versioned ? (
            <>
              <button
                className={panel === "history" ? "active" : ""}
                onClick={() => execCommand("panel-history")}
              >
                History
              </button>
              <button
                className={panel === "review" ? "active" : ""}
                onClick={() => execCommand("panel-review")}
              >
                Review
              </button>
            </>
          ) : (
            <button
              onClick={() => execCommand("enable-versioning")}
              disabled={!filePath}
            >
              Enable versioning
            </button>
          )}
          <button
            className={panel === "help" ? "active" : ""}
            title="Help"
            onClick={() => execCommand("panel-help")}
          >
            ?
          </button>
        </div>
      </header>

      {repo?.merging ? (
        <div className="banner warning">
          Merge in progress — resolve conflicts in the editor, then Save to
          conclude.
          <button onClick={() => void doAbortMerge()}>Abort merge</button>
        </div>
      ) : null}

      {extConflict !== null ? (
        <div className="banner warning">
          The file changed on disk while you have unsaved edits.
          <button onClick={() => void resolveExternal("merge")}>
            Merge (3-way)
          </button>
          <button onClick={() => void resolveExternal("mine")}>
            Keep mine
          </button>
          <button onClick={() => void resolveExternal("theirs")}>
            Take disk
          </button>
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
        {navOpen && !room ? (
          <aside className="nav-panel">
            <h3 title={project?.root}>{project?.name ?? "Project"}</h3>
            {!filePath ? (
              <p className="muted">Open a document to list its project.</p>
            ) : null}
            {project?.truncated ? (
              <p className="muted">Showing first 500 markdown files.</p>
            ) : null}
            <ul className="nav-list">
              {(project?.files ?? []).map((f, i, all) => {
                const cut = f.rel.lastIndexOf("/");
                const dir = cut >= 0 ? f.rel.slice(0, cut) : "";
                const name = cut >= 0 ? f.rel.slice(cut + 1) : f.rel;
                const prev = i > 0 ? all[i - 1].rel : "";
                const prevCut = prev.lastIndexOf("/");
                const prevDir = prevCut >= 0 ? prev.slice(0, prevCut) : "";
                const cls = [
                  f.path === filePath ? "selected" : "",
                  dir ? "nested" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <Fragment key={f.path}>
                    {dir && dir !== prevDir ? (
                      <li className="nav-dir">{dir}/</li>
                    ) : null}
                    <li
                      className={cls}
                      title={f.rel}
                      onClick={() => {
                        if (f.path !== filePath) void openPath(f.path);
                      }}
                    >
                      {name}
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          </aside>
        ) : null}

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

        {panel === "help" ? (
          <HelpPanel vimActive={vimMode} vimrc={vimrc} />
        ) : null}

        {panel === "vimrc" ? (
          <aside className="side-panel vimrc-panel">
            <h3 className="panel-title">
              Vim Config
              <button
                className="panel-close"
                title="Close (esc)"
                onClick={() => setPanel("none")}
              >
                ×
              </button>
            </h3>
            <textarea
              className="vimrc-editor"
              value={vimrcDraft}
              onChange={(e) => setVimrcDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setPanel("none");
              }}
              spellCheck={false}
              autoFocus
            />
            <button className="wide" onClick={() => void saveVimrc()}>
              Save &amp; Apply
            </button>
            <p className="muted">
              Saved to <code>~/.config/liauth/vimrc</code> and applied
              immediately. Removing a mapping takes effect after restart.
            </p>
          </aside>
        ) : null}
      </main>

      <footer className="statusbar">
        <span>
          {versioned && repo?.branch ? `⎇ ${repo.branch}` : ""}
          {repo?.merging ? " · merging" : ""}
        </span>
        <span>
          Ln {cursor.line}, Col {cursor.col} · {counts.words.toLocaleString()}{" "}
          words · {counts.chars.toLocaleString()} chars
          {zoom !== 1 ? ` · ${Math.round(zoom * 100)}%` : ""}
        </span>
        <span>{lastSave || (dirty ? "uncommitted changes" : "")}</span>
      </footer>

      {status ? <div className="status-toast">{status}</div> : null}
      {rsvp ? (
        <RsvpOverlay
          words={rsvp.words}
          startIndex={rsvp.startIndex}
          onExit={exitRsvp}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          commands={paletteCommands}
          onRun={execCommand}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      <div id="print-root" />
    </div>
  );
}

export default App;
