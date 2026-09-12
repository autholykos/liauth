import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { Vim, getCM } from "@replit/codemirror-vim";
import App from "../src/App";
import * as api from "../src/api";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { watch } from "@tauri-apps/plugin-fs";
import type { AppCommand } from "../src/commands";
import { showNavigatorFolderMenu } from "../src/menu";

const native = vi.hoisted(() => ({
  commands: [] as AppCommand[],
  close: vi.fn(),
}));
vi.mock("../src/menu", () => ({
  buildAppMenu: vi.fn(async (commands) => {
    native.commands = commands;
  }),
  showEditorSelectionMenu: vi.fn(),
  showNavigatorFileMenu: vi.fn(),
  showNavigatorFolderMenu: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    setTitle: vi.fn().mockResolvedValue(undefined),
    setFullscreen: vi.fn().mockResolvedValue(undefined),
    onCloseRequested: vi.fn().mockResolvedValue(() => {}),
    close: native.close,
  }),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  watch: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
  ask: vi.fn().mockResolvedValue(true),
  message: vi.fn(),
}));
vi.mock("../src/api", () => ({
  readDocument: vi.fn(),
  saveDocument: vi.fn(),
  saveFolder: vi.fn(),
  repoInfo: vi.fn(),
  takePendingOpen: vi.fn(),
  readVimConfig: vi.fn(),
  warmNoteCache: vi.fn(),
  listProjectFiles: vi.fn(),
  searchProjectFiles: vi.fn(),
  fileHistory: vi.fn(),
  listBranches: vi.fn(),
  listWorktrees: vi.fn(),
  mergeContents: vi.fn(),
  fileAtCommit: vi.fn(),
  historyDiff: vi.fn(),
  checkoutBranch: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
const run = async (id: string) => {
  await act(async () => {
    await native.commands.find((c) => c.id === id)!.run();
  });
};
const editor = () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
const click = async (label: string) => {
  const button = [...host.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
  expect(button).toBeDefined();
  await act(async () => button.click());
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
  // jsdom has no layout engine; these tests exercise editor state and actions.
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.scrollIntoView = () => {};
  localStorage.clear();
  localStorage.setItem("liauth.lastFile", "/novel/first.md");
  vi.mocked(api.readDocument).mockResolvedValue("First {>>note<<}");
  vi.mocked(api.saveDocument).mockResolvedValue(null);
  vi.mocked(api.saveFolder).mockResolvedValue(null);
  vi.mocked(api.repoInfo).mockResolvedValue({
    repo_root: "/novel",
    branch: "main",
    merging: false,
    file_dirty: false,
  });
  vi.mocked(api.takePendingOpen).mockResolvedValue(null);
  vi.mocked(api.readVimConfig).mockResolvedValue(null);
  vi.mocked(api.fileHistory).mockResolvedValue([
    { id: "1234567", summary: "First version", time: 1, author: "Writer" },
  ]);
  vi.mocked(api.listBranches).mockResolvedValue([]);
  vi.mocked(api.listWorktrees).mockResolvedValue([]);
  vi.mocked(api.listProjectFiles).mockResolvedValue(null);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<App />));
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("keeps Undo and notes in sync when options are changed through app commands", async () => {
  expect(editor().state.doc.toString()).toBe("First {>>note<<}");
  await act(async () =>
    editor().dispatch({
      changes: { from: 0, insert: "New " },
      selection: { anchor: 2 },
    }),
  );
  await run("toggle-lines");
  await run("toggle-room");
  await run("toggle-room");
  await act(async () => {
    expect(undo(editor())).toBe(true);
  });
  expect(editor().state.doc.toString()).toBe("First {>>note<<}");
  await run("panel-notes");
  expect(host.querySelectorAll(".note-list li")).toHaveLength(1);
  await click("Dismiss");
  expect(editor().state.doc.toString()).toBe("First ");
  expect(host.querySelectorAll(".note-list li")).toHaveLength(0);
});

it("returns keyboard focus to the editor when closing the command palette", async () => {
  await run("palette");
  const input = host.querySelector(".palette-input")!;
  expect(document.activeElement).toBe(input);
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  expect(host.querySelector(".palette-input")).toBeNull();
  expect(editor().hasFocus).toBe(true);
});

it("keeps the Vim leave-insert autosave connected after enabling Vim", async () => {
  await run("toggle-vim");
  await act(async () => {
    const cm = getCM(editor())!;
    Vim.handleKey(cm, "i");
    editor().dispatch({ changes: { from: 0, insert: "Edited " } });
    Vim.handleKey(cm, "<Esc>");
  });
  expect(api.saveDocument).toHaveBeenCalledWith(
    "/novel/first.md",
    "Edited First {>>note<<}",
    undefined,
    false,
  );
});

it("clears document and history when opening a folder", async () => {
  vi.mocked(openDialog).mockResolvedValue("/another");
  await run("open-folder");
  expect(editor().state.doc.length).toBe(0);
  expect(localStorage.getItem("liauth.lastFile")).toBeNull();
  expect(native.commands.some((c) => c.id === "panel-history")).toBe(false);
  expect(host.querySelector(".statusbar")?.textContent).not.toContain("main");
});

it("runs Save all from the folder menu, writes the buffer, and refreshes folder indicators", async () => {
  const files = [
    { path: "/novel/first.md", rel: "first.md", dirty: true, has_notes: true },
    {
      path: "/novel/part/second.md",
      rel: "part/second.md",
      dirty: true,
      has_notes: false,
    },
  ];
  vi.mocked(api.listProjectFiles).mockResolvedValue({
    root: "/novel",
    name: "Novel",
    files,
    truncated: false,
  });
  await run("toggle-nav");
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "New " } }),
  );
  const rootFolder = host.querySelector(".nav-root button")!;
  await act(async () =>
    rootFolder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  const saveAll = vi.mocked(showNavigatorFolderMenu).mock.calls.at(-1)![3]!;
  vi.mocked(api.listProjectFiles).mockResolvedValue({
    root: "/novel",
    name: "Novel",
    files: files.map((file) => ({ ...file, dirty: false })),
    truncated: false,
  });
  await act(async () => {
    saveAll();
  });
  expect(api.saveDocument).toHaveBeenCalledWith(
    "/novel/first.md",
    "New First {>>note<<}",
    undefined,
    false,
  );
  expect(api.saveFolder).toHaveBeenCalledWith("/novel");
  expect(host.querySelector(".nav-folder-toggle.dirty")).toBeNull();
  expect(host.querySelector(".nav-root .nav-note-dot")).not.toBeNull();
});

it("shows folder groups for global search and opens a match", async () => {
  vi.mocked(api.searchProjectFiles).mockResolvedValue({
    matches: [
      {
        path: "/novel/first.md",
        rel: "first.md",
        line: 1,
        column: 0,
        length: 5,
        preview: "First",
      },
      {
        path: "/novel/part/second.md",
        rel: "part/second.md",
        line: 1,
        column: 0,
        length: 5,
        preview: "First",
      },
    ],
    truncated: false,
  });
  await click("Search");
  const input = host.querySelector<HTMLInputElement>(".nav-search-input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "First");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 220));
  });
  expect(
    [...host.querySelectorAll(".nav-search-group")].map((group) =>
      group.getAttribute("aria-label"),
    ),
  ).toEqual(["Project", "part"]);
  await act(async () =>
    (
      host.querySelector(
        'button[title="part/second.md:1"]',
      ) as HTMLButtonElement
    ).click(),
  );
  expect(api.readDocument).toHaveBeenCalledWith("/novel/part/second.md");
});

it("uses the normal Save As dialog for an untitled buffer when saving its folder", async () => {
  vi.mocked(api.listProjectFiles).mockResolvedValue({
    root: "/novel",
    name: "Novel",
    files: [],
    truncated: false,
  });
  vi.mocked(openDialog).mockResolvedValue("/novel");
  await run("open-folder");
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "New chapter" } }),
  );
  vi.mocked(saveDialog).mockResolvedValue("/novel/new.md");
  await act(async () =>
    host
      .querySelector(".nav-root button")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })),
  );
  await act(async () => {
    vi.mocked(showNavigatorFolderMenu).mock.calls.at(-1)![3]!();
  });
  expect(saveDialog).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: "/novel" }),
  );
  expect(api.saveDocument).toHaveBeenCalledWith(
    "/novel/new.md",
    "New chapter",
    undefined,
    true,
  );
  expect(api.saveFolder).toHaveBeenCalledWith("/novel");
  expect(editor().state.doc.toString()).toBe("New chapter");
});

it("handles a disk conflict through merge and leaves the merged text pending a save", async () => {
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "My " } }),
  );
  vi.mocked(api.readDocument).mockResolvedValue("Disk text");
  vi.mocked(api.mergeContents).mockResolvedValue({
    content: "conflict",
    conflicts: true,
  });
  const notify = vi.mocked(watch).mock.calls.at(-1)![1];
  await act(async () => {
    notify({} as never);
    await Promise.resolve();
  });
  expect(host.querySelector(".banner.warning")?.textContent).toContain(
    "changed on disk",
  );
  vi.mocked(api.mergeContents).mockResolvedValue({
    content: "Merged text",
    conflicts: false,
  });
  await click("Merge (3-way)");
  expect(editor().state.doc.toString()).toBe("Merged text");
  expect(host.querySelector(".banner.warning")).toBeNull();
  await run("save");
  expect(api.saveDocument).toHaveBeenCalledWith(
    "/novel/first.md",
    "Merged text",
    undefined,
    true,
  );
});

it("restores historical text as an editable document without losing the file identity", async () => {
  vi.mocked(api.fileAtCommit).mockResolvedValue("Historical text");
  vi.mocked(api.historyDiff).mockResolvedValue([]);
  await run("panel-history");
  await act(async () =>
    (host.querySelector(".commit-list li") as HTMLElement).click(),
  );
  expect(editor().state.readOnly).toBe(true);
  expect(editor().state.doc.toString()).toBe("Historical text");
  await click("Restore this version");
  expect(editor().state.readOnly).toBe(false);
  await run("save");
  expect(api.saveDocument).toHaveBeenCalledWith(
    "/novel/first.md",
    "Historical text",
    undefined,
    true,
  );
});

it.each(["Keep mine", "Take disk"])(
  "resolves a disk conflict with %s",
  async (choice) => {
    await act(async () =>
      editor().dispatch({ changes: { from: 0, insert: "My " } }),
    );
    vi.mocked(api.readDocument).mockResolvedValue("Disk text");
    vi.mocked(api.mergeContents).mockResolvedValue({
      content: "conflict",
      conflicts: true,
    });
    const notify = vi.mocked(watch).mock.calls.at(-1)![1];
    await act(async () => {
      notify({} as never);
    });
    await click(choice);
    expect(editor().state.doc.toString()).toBe(
      choice === "Keep mine" ? "My First {>>note<<}" : "Disk text",
    );
    expect(host.querySelector(".banner.warning")).toBeNull();
    if (choice === "Keep mine") {
      expect(api.saveDocument).toHaveBeenCalledWith(
        "/novel/first.md",
        "My First {>>note<<}",
        undefined,
        false,
      );
    }
  },
);

it("blocks autosave while reconciling disk changes and preserves edits made during the merge", async () => {
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "My " } }),
  );
  vi.mocked(api.readDocument).mockResolvedValue("Disk text");
  let finish!: (result: { content: string; conflicts: boolean }) => void;
  vi.mocked(api.mergeContents).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const notify = vi.mocked(watch).mock.calls.at(-1)![1];
  await act(async () => {
    notify({} as never);
  });
  await act(async () => {
    window.dispatchEvent(new Event("blur"));
  });
  expect(api.saveDocument).not.toHaveBeenCalled();
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "New " } }),
  );
  await act(async () => {
    finish({ content: "Outdated merge", conflicts: false });
  });
  expect(editor().state.doc.toString()).toBe("New My First {>>note<<}");
  expect(host.querySelector(".banner.warning")).not.toBeNull();
});

it("does not discard typing while a branch switch is in progress", async () => {
  vi.mocked(api.listBranches).mockResolvedValue([
    {
      name: "review",
      is_head: false,
      checked_out_in: null,
      last_commit_time: 1,
    },
  ]);
  await run("reload");
  await run("panel-review");
  let finish!: () => void;
  vi.mocked(api.checkoutBranch).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await click("Switch");
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "New " } }),
  );
  vi.mocked(api.readDocument).mockResolvedValue("Other branch");
  await act(async () => {
    finish();
  });
  expect(editor().state.doc.toString()).toBe("New First {>>note<<}");
  expect(host.textContent).toContain("newer editor changes kept");
});
