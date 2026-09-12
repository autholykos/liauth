import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent as ReactMouseEvent,
} from "react";
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
import { watch } from "@tauri-apps/plugin-fs";
import { getCM } from "@replit/codemirror-vim";
import {
  createEditorState,
  toggleBold,
  toggleItalic,
  sweepGhostCursorLayers,
  setEditorOption,
  CursorStatus,
} from "./editor/setup";
import { dumpKeylog } from "./editor/keylog";
import {
  buildAppMenu,
  showEditorSelectionMenu,
  showNavigatorFileMenu,
  showNavigatorFolderMenu,
  type NavigatorFileAction,
} from "./menu";
import { CommandPalette } from "./CommandPalette";
import { RephraseDialog } from "./RephraseDialog";
import { applyVimrc, VimrcSummary } from "./editor/vimrc";
import { gotoNextHistoryChange, setHistoryDiff } from "./editor/historyDiff";
import { HelpPanel } from "./HelpPanel";
import {
  notesField,
  insertNote,
  insertSuggestion,
  gotoNextNote,
  applyEditsAsSuggestions,
  applyReplacementAsSuggestion,
  CommentNote,
  NoteMatch,
  SuggestionNote,
} from "./editor/notes";
import { buildRsvpWords, RsvpWord } from "./editor/rsvp";
import { RsvpOverlay } from "./RsvpOverlay";
import { renderMarkdown } from "./renderMarkdown";
import * as api from "./api";
import {
  DocumentSession,
  type DocumentSnapshot,
  type ViewedVersion,
} from "./documentSession";
import {
  createCommands,
  fallbackCommand,
  THEMES,
  type FontPref,
  type Theme,
  type AppCommand,
} from "./commands";
import { usePersistedSetting } from "./usePersistedSetting";
import { timeNow, baseName, parentPath, fmtTime } from "./format";
import { NotesPanel } from "./NotesPanel";
import { HistoryPanel } from "./HistoryPanel";
import { BranchesPanel } from "./BranchesPanel";
import { FileNavigator } from "./FileNavigator";
import { SearchResults } from "./SearchResults";
import { useFolderExpansion } from "./useFolderExpansion";
import { isInFolder } from "./folders";
import "./App.css";

type Panel = "none" | "history" | "review" | "notes" | "help" | "vimrc";
type NavigatorView = "files" | "search";
type WorkspaceSearchState = api.ProjectSearch | "searching" | "error" | null;
type AutoSaveResult = "ok" | "blocked-conflict" | "failed" | "changed";
type FileClipboard = { path: string; mode: "cut" | "copy" };
type RephraseState = {
  id: number;
  from: number;
  to: number;
  selection: string;
  context: string;
  document: string;
  path: string | null;
  repoRoot: string | null;
  skills: api.RephraseSkill[];
  skillsLoading: boolean;
  busy: boolean;
  error: string | null;
};

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

function loadRecents(stored: string | null): string[] {
  try {
    const parsed = JSON.parse(stored ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p) => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

function initialFont(stored: string | null): FontPref {
  return stored === "sans" || stored === "mono" ? stored : "serif";
}

function initialZoom(value: string | null): number {
  const stored = Number(value);
  return stored >= ZOOM_MIN && stored <= ZOOM_MAX ? stored : 1;
}

function initialTheme(stored: string | null): Theme {
  if (THEMES.some((t) => t.id === stored)) {
    return stored as Theme;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "paper";
}

function selectionContext(text: string, from: number, to: number): string {
  const before = text.lastIndexOf("\n\n", Math.max(0, from - 1));
  const after = text.indexOf("\n\n", to);
  return text.slice(
    before < 0 ? 0 : before + 2,
    after < 0 ? text.length : after,
  );
}

function App() {
  const editorHost = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const loadingRef = useRef(false);

  const [session] = useState(() => new DocumentSession());
  const {
    filePath,
    dirty,
    viewing,
    reinstating,
    extConflict,
    versioning,
    lastSave,
  } = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const repo = versioning?.repo ?? null;
  const [panel, setPanel] = useState<Panel>("none");
  const [squashing, setSquashing] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [vimMode, setVimMode] = usePersistedSetting(
    "liauth.vim",
    (stored) => stored === "1",
  );
  const [theme, setTheme] = usePersistedSetting("liauth.theme", initialTheme);
  const [room, setRoom] = useState(false);
  const [font, setFont] = usePersistedSetting("liauth.font", initialFont);
  const [zoom, setZoom] = usePersistedSetting("liauth.zoom", initialZoom);
  const [lineNums, setLineNums] = usePersistedSetting(
    "liauth.lines",
    (stored) => stored === "1",
  );
  // On unless switched off: prose wants the macOS dictionaries.
  const [spellcheck, setSpellcheck] = usePersistedSetting(
    "liauth.spell",
    (stored) => stored !== "0",
  );
  const [pageLayout, setPageLayout] = usePersistedSetting(
    "liauth.page",
    (stored) => stored === "1",
  );
  const [novelProof, setNovelProof] = useState(false);
  const [notes, setNotes] = useState<NoteMatch[]>([]);
  const [rsvp, setRsvp] = useState<{
    words: RsvpWord[];
    startIndex: number;
  } | null>(null);
  const editorOptions = {
    vim: vimMode,
    typewriter: room,
    lineNumbers: lineNums,
    spellcheck,
  };
  const editorOptionsRef = useRef(editorOptions);
  editorOptionsRef.current = editorOptions;
  const roomMountedRef = useRef(false);
  const reinstateHistoryRef = useRef<(index: number) => void>(() => {});
  const [recents, setRecents] = usePersistedSetting(
    "liauth.recents",
    loadRecents,
    JSON.stringify,
  );
  const [vimrc, setVimrc] = useState<VimrcSummary | null>(null);
  const [vimrcDraft, setVimrcDraft] = useState("");
  const [navOpen, setNavOpen] = usePersistedSetting(
    "liauth.nav",
    (stored) => stored === "1",
  );
  const [navigatorView, setNavigatorView] = useState<NavigatorView>("files");
  const [showHiddenFiles, setShowHiddenFiles] = usePersistedSetting(
    "liauth.hiddenFiles",
    (stored) => stored === "1",
  );
  const [project, setProject] = useState<api.ProjectFiles | null>(null);
  const [collapsedDirs, toggleNavigatorFolder] = useFolderExpansion(
    project?.root,
    filePath,
    navOpen && navigatorView === "files",
  );
  const [savingFolder, setSavingFolder] = useState<string | null>(null);
  const projectRequestRef = useRef(0);
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [workspaceSearch, setWorkspaceSearch] =
    useState<WorkspaceSearchState>(null);
  const workspaceSearchRequestRef = useRef(0);
  const workspaceSearchNavigationRef = useRef(0);
  const workspaceSearchInputRef = useRef<HTMLInputElement>(null);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(
    null,
  );
  // A folder opened directly (File ▸ Open Folder…): anchors the navigator
  // while the buffer is still untitled, and is where ⌘S will default to.
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rephrase, setRephrase] = useState<RephraseState | null>(null);
  const rephraseRef = useRef(rephrase);
  rephraseRef.current = rephrase;
  const rephraseIdRef = useRef(0);
  const [cursor, setCursor] = useState<CursorStatus>({ line: 1, col: 1 });
  const [counts, setCounts] = useState({ words: 0, chars: 0 });
  const countsTimerRef = useRef<number | undefined>(undefined);
  const runRef = useRef<(id: string) => void>(() => {});

  const fileName = filePath ? baseName(filePath) : "Untitled";
  const filesNavigatorOpen = navOpen && navigatorView === "files";
  const searchNavigatorOpen = navOpen && navigatorView === "search";

  // A newer toast must not be cleared by an older toast's timer: an error
  // arriving a second after "Toki is writing…" would vanish almost at once.
  const flashTimer = useRef<number | undefined>(undefined);
  const flash = useCallback((msg: string, ms = 4000) => {
    window.clearTimeout(flashTimer.current);
    setStatus(msg);
    flashTimer.current = window.setTimeout(() => setStatus(""), ms);
  }, []);

  const toggleNavigatorPanel = useCallback(
    (next: NavigatorView) => {
      const closing = navOpen && navigatorView === next;
      setNavigatorView(next);
      setNavOpen(!closing);
    },
    [navOpen, navigatorView],
  );

  const refreshNotes = useCallback(() => {
    const view = viewRef.current;
    if (view) setNotes(view.state.field(notesField));
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

  useEffect(updateCounts, [filePath, updateCounts]);

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
    const snapshot = session.getSnapshot();
    if (!view || !snapshot.filePath || snapshot.viewing || !snapshot.diskDirty)
      return "ok";
    if (snapshot.extConflict !== null) return "blocked-conflict";
    const content = view.state.doc.toString();
    try {
      const saved = await session.save(content, false);
      if (!saved.current) return "changed";
      session.setLastSave(`autosaved ${timeNow()}`);
      return session.getSnapshot().diskDirty ? "changed" : "ok";
    } catch (e) {
      console.warn("[liauth] autosave failed:", e);
      return "failed";
    }
  }, [session]);

  const autoSaveOr = useCallback(
    async (action: string): Promise<boolean> => {
      const saved = await autoSave();
      if (saved === "blocked-conflict")
        flash(`Resolve the disk conflict before ${action}`);
      if (saved === "failed") flash(`Autosave failed; ${action} canceled`);
      if (saved === "changed")
        flash(`Document changed while saving; ${action} canceled`);
      return saved === "ok";
    },
    [autoSave, flash],
  );

  useEffect(() => {
    const onBlur = () => void autoSave();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [autoSave]);

  const displayHistoryDiff = useCallback(
    (view: EditorView, comparison: ViewedVersion | null) => {
      view.dispatch({
        effects: setHistoryDiff.of(
          comparison
            ? {
                hunks: comparison.hunks,
                disabled: session.getSnapshot().reinstating !== null,
                onReinstate: (index) => reinstateHistoryRef.current(index),
              }
            : null,
        ),
      });
    },
    [],
  );

  // RSVP speed reading: starts at the cursor's word.
  const startRsvp = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const words = buildRsvpWords(
      view.state.doc.toString(),
      view.state.field(notesField),
    );
    if (words.length === 0) {
      flash("Nothing to read");
      return;
    }
    const head = view.state.selection.main.head;
    let startIndex = words.findIndex((w) => head >= w.offset && head < w.end);
    if (startIndex < 0) startIndex = words.findIndex((w) => w.offset >= head);
    if (startIndex < 0) startIndex = words.length - 1;
    setRsvp({ words, startIndex });
  }, [flash]);

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

  const bindVimAutosave = useCallback(
    (view: EditorView) => {
      const cm = getCM(view);
      if (!cm) return;
      let lastMode = "normal";
      cm.on("vim-mode-change", (e: { mode: string }) => {
        if (lastMode === "insert" && e.mode !== "insert") void autoSave();
        lastMode = e.mode;
      });
    },
    [autoSave],
  );

  const setEditorContent = useCallback(
    (
      content: string,
      readOnly = false,
      comparison: ViewedVersion | null = null,
    ) => {
      // Loads, reloads, history views, and branch switches all pass through
      // here, so the Notes panel and navigator badge update in the same frame.
      setRephrase(null);
      const view = viewRef.current;
      if (!view) return;
      loadingRef.current = true;
      view.setState(
        createEditorState(
          content,
          {
            onChange: () => {
              if (!loadingRef.current) {
                session.edit();
              }
              scheduleCounts();
              // Notes also drive the navigator badge, so keep them current
              // even while the Notes panel itself is closed.
              refreshNotes();
            },
            onSave: () => runRef.current("save"),
            onToggleRoom: () => setRoom((r) => !r),
            onRsvp: () => runRef.current("rsvp"),
            onStatus: (s) => setCursor(s),
            onNotice: flash,
          },
          {
            readOnly,
            ...editorOptionsRef.current,
          },
        ),
      );
      refreshNotes();
      displayHistoryDiff(view, comparison);
      sweepGhostCursorLayers(view);
      bindVimAutosave(view);
      loadingRef.current = false;
    },
    [bindVimAutosave, displayHistoryDiff, flash, refreshNotes, scheduleCounts],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.font = font;
  }, [font]);

  useEffect(() => {
    document.documentElement.style.setProperty("--editor-zoom", String(zoom));
  }, [zoom]);

  const refreshProject = useCallback(
    async (anchor: string | null) => {
      const request = ++projectRequestRef.current;
      if (!navOpen || !anchor) {
        setProject(null);
        return;
      }
      try {
        const next = await api.listProjectFiles(anchor, showHiddenFiles);
        if (request === projectRequestRef.current) setProject(next);
      } catch {
        if (request === projectRequestRef.current) setProject(null);
      }
    },
    [navOpen, showHiddenFiles],
  );

  // Navigator contents: the markdown files of the document's project
  // (its git repo, or just its folder when unversioned). Re-roots when
  // versioning is enabled, since that creates the repo. An explicitly
  // opened folder anchors it while no document is open.
  useEffect(() => {
    void refreshProject(filePath ?? openFolder);
  }, [navOpen, filePath, openFolder, repo?.repo_root, refreshProject]);

  useEffect(() => {
    if (!navOpen || navigatorView !== "search") return;
    const frame = requestAnimationFrame(() =>
      workspaceSearchInputRef.current?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [navOpen, navigatorView]);

  useEffect(() => {
    const request = ++workspaceSearchRequestRef.current;
    const query = workspaceQuery.trim();
    const anchor = filePath ?? openFolder;
    if (!navOpen || navigatorView !== "search" || !anchor || !query) {
      setWorkspaceSearch(null);
      return;
    }

    setWorkspaceSearch("searching");
    const timer = window.setTimeout(() => {
      const currentFilePath = session.getSnapshot().viewing
        ? null
        : session.getSnapshot().filePath;
      const currentContent = currentFilePath
        ? (viewRef.current?.state.doc.toString() ?? null)
        : null;
      void api
        .searchProjectFiles(
          anchor,
          query,
          showHiddenFiles,
          currentFilePath,
          currentContent,
        )
        .then((result) => {
          if (request !== workspaceSearchRequestRef.current) return;
          setWorkspaceSearch(result ?? "error");
        })
        .catch(() => {
          if (request !== workspaceSearchRequestRef.current) return;
          setWorkspaceSearch("error");
        });
    }, 180);

    return () => window.clearTimeout(timer);
  }, [
    navOpen,
    navigatorView,
    workspaceQuery,
    filePath,
    openFolder,
    repo?.repo_root,
    showHiddenFiles,
  ]);

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
        if (editorOptionsRef.current.vim && summary.applied > 0) {
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

  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      setEditorOption(view, "vim", vimMode);
      bindVimAutosave(view);
    }
  }, [vimMode, bindVimAutosave]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) setEditorOption(view, "lineNumbers", lineNums);
  }, [lineNums]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) setEditorOption(view, "spellcheck", spellcheck);
  }, [spellcheck]);

  // Page layout: the content column styled as a paper sheet (pure CSS).
  useEffect(() => {
    document.documentElement.dataset.page = pageLayout ? "1" : "0";
  }, [pageLayout]);

  useEffect(() => {
    if (!novelProof) {
      requestAnimationFrame(() => viewRef.current?.focus());
    }
  }, [novelProof]);

  // Room mode: fullscreen, chrome hidden, typewriter scrolling. Theme and
  // font stay as they are — the Room theme is just an option in the picker.
  useEffect(() => {
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
      setEditorOption(view, "typewriter", room);
      view.focus();
    }
  }, [room]);

  const refreshGit = useCallback(
    (path: string) => session.refreshGit(path),
    [session],
  );

  // External-change handling: called by the file watcher. Our own writes
  // are recognized by comparing disk against what we last wrote.
  const handleExternalChange = useCallback(async () => {
    const view = viewRef.current;
    const snapshot = session.getSnapshot();
    const path = snapshot.filePath;
    if (!path || !view || snapshot.viewing) return;
    let disk: string;
    try {
      disk = await api.readDocument(path);
    } catch {
      return;
    } // deleted/renamed mid-event
    if (!session.sameDocument(snapshot) || session.getSnapshot().viewing)
      return;
    const current = session.getSnapshot();
    if (disk === current.lastDisk) return;
    const buffer = view.state.doc.toString();
    if (disk === buffer || !current.diskDirty) {
      session.acceptDisk(disk);
      if (disk !== buffer) setEditorContent(disk);
      await refreshGit(path);
      if (session.sameDocument(current) && disk !== buffer)
        flash("Reloaded — file changed on disk");
      return;
    }
    // Keep autosave blocked until the external version has been reconciled.
    session.setConflict(disk);
    const merging = session.getSnapshot();
    try {
      const merged = await api.mergeContents(current.lastDisk, buffer, disk);
      if (!session.isCurrent(merging)) return;
      if (!merged.conflicts) {
        session.mergeDisk(disk);
        setEditorContent(merged.content);
        flash("Merged concurrent changes from disk — save to commit");
      }
    } catch (e) {
      if (session.sameDocument(merging))
        flash(`Could not merge disk changes: ${e}`);
    }
  }, [session, setEditorContent, refreshGit, flash]);

  const watchFile = useCallback(
    async (path: string) => {
      const snapshot = session.getSnapshot();
      if (path !== snapshot.filePath) return;
      try {
        const unwatch = await watch(path, () => void handleExternalChange(), {
          delayMs: 500,
        });
        session.attachWatcher(snapshot, unwatch);
      } catch (e) {
        console.warn("[liauth] file watch failed:", e);
      }
    },
    [session, handleExternalChange],
  );

  useEffect(() => session.close, [session]);

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
        const content = await session.open(path);
        if (content === null) return false;
        const snapshot = session.getSnapshot();
        setEditorContent(content);
        setRecents((recent) =>
          [path, ...recent.filter((p) => p !== path)].slice(0, 8),
        );
        const info = await refreshGit(path);
        if (!session.sameDocument(snapshot)) return false;
        if (
          viewRef.current?.state
            .field(notesField)
            .some((n) => n.kind === "comment")
        ) {
          void api.warmNoteCache(content, info.repo_root);
        }
        await watchFile(path);
        return session.sameDocument(snapshot);
      } catch (e) {
        flash(`Could not open file: ${e}`);
        return false;
      }
    },
    [session, setEditorContent, setRecents, refreshGit, flash, watchFile],
  );

  const closeDocument = useCallback(
    (folder: string | null) => {
      session.close();
      localStorage.removeItem("liauth.lastFile");
      setOpenFolder(folder);
      setEditorContent("");
    },
    [session, setEditorContent],
  );

  const leaveCurrentDocument = useCallback(
    async (title: string): Promise<boolean> => {
      const view = viewRef.current;
      if (!view) return true;
      if (!session.getSnapshot().filePath && view.state.doc.length > 0) {
        return ask("Discard the untitled document?", {
          title,
          kind: "warning",
        });
      }
      return autoSaveOr("opening another document");
    },
    [autoSaveOr],
  );

  const openPath = useCallback(
    async (path: string) => {
      if (!(await leaveCurrentDocument("Open file"))) return false;
      if (!(await loadFile(path))) return false;
      // Opening is a deliberate switch to this document: keys should reach
      // it at once rather than the sidebar item or body that was clicked.
      viewRef.current?.focus();
      return true;
    },
    [leaveCurrentDocument, loadFile],
  );

  const openWorkspaceSearchMatch = useCallback(
    async (match: api.ProjectSearchMatch) => {
      const navigation = ++workspaceSearchNavigationRef.current;
      if (
        session.getSnapshot().filePath !== match.path ||
        session.getSnapshot().viewing !== null
      ) {
        if (!(await openPath(match.path))) return;
      }
      if (
        navigation !== workspaceSearchNavigationRef.current ||
        session.getSnapshot().filePath !== match.path
      ) {
        return;
      }
      const view = viewRef.current;
      if (!view || match.line > view.state.doc.lines) return;
      const line = view.state.doc.line(match.line);
      const from = Math.min(line.from + match.column, line.to);
      const to = Math.min(from + match.length, line.to);
      view.dispatch({
        selection: { anchor: from, head: to },
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });
      view.focus();
    },
    [openPath],
  );

  // Toki's one-line recap replaces the default "Save …" subject once it
  // arrives, provided the commit is still the latest one.
  const recapCommit = useCallback(
    async (path: string, commitId: string) => {
      try {
        const message = await api.describeCommit(path, commitId);
        await api.rewordCommit(path, commitId, message);
        if (
          session.getSnapshot().filePath === path &&
          !session.getSnapshot().viewing
        ) {
          await refreshGit(path);
        }
      } catch (e) {
        console.info("[liauth] commit recap skipped:", e);
      }
    },
    [refreshGit],
  );

  const doSave = useCallback(async () => {
    const view = viewRef.current;
    const start = session.getSnapshot();
    if (!view || start.viewing) return;
    let path = start.filePath;
    if (!path) {
      path = await saveDialog({
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
        defaultPath: openFolder ?? undefined,
      });
      if (
        !path ||
        !session.sameDocument(start) ||
        session.getSnapshot().viewing
      )
        return;
    }
    try {
      const { commit, current } = await session.save(
        view.state.doc.toString(),
        true,
        undefined,
        path,
      );
      if (!current) return;
      const snapshot = session.getSnapshot();
      session.setLastSave(
        commit
          ? `committed ${commit.id.slice(0, 7)} · ${timeNow()}`
          : `saved ${timeNow()}`,
      );
      const info = await refreshGit(path);
      if (!session.sameDocument(snapshot)) return;
      await refreshProject(path);
      if (!session.hasWatcher()) await watchFile(path);
      if (commit && !info.merging) void recapCommit(path, commit.id);
    } catch (e) {
      flash(`Save failed: ${e}`);
    }
  }, [
    session,
    openFolder,
    refreshGit,
    refreshProject,
    flash,
    watchFile,
    recapCommit,
  ]);

  const doSaveAs = useCallback(async () => {
    const view = viewRef.current;
    const start = session.getSnapshot();
    if (!view || start.viewing) return;
    const path = await saveDialog({
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      defaultPath: start.filePath ? baseName(start.filePath) : "Untitled",
    });
    if (!path || !session.sameDocument(start) || session.getSnapshot().viewing)
      return;
    try {
      const { current } = await session.save(
        view.state.doc.toString(),
        true,
        undefined,
        path,
      );
      if (!current) return;
      session.setLastSave(`saved as ${baseName(path)} · ${timeNow()}`);
      setRecents((recent) =>
        [path, ...recent.filter((p) => p !== path)].slice(0, 8),
      );
      await refreshGit(path);
      await watchFile(path);
    } catch (e) {
      flash(`Save As failed: ${e}`);
    }
  }, [session, setRecents, refreshGit, watchFile, flash]);

  const doReload = useCallback(async () => {
    const path = session.getSnapshot().filePath;
    if (!path) return;
    if (session.getSnapshot().diskDirty) {
      const ok = await ask("Discard unsaved changes and reload from disk?", {
        title: "Reload",
      });
      if (!ok) return;
    }
    await loadFile(path);
    flash("Reloaded from disk");
  }, [loadFile, flash]);

  const saveBeforeFileOperation = useCallback(
    async (path: string, action: string): Promise<boolean> => {
      if (path !== session.getSnapshot().filePath) return true;
      return autoSaveOr(action);
    },
    [autoSaveOr],
  );

  const projectAnchor = useCallback(
    () => session.getSnapshot().filePath ?? project?.root ?? openFolder,
    [project?.root, openFolder],
  );

  const renameNavigatorFile = useCallback(
    async (file: api.ProjectFile) => {
      const oldName = baseName(file.path);
      const newName = window.prompt("Rename file", oldName)?.trim();
      if (!newName || newName === oldName) return;
      if (!(await saveBeforeFileOperation(file.path, "renaming"))) return;
      try {
        const newPath = await api.renameProjectFile(file.path, newName);
        setRecents((recent) => [
          ...new Set(
            recent.map((path) => (path === file.path ? newPath : path)),
          ),
        ]);
        setFileClipboard((staged) =>
          staged?.path === file.path ? { ...staged, path: newPath } : staged,
        );
        if (session.getSnapshot().filePath === file.path) {
          await loadFile(newPath);
        } else {
          await refreshProject(projectAnchor());
        }
        flash(`Renamed to ${baseName(newPath)}`);
      } catch (e) {
        flash(`Could not rename file: ${e}`);
      }
    },
    [
      saveBeforeFileOperation,
      loadFile,
      refreshProject,
      projectAnchor,
      project?.root,
      openFolder,
      flash,
    ],
  );

  const stageNavigatorFile = useCallback(
    (file: api.ProjectFile, mode: FileClipboard["mode"]) => {
      setFileClipboard({ path: file.path, mode });
      flash(
        `${mode === "cut" ? "Cut" : "Copied"} ${baseName(file.path)} — ` +
          "choose Paste on the destination folder, or Paste Here on a file inside it",
      );
    },
    [flash],
  );

  const pasteNavigatorFile = useCallback(
    async (destinationPath: string) => {
      const staged = fileClipboard;
      if (!staged) return;
      const action = staged.mode === "cut" ? "moving" : "copying";
      if (!(await saveBeforeFileOperation(staged.path, action))) return;
      try {
        const newPath = await api.pasteProjectFile(
          staged.path,
          destinationPath,
          staged.mode === "cut",
        );
        const sourceIsCurrent = session.getSnapshot().filePath === staged.path;
        if (staged.mode === "cut") {
          setFileClipboard(null);
          if (newPath === staged.path) {
            flash("The file is already in that folder");
            return;
          }
          setRecents((recent) => [
            ...new Set(
              recent.map((path) => (path === staged.path ? newPath : path)),
            ),
          ]);
          if (sourceIsCurrent) await loadFile(newPath);
        }
        if (!(sourceIsCurrent && staged.mode === "cut")) {
          await refreshProject(projectAnchor());
        }
        flash(
          staged.mode === "cut"
            ? `Moved ${baseName(newPath)}`
            : `Copied as ${baseName(newPath)}`,
        );
      } catch (e) {
        flash(
          `Could not ${staged.mode === "cut" ? "move" : "copy"} file: ${e}`,
        );
      }
    },
    [
      fileClipboard,
      saveBeforeFileOperation,
      loadFile,
      refreshProject,
      projectAnchor,
      project?.root,
      openFolder,
      flash,
    ],
  );

  const deleteNavigatorFile = useCallback(
    async (file: api.ProjectFile) => {
      const wasCurrent = file.path === session.getSnapshot().filePath;
      const ok = await ask(
        `Delete “${file.rel}” permanently?` +
          (wasCurrent && session.getSnapshot().diskDirty
            ? " Unsaved edits will also be lost."
            : " This cannot be undone."),
        { title: "Delete File", kind: "warning" },
      );
      if (!ok) return;
      try {
        await api.deleteProjectFile(file.path);
        const isCurrent = file.path === session.getSnapshot().filePath;
        setRecents((recent) => recent.filter((path) => path !== file.path));
        setFileClipboard((staged) =>
          staged?.path === file.path ? null : staged,
        );
        const anchor = project?.root ?? openFolder ?? parentPath(file.path);
        if (isCurrent) {
          closeDocument(anchor);
        }
        if (!isCurrent) {
          await refreshProject(projectAnchor());
        }
        flash(`Deleted ${baseName(file.path)}`);
      } catch (e) {
        flash(`Could not delete file: ${e}`);
      }
    },
    [
      project?.root,
      openFolder,
      closeDocument,
      refreshProject,
      projectAnchor,
      flash,
    ],
  );

  const openNavigatorFileMenu = useCallback(
    (file: api.ProjectFile) => {
      void showNavigatorFileMenu((action: NavigatorFileAction) => {
        switch (action) {
          case "rename":
            void renameNavigatorFile(file);
            break;
          case "cut":
          case "copy":
            stageNavigatorFile(file, action);
            break;
          case "paste":
            void pasteNavigatorFile(file.path);
            break;
          case "delete":
            void deleteNavigatorFile(file);
            break;
        }
      }, fileClipboard !== null).catch((e) =>
        flash(`Could not open file menu: ${e}`),
      );
    },
    [
      fileClipboard,
      renameNavigatorFile,
      stageNavigatorFile,
      pasteNavigatorFile,
      deleteNavigatorFile,
      flash,
    ],
  );

  const saveFolder = useCallback(
    async (folder: string) => {
      if (savingFolder) return;
      const view = viewRef.current;
      let snapshot = session.getSnapshot();
      if (!view) return;
      setSavingFolder(folder);
      try {
        if (
          !snapshot.filePath &&
          openFolder &&
          isInFolder(openFolder, folder) &&
          view.state.doc.length > 0
        ) {
          const path = await saveDialog({
            filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
            defaultPath: openFolder,
          });
          if (
            !path ||
            !session.sameDocument(snapshot) ||
            session.getSnapshot().viewing
          )
            return;
          // Only the folder operation commits: a normal Save here would
          // capture unrelated entries from the repository's staging index.
          const named = await session.save(
            view.state.doc.toString(),
            false,
            undefined,
            path,
          );
          if (!named.current) return;
          snapshot = session.getSnapshot();
        }
        const saved = await session.saveFolder(
          folder,
          view.state.doc.toString(),
        );
        if (!saved.current) return;
        if (snapshot.filePath) await refreshGit(snapshot.filePath);
        if (!session.sameDocument(snapshot)) return;
        await refreshProject(projectAnchor());
        if (!session.sameDocument(snapshot)) return;
        if (snapshot.filePath && isInFolder(snapshot.filePath, folder)) {
          session.setLastSave(
            saved.commit
              ? `committed ${saved.commit.id.slice(0, 7)} · ${timeNow()}`
              : `saved ${timeNow()}`,
          );
        }
        flash(`Saved all documents in ${baseName(folder)}`);
      } catch (e) {
        flash(`Save all failed: ${e}`);
        if (session.sameDocument(snapshot))
          await refreshProject(projectAnchor());
      } finally {
        setSavingFolder(null);
      }
    },
    [
      savingFolder,
      session,
      openFolder,
      flash,
      refreshGit,
      refreshProject,
      projectAnchor,
    ],
  );

  const openNavigatorFolderMenu = useCallback(
    (dir: string) => {
      void showNavigatorFolderMenu(
        () => toggleNavigatorFolder(dir),
        collapsedDirs.has(dir),
        fileClipboard ? () => void pasteNavigatorFile(dir) : null,
        savingFolder ? null : () => void saveFolder(dir),
      ).catch((e) => flash(`Could not open folder menu: ${e}`));
    },
    [
      collapsedDirs,
      savingFolder,
      saveFolder,
      fileClipboard,
      toggleNavigatorFolder,
      pasteNavigatorFile,
      flash,
    ],
  );

  const resolveExternal = useCallback(
    async (mode: "merge" | "mine" | "theirs") => {
      const view = viewRef.current;
      const snapshot = session.getSnapshot();
      const { filePath: path, extConflict: disk } = snapshot;
      if (!view || !path || disk === null || snapshot.viewing) return;
      const buffer = view.state.doc.toString();
      try {
        if (mode === "mine") {
          const { current } = await session.save(buffer, false);
          if (!current) return;
          await refreshGit(path);
          if (session.sameDocument(snapshot))
            flash("Kept your version — disk overwritten");
        } else if (mode === "theirs") {
          if (await loadFile(path)) flash("Took the disk version");
        } else {
          const merged = await api.mergeContents(
            snapshot.lastDisk,
            buffer,
            disk,
          );
          if (
            !session.isCurrent(snapshot) ||
            session.getSnapshot().extConflict !== disk
          )
            return;
          session.mergeDisk(disk);
          setEditorContent(merged.content);
          flash(
            merged.conflicts
              ? "Conflict markers inserted — resolve them, then save"
              : "Merged — save to commit",
          );
        }
      } catch (e) {
        flash(`Could not resolve disk conflict: ${e}`);
      }
    },
    [session, loadFile, refreshGit, setEditorContent, flash],
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
      const path = e.payload.paths.find((p) => /\.(md|markdown|txt)$/i.test(p));
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
      const path = session.getSnapshot().filePath;
      if (view && path && session.getSnapshot().extConflict !== null) {
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
      if (view && path && session.getSnapshot().diskDirty) {
        try {
          const content = view.state.doc.toString();
          const { current } = await session.save(content, false);
          if (!current || session.getSnapshot().diskDirty) {
            e.preventDefault();
            flash("Document changed while saving; close canceled");
          }
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
    // Close handling reads the live session, including pending edits.
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
  const openFolderPath = useCallback(
    async (dir: string) => {
      if (!(await leaveCurrentDocument("Open folder"))) return;
      closeDocument(dir);
      setNavOpen(true);
    },
    [leaveCurrentDocument, closeDocument],
  );

  const doOpenFolder = useCallback(async () => {
    const dir = await openDialog({ directory: true });
    if (typeof dir === "string") await openFolderPath(dir);
  }, [openFolderPath]);

  const enableVersioning = useCallback(async () => {
    const snapshot = session.getSnapshot();
    const path = snapshot.filePath;
    if (!path) {
      flash("Save the document first");
      return;
    }
    const ok = await ask(
      "This will create a git repository in the document's folder. Continue?",
      { title: "Enable versioning" },
    );
    if (!ok || !session.sameDocument(snapshot) || session.getSnapshot().viewing)
      return;
    await api.initRepo(path);
    if (!session.sameDocument(snapshot) || session.getSnapshot().viewing)
      return;
    const view = viewRef.current;
    if (
      view &&
      !(await session.save(view.state.doc.toString(), true, "Initial version"))
        .current
    )
      return;
    await refreshGit(path);
    if (session.sameDocument(snapshot)) flash("Versioning enabled");
  }, [session, refreshGit, flash]);

  const viewVersion = useCallback(
    async (commit: api.CommitInfo) => {
      if (!(await autoSaveOr("viewing history"))) return;
      const view = viewRef.current;
      if (!view) return;
      try {
        const selected = await session.viewVersion(
          commit,
          view.state.doc.toString(),
        );
        if (selected)
          setEditorContent(selected.historicalContent, true, selected);
      } catch (e) {
        flash(`Could not view history: ${e}`);
      }
    },
    [session, autoSaveOr, setEditorContent, flash],
  );

  const backToCurrent = useCallback(async () => {
    const path = session.getSnapshot().filePath;
    if (path) await loadFile(path);
  }, [session, loadFile]);

  const restoreVersion = useCallback(() => {
    const viewing = session.getSnapshot().viewing;
    if (!viewing) return;
    session.setViewing(null);
    setEditorContent(viewing.historicalContent);
    session.edit();
    flash(
      `Restored ${viewing.id.slice(0, 7)} into the editor — save to commit`,
    );
  }, [session, setEditorContent, flash]);

  const reinstateHistoryChange = useCallback(
    async (index: number) => {
      const snapshot = session.getSnapshot();
      const path = snapshot.filePath;
      const comparison = snapshot.viewing;
      if (!path || !comparison || session.getSnapshot().reinstating !== null)
        return;

      session.setReinstating(index);
      try {
        const comparisonIsCurrent = () =>
          session.getSnapshot().viewing === comparison;
        const currentIsUnchanged = async () =>
          (await api.readDocument(path)) === comparison.currentContent;
        if (!comparisonIsCurrent()) return;
        if (!(await currentIsUnchanged())) {
          flash("Current file changed — reopen History before reinstating");
          return;
        }
        if (!comparisonIsCurrent()) return;
        const content = await api.reinstateHistoryHunk(
          comparison.currentContent,
          comparison.historicalContent,
          index,
        );
        if (!comparisonIsCurrent()) return;
        if (!(await currentIsUnchanged())) {
          flash("Current file changed — reopen History before reinstating");
          return;
        }
        if (!comparisonIsCurrent()) return;

        session.setViewing(null);
        setEditorContent(content);
        session.edit();
        flash("History change reinstated — save to commit");
      } catch (e) {
        flash(`Could not reinstate history change: ${e}`);
      } finally {
        if (session.sameDocument(snapshot)) session.setReinstating(null);
      }
    },
    [setEditorContent, flash],
  );

  reinstateHistoryRef.current = (index) => {
    void reinstateHistoryChange(index);
  };

  useEffect(() => {
    const view = viewRef.current;
    if (view) displayHistoryDiff(view, viewing);
  }, [viewing, reinstating, displayHistoryDiff]);

  const reloadAfterGit = useCallback(
    async (snapshot: DocumentSnapshot) => {
      if (!snapshot.filePath || !session.sameDocument(snapshot)) return false;
      if (!session.isCurrent(snapshot)) {
        await refreshGit(snapshot.filePath);
        flash("Repository changed; newer editor changes kept");
        return false;
      }
      return loadFile(snapshot.filePath);
    },
    [session, refreshGit, loadFile, flash],
  );

  const newReviewBranch = useCallback(async () => {
    if (!session.getSnapshot().filePath) return;
    const name = window.prompt(
      "Branch name",
      `draft-${new Date().toISOString().slice(0, 10)}`,
    );
    if (!name || !(await autoSaveOr("creating a branch"))) return;
    const snapshot = session.getSnapshot();
    if (!snapshot.filePath) return;
    try {
      await api.createBranch(snapshot.filePath, name, true);
      if (await reloadAfterGit(snapshot))
        flash(`On branch ${name} — edits here stay separate until merged`);
    } catch (e) {
      flash(`Could not create branch: ${e}`);
    }
  }, [session, autoSaveOr, reloadAfterGit, flash]);

  const switchBranch = useCallback(
    async (name: string) => {
      const snapshot = session.getSnapshot();
      if (!snapshot.filePath) return;
      if (snapshot.dirty) {
        flash("Save (⌘S) to commit your changes before switching branches");
        return;
      }
      try {
        await api.checkoutBranch(snapshot.filePath, name);
        if (await reloadAfterGit(snapshot)) flash(`Switched to ${name}`);
      } catch (e) {
        flash(`Could not switch: ${e}`);
      }
    },
    [session, reloadAfterGit, flash],
  );

  const deleteBranch = useCallback(
    async (name: string, worktree: string | null = null) => {
      const snapshot = session.getSnapshot();
      if (!snapshot.filePath) return;
      const question = worktree
        ? `Delete branch ${name} and remove worktree ${baseName(worktree)}? Its folder is deleted; commits only on the branch are lost.`
        : `Delete branch ${name}? Commits only on it are lost.`;
      if (
        !(await ask(question, { title: "Delete branch", kind: "warning" })) ||
        !session.sameDocument(snapshot)
      )
        return;
      try {
        await api.deleteBranch(snapshot.filePath, name);
        await refreshGit(snapshot.filePath);
        if (session.sameDocument(snapshot)) flash(`Deleted ${name}`);
      } catch (e) {
        flash(`Could not delete: ${e}`);
      }
    },
    [session, refreshGit, flash],
  );

  // The same document in another worktree, or its folder when absent.
  const openInWorktree = useCallback(
    async (dir: string) => {
      const snapshot = session.getSnapshot();
      const target = snapshot.filePath
        ? await api.worktreeDocument(snapshot.filePath, dir)
        : null;
      if (!session.sameDocument(snapshot)) return;
      if (target) await openPath(target);
      else await openFolderPath(dir);
    },
    [session, openPath, openFolderPath],
  );

  const doMerge = useCallback(
    async (name: string) => {
      const snapshot = session.getSnapshot();
      if (!snapshot.filePath) return;
      if (snapshot.dirty) {
        flash("Commit uncommitted changes before merging");
        return;
      }
      try {
        const result = await api.mergeBranch(snapshot.filePath, name);
        if (!(await reloadAfterGit(snapshot))) return;
        if (result.status === "conflicts")
          flash(
            "Conflicts — resolve the <<< >>> markers, then Save to conclude the merge",
          );
        else if (result.status === "up_to_date") flash("Already up to date");
        else flash(`Merged ${name}`);
      } catch (e) {
        flash(`Merge failed: ${e}`);
      }
    },
    [session, reloadAfterGit, flash],
  );

  const doAbortMerge = useCallback(async () => {
    const snapshot = session.getSnapshot();
    if (!snapshot.filePath) return;
    try {
      await api.abortMerge(snapshot.filePath);
      if (await reloadAfterGit(snapshot)) flash("Merge aborted");
    } catch (e) {
      flash(`Could not abort merge: ${e}`);
    }
  }, [session, reloadAfterGit, flash]);

  const exportPdf = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const root = document.getElementById("print-root");
    if (!root) return;
    const rendered = renderMarkdown(view.state.doc.toString(), novelProof);
    root.innerHTML = rendered.html;
    root.classList.toggle("novel-proof", novelProof);
    if (novelProof) root.lang = rendered.lang;
    else root.removeAttribute("lang");
    document.title =
      fileName?.replace(/\.(md|markdown|txt)$/i, "") ?? "document";
    // Give the DOM a frame to flush #print-root before the native snapshot.
    requestAnimationFrame(() => {
      api.printPage().catch(() => window.print());
    });
  }, [fileName, novelProof]);

  const addNote = useCallback(() => {
    const view = viewRef.current;
    if (!view || viewing) return;
    insertNote(view);
  }, [viewing]);

  const addSuggestion = useCallback(() => {
    const view = viewRef.current;
    if (!view || viewing) return;
    insertSuggestion(view);
  }, [viewing]);

  const startRephrase = useCallback(
    (from: number, to: number, selection: string, document: string) => {
      const id = ++rephraseIdRef.current;
      const repoRoot = repo?.repo_root ?? null;
      setRephrase({
        id,
        from,
        to,
        selection,
        context: selectionContext(document, from, to),
        document,
        path: session.getSnapshot().filePath,
        repoRoot,
        skills: [],
        skillsLoading: repoRoot !== null,
        busy: false,
        error: null,
      });
      if (!repoRoot) return;
      void api
        .listRephraseSkills(repoRoot)
        .then((skills) => {
          setRephrase((current) =>
            current?.id === id
              ? { ...current, skills, skillsLoading: false }
              : current,
          );
        })
        .catch((error) => {
          setRephrase((current) =>
            current?.id === id
              ? {
                  ...current,
                  skillsLoading: false,
                  error: `Could not load rephrase skills: ${error}`,
                }
              : current,
          );
        });
    },
    [repo?.repo_root],
  );

  const openEditorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const view = viewRef.current;
      if (!view || viewing || view.state.readOnly) return;
      if (view.state.selection.ranges.length !== 1) return;
      const { from, to } = view.state.selection.main;
      if (from === to) return;
      const clicked = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (clicked === null || clicked < from || clicked > to) return;
      event.preventDefault();
      const document = view.state.doc.toString();
      const selection = view.state.sliceDoc(from, to);
      const overlapsNote = view.state
        .field(notesField)
        .some((note) => from < note.to && to > note.from);
      void showEditorSelectionMenu(() => {
        if (overlapsNote) {
          flash("Rephrase cannot cross an existing note or suggestion");
          return;
        }
        startRephrase(from, to, selection, document);
      }).catch((error) => flash(`Could not open editor menu: ${error}`));
    },
    [viewing, startRephrase, flash],
  );

  const submitRephrase = useCallback(
    async (direction: string, synonymsOnly: boolean) => {
      const request = rephraseRef.current;
      if (!request || request.busy) return;
      setRephrase((current) =>
        current?.id === request.id
          ? { ...current, busy: true, error: null }
          : current,
      );
      try {
        const replacement = await api.rephraseSelection(
          request.selection,
          request.context,
          direction,
          synonymsOnly,
          request.repoRoot,
        );
        const live = viewRef.current;
        if (rephraseRef.current?.id !== request.id) return;
        if (
          !live ||
          session.getSnapshot().viewing ||
          session.getSnapshot().filePath !== request.path ||
          live.state.doc.toString() !== request.document
        ) {
          setRephrase(null);
          flash("Rephrase discarded — the document changed");
          return;
        }
        if (
          !applyReplacementAsSuggestion(
            live,
            request.from,
            request.to,
            request.selection,
            replacement,
          )
        ) {
          setRephrase((current) =>
            current?.id === request.id
              ? {
                  ...current,
                  busy: false,
                  error: "Toki returned a replacement that cannot be staged",
                }
              : current,
          );
          return;
        }

        setPanel("notes");
        setRephrase(null);
        flash("Rephrase staged as a suggestion");
      } catch (error) {
        setRephrase((current) =>
          current?.id === request.id
            ? { ...current, busy: false, error: String(error) }
            : current,
        );
      }
    },
    [flash],
  );

  const closeRephrase = useCallback(() => {
    setRephrase(null);
    requestAnimationFrame(() => viewRef.current?.focus());
  }, []);

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

  // Shared by dismiss/accept/reject: swap the whole markup span for `insert`,
  // guarding against a document that moved under the notes list.
  const replaceNoteSpan = useCallback(
    (n: NoteMatch, insert: string, msg: string) => {
      const view = viewRef.current;
      if (!view || viewing) return;
      if (view.state.sliceDoc(n.from, n.to) !== n.raw) {
        flash("Document changed — select the note again");
        return;
      }
      view.dispatch({ changes: { from: n.from, to: n.to, insert } });

      flash(msg);
    },
    [viewing, flash],
  );

  const dismissNote = useCallback(
    (n: CommentNote) =>
      replaceNoteSpan(n, n.highlighted ? n.excerpt : "", "Note dismissed"),
    [replaceNoteSpan],
  );

  const applySuggestion = useCallback(
    (n: SuggestionNote, accept: boolean) =>
      replaceNoteSpan(
        n,
        accept ? n.newText : n.oldText,
        accept ? "Suggestion accepted" : "Suggestion rejected",
      ),
    [replaceNoteSpan],
  );

  // note.from of the comment whose inference is running; one at a time.
  const [drafting, setDrafting] = useState<number | null>(null);

  const draftEdits = useCallback(
    async (n: CommentNote) => {
      const view = viewRef.current;
      if (!view || viewing || drafting !== null) return;
      const startDocument = session.getSnapshot();
      setDrafting(n.from);
      try {
        const pairs = await api.draftNoteEdits(
          n.comment,
          n.highlighted ? n.excerpt : null,
          view.state.doc.toString(),
          repo?.repo_root ?? null,
        );
        // Inference takes a while; don't apply to a different document or
        // to a read-only historical buffer opened meanwhile.
        if (
          !session.sameDocument(startDocument) ||
          session.getSnapshot().viewing
        ) {
          flash("Draft discarded — the document changed");
          return;
        }
        // The applier matches against the document as it is NOW, so edits
        // made while the model ran simply reduce to missed pairs.
        const live = viewRef.current;
        if (!live) return;
        const { applied, missed } = applyEditsAsSuggestions(live, pairs, n);

        flash(
          applied === 0
            ? "The model proposed no applicable edits"
            : `${applied} suggestion${applied === 1 ? "" : "s"} drafted` +
                (missed ? ` (${missed} not matched)` : "") +
                " — ⌘⇧J to review",
        );
      } catch (e) {
        flash(`Draft failed: ${e}`);
      } finally {
        setDrafting(null);
      }
    },
    [viewing, drafting, repo?.repo_root, flash],
  );

  const toggleNotesPanel = useCallback(() => {
    setPanel((p) => (p === "notes" ? "none" : "notes"));
  }, []);

  const versioned = !!repo?.repo_root;

  const squashRecentCommits = useCallback(
    async (base?: string) => {
      const snapshot = session.getSnapshot();
      const { filePath, dirty, versioning } = snapshot;
      if (!filePath || squashing) return;
      if (session.getSnapshot().viewing) {
        flash("Return to the current document before squashing");
        return;
      }
      if (dirty || session.getSnapshot().diskDirty) {
        flash("Commit current changes before squashing");
        return;
      }
      if (versioning?.repo.merging) {
        flash("Finish the merge before squashing");
        return;
      }
      setSquashing(true);
      flash("Toki is writing the squash commit message…");
      try {
        const commit = await api.squashRecentCommits(filePath, base);
        await refreshGit(filePath);
        if (!session.sameDocument(snapshot)) return;
        session.setLastSave(`squashed ${commit.id.slice(0, 7)} · ${timeNow()}`);
        flash(`Squashed into ${commit.id.slice(0, 7)}: ${commit.summary}`);
      } catch (e) {
        // The failure ends a wait of up to minutes: keep it readable in the
        // toast, and on record in the status bar until the next save.
        if (!session.sameDocument(snapshot)) return;
        session.setLastSave(`squash failed · ${e}`);
        flash(`Could not squash commits: ${e}`, 15000);
      } finally {
        setSquashing(false);
      }
    },
    [session, squashing, refreshGit, flash],
  );

  const commands = createCommands(
    {
      theme,
      font,
      vim: vimMode,
      lineNumbers: lineNums,
      spellcheck,
      pageLayout,
      novelProof,
      room,
      navOpen: filesNavigatorOpen,
      showHiddenFiles,
      versioned,
      squashing,
      panel,
      recents,
    },
    {
      open: doOpen,
      "open-folder": doOpenFolder,
      save: doSave,
      "save-as": doSaveAs,
      reload: doReload,
      "export-pdf": exportPdf,
      "check-updates": checkForUpdates,
      quit: () => {
        void getCurrentWindow().close();
      },
      "clear-recents": () => setRecents([]),
      bold: () => {
        if (viewRef.current) {
          toggleBold(viewRef.current);
          viewRef.current.focus();
        }
      },
      italic: () => {
        if (viewRef.current) {
          toggleItalic(viewRef.current);
          viewRef.current.focus();
        }
      },
      "insert-note": addNote,
      "insert-suggestion": addSuggestion,
      "next-note": () => {
        if (viewRef.current) gotoNextNote(viewRef.current);
      },
      "zoom-in": () => setZoom((z) => clampZoom(z + ZOOM_STEP)),
      "zoom-out": () => setZoom((z) => clampZoom(z - ZOOM_STEP)),
      "zoom-reset": () => setZoom(1),
      "toggle-lines": () => setLineNums((v) => !v),
      "toggle-spell": () => setSpellcheck((v) => !v),
      "toggle-vim": () => setVimMode((v) => !v),
      "toggle-room": () => setRoom((v) => !v),
      "toggle-page": () => setPageLayout((v) => !v),
      "toggle-novel-proof": () => setNovelProof((v) => !v),
      rsvp: () => {
        if (!rsvp) startRsvp();
      },
      "panel-notes": toggleNotesPanel,
      "panel-history": () =>
        setPanel((p) => (p === "history" ? "none" : "history")),
      "panel-review": () =>
        setPanel((p) => (p === "review" ? "none" : "review")),
      "panel-help": () => setPanel((p) => (p === "help" ? "none" : "help")),
      "edit-vimrc": () => {
        if (panel === "vimrc") setPanel("none");
        else void openVimrcPanel();
      },
      keylog: () => {
        if (viewRef.current) dumpKeylog(viewRef.current, flash);
      },
      "toggle-nav": () => toggleNavigatorPanel("files"),
      "toggle-hidden-files": () => setShowHiddenFiles((v) => !v),
      "enable-versioning": enableVersioning,
      "new-review-branch": newReviewBranch,
      "squash-recent": squashRecentCommits,
      palette: () => setPaletteOpen((open) => !open),
      openRecent: openPath,
      theme: setTheme,
      font: setFont,
    },
  );
  const commandsRef = useRef<AppCommand[]>(commands);
  commandsRef.current = commands;
  const execCommand = useCallback((id: string) => {
    commandsRef.current.find((command) => command.id === id)?.run();
  }, []);
  runRef.current = execCommand;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = fallbackCommand(commandsRef.current, event);
      if (!command) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Handlers read the current registry; rebuild labels/checks only when needed.
  useEffect(() => {
    void buildAppMenu(commandsRef.current, execCommand).catch((e) =>
      console.warn("[liauth] menu build failed:", e),
    );
  }, [
    theme,
    font,
    vimMode,
    lineNums,
    spellcheck,
    pageLayout,
    novelProof,
    room,
    navOpen,
    navigatorView,
    showHiddenFiles,
    versioned,
    squashing,
    panel,
    recents,
    execCommand,
  ]);

  const paletteCommands = commands.filter(
    (command) => command.palette !== false,
  );

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    // Release focus before the command runs, so it can focus its own UI.
    viewRef.current?.focus();
  }, []);

  const proofSource = novelProof
    ? (viewRef.current?.state.doc.toString() ?? "")
    : "";
  const proofDocument = useMemo(
    () => (novelProof ? renderMarkdown(proofSource, true) : null),
    [novelProof, proofSource],
  );

  return (
    <div className={`app${room ? " room" : ""}`}>
      <div className="toolbar-hotzone" />
      <header className="toolbar">
        <div className="toolbar-left">
          {/* The sidebars and panels are hidden here; say so, or a missing
              Files sidebar reads as a bug. */}
          {room ? (
            <button
              className="room-badge"
              title="Writing Room hides sidebars and panels. Click or press ⌘⇧F to leave."
              onClick={() => setRoom(false)}
            >
              Writing Room · ⌘⇧F to exit
            </button>
          ) : null}
          <button
            className={filesNavigatorOpen ? "active" : ""}
            title="Files sidebar (⌘⇧B)"
            onClick={() => toggleNavigatorPanel("files")}
          >
            Files
          </button>
          <button
            className={searchNavigatorOpen ? "active" : ""}
            title="Search workspace contents"
            onClick={() => toggleNavigatorPanel("search")}
          >
            Search
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
                Branches
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
          <button
            onClick={() => {
              const view = viewRef.current;
              if (view) gotoNextHistoryChange(view);
            }}
            disabled={viewing.hunks.length === 0}
          >
            Next change
          </button>
          <button
            onClick={() => void restoreVersion()}
            disabled={reinstating !== null}
          >
            Restore this version
          </button>
          <button
            onClick={() => void backToCurrent()}
            disabled={reinstating !== null}
          >
            Back to current
          </button>
        </div>
      ) : null}

      <main className="content">
        {searchNavigatorOpen && !room ? (
          <aside className="nav-panel">
            <h3 title={project?.root}>Search</h3>
            <div className="nav-search">
              <input
                ref={workspaceSearchInputRef}
                className="nav-search-input"
                type="search"
                value={workspaceQuery}
                onChange={(e) => setWorkspaceQuery(e.target.value)}
                placeholder="Search file contents…"
                aria-label="Search workspace contents"
                spellCheck={false}
              />
              {!filePath && !openFolder ? (
                <p className="muted">Open a document or folder to search.</p>
              ) : !workspaceQuery.trim() ? (
                <p className="muted">Search all documents in the workspace.</p>
              ) : workspaceSearch === "searching" ? (
                <p className="muted">Searching…</p>
              ) : workspaceSearch === "error" ? (
                <p className="muted">Could not search this workspace.</p>
              ) : workspaceSearch?.matches.length === 0 ? (
                <p className="muted">No matches.</p>
              ) : workspaceSearch ? (
                <>
                  <p className="nav-search-summary">
                    {workspaceSearch.matches.length} result
                    {workspaceSearch.matches.length === 1 ? "" : "s"}
                    {workspaceSearch.truncated ? " (first matches)" : ""}
                  </p>
                  <SearchResults
                    matches={workspaceSearch.matches}
                    rootName={project?.name ?? "Project"}
                    onOpen={(match) => void openWorkspaceSearchMatch(match)}
                  />
                </>
              ) : null}
            </div>
          </aside>
        ) : null}

        {filesNavigatorOpen && !room ? (
          <FileNavigator
            project={project}
            document={session.getSnapshot()}
            noteCount={notes.length}
            collapsedDirs={collapsedDirs}
            fileClipboard={fileClipboard}
            actions={{
              toggleNavigatorFolder,
              openNavigatorFolderMenu,
              openNavigatorFileMenu,
              openPath,
            }}
          />
        ) : null}

        {proofDocument ? (
          <div className="novel-proof-scroll">
            <article
              className="novel-proof novel-proof-screen"
              lang={proofDocument.lang}
              dangerouslySetInnerHTML={{ __html: proofDocument.html }}
            />
          </div>
        ) : null}

        <div
          className={`editor-wrap${novelProof ? " proof-hidden" : ""}`}
          ref={editorHost}
          onContextMenu={openEditorContextMenu}
          inert={novelProof}
        />

        {panel === "history" && versioned ? (
          <HistoryPanel
            document={session.getSnapshot()}
            squashing={squashing}
            viewVersion={viewVersion}
            squashRecentCommits={squashRecentCommits}
          />
        ) : null}

        {panel === "review" && versioning ? (
          <BranchesPanel
            versioning={versioning}
            actions={{
              newReviewBranch,
              doMerge,
              openInWorktree,
              deleteBranch,
              switchBranch,
            }}
          />
        ) : null}

        {panel === "notes" ? (
          <NotesPanel
            notes={notes}
            readOnly={!!viewing}
            drafting={drafting}
            actions={{
              addNote,
              addSuggestion,
              jumpToNote,
              applySuggestion,
              dismissNote,
              draftEdits,
            }}
          />
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
        <span>
          {squashing
            ? "Toki is squashing commits…"
            : lastSave || (dirty ? "uncommitted changes" : "")}
        </span>
      </footer>

      {status ? <div className="status-toast">{status}</div> : null}
      {rephrase ? (
        <RephraseDialog
          key={rephrase.id}
          selection={rephrase.selection}
          skills={rephrase.skills}
          skillsLoading={rephrase.skillsLoading}
          busy={rephrase.busy}
          error={rephrase.error}
          onSubmit={(direction, synonymsOnly) =>
            void submitRephrase(direction, synonymsOnly)
          }
          onClose={closeRephrase}
        />
      ) : null}
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
          onClose={closePalette}
        />
      ) : null}
      <div id="print-root" />
    </div>
  );
}

export default App;
