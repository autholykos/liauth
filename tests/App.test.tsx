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
import { wrappedMarkdown } from "./fixtures/wrappedMarkdown";
import { openUrl } from "@tauri-apps/plugin-opener";

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
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
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
  draftNoteEdits: vi.fn(),
}));

let root: Root;
let host: HTMLDivElement;
const run = async (id: string) => {
  await act(async () => {
    await native.commands.find((c) => c.id === id)!.run();
  });
};
const editor = () => EditorView.findFromDOM(host.querySelector(".cm-editor")!)!;
const expectCounts = (words: number, chars: number) => {
  expect(host.querySelector(".statusbar")?.textContent).toContain(
    `${words.toLocaleString()} words · ${chars.toLocaleString()} chars`,
  );
};
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
  vi.useRealTimers();
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

it("renders a read-only Markdown preview and preserves the editable document and Undo", async () => {
  const source =
    "First line\ncontinues here.\n\nForced break  \nstays separate.\n\n```text\ncode one\ncode two\n```\n\n| Name | Value |\n| --- | --- |\n| a | b |\n\n- one\n- two";
  vi.mocked(api.readDocument).mockResolvedValue(source);
  await run("reload");
  const view = editor();
  await act(async () =>
    view.dispatch({
      changes: { from: 0, insert: "Edited " },
      selection: { anchor: 7 },
    }),
  );
  const edited = view.state.doc.toString();
  await run("toggle-markdown-preview");
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
  const preview = host.querySelector(".markdown-preview-screen")!;
  const paragraphs = preview.querySelectorAll("p");
  expect(paragraphs[0].textContent?.replace(/\s+/g, " ")).toBe(
    "Edited First line continues here.",
  );
  expect(paragraphs[0].querySelector("br")).toBeNull();
  expect(paragraphs[1].querySelector("br")).not.toBeNull();
  expect(preview.querySelector("pre code")?.textContent).toBe(
    "code one\ncode two\n",
  );
  expect(preview.querySelectorAll("table tr")).toHaveLength(2);
  expect(preview.querySelectorAll("ul li")).toHaveLength(2);
  expect(host.querySelector(".editor-wrap")?.hasAttribute("inert")).toBe(true);
  expect(document.activeElement).toBe(
    host.querySelector(".markdown-preview-scroll"),
  );
  for (const id of ["bold", "italic", "insert-note", "insert-suggestion"]) {
    expect(native.commands.find((command) => command.id === id)?.enabled).toBe(
      false,
    );
    await run(id);
  }
  expect(view.state.doc.toString()).toBe(edited);
  await click("Back to editor");
  await act(async () => {
    await new Promise(requestAnimationFrame);
  });
  expect(host.querySelector(".markdown-preview-screen")).toBeNull();
  expect(editor()).toBe(view);
  expect(view.state.selection.main.head).toBe(7);
  expect(document.activeElement).toBe(view.contentDOM);
  await act(async () => {
    expect(undo(view)).toBe(true);
  });
  expect(view.state.doc.toString()).toBe(source);
});

it("switches between Markdown and novel previews without overlapping modes", async () => {
  await run("toggle-markdown-preview");
  await run("toggle-novel-proof");
  expect(host.querySelector(".markdown-preview-screen")).toBeNull();
  expect(host.querySelector(".novel-proof-screen")).not.toBeNull();
  expect(
    native.commands.find((command) => command.id === "toggle-markdown-preview")
      ?.checked,
  ).toBe(false);
  expect(
    native.commands.find((command) => command.id === "toggle-novel-proof")
      ?.checked,
  ).toBe(true);
  await run("toggle-markdown-preview");
  expect(host.querySelector(".novel-proof-screen")).toBeNull();
  expect(host.querySelector(".markdown-preview-screen")).not.toBeNull();
  await run("toggle-markdown-preview");
  expect(host.querySelector(".proof-hidden")).toBeNull();
});

it("refreshes Markdown preview when loading another file or receiving disk changes", async () => {
  await run("toggle-markdown-preview");
  vi.mocked(openDialog).mockResolvedValue("/novel/next.md");
  vi.mocked(api.readDocument).mockResolvedValue(
    "New file\nwith soft wrapping.",
  );
  await run("open");
  expect(host.querySelector(".markdown-preview-screen")?.textContent).toContain(
    "New file\nwith soft wrapping.",
  );
  vi.mocked(api.readDocument).mockResolvedValue("Updated on disk.");
  await act(async () => {
    vi.mocked(watch).mock.calls.at(-1)![1]({} as never);
  });
  expect(host.querySelector(".markdown-preview-screen")?.textContent).toContain(
    "Updated on disk.",
  );
  expect(host.querySelector(".proof-hidden")).not.toBeNull();
});

it("disables note edits in preview and returns to the editor when navigating to a note", async () => {
  await run("panel-notes");
  await run("toggle-markdown-preview");
  const dismiss = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Dismiss",
  )!;
  expect(dismiss.disabled).toBe(true);
  await act(async () =>
    (host.querySelector(".note-list li") as HTMLElement).click(),
  );
  expect(host.querySelector(".proof-hidden")).toBeNull();
  expect(dismiss.disabled).toBe(false);
});

it.each(["toggle-markdown-preview", "toggle-novel-proof", null])(
  "only applies a delayed note draft while editing (preview: %s)",
  async (preview) => {
    const source = editor().state.doc.toString();
    let finish!: (pairs: api.EditPair[]) => void;
    vi.mocked(api.draftNoteEdits).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await run("panel-notes");
    await click("Draft edits");
    expect(api.draftNoteEdits).toHaveBeenCalledOnce();
    if (preview) await run(preview);
    await act(async () => {
      finish([{ find: "First", replace: "Updated" }]);
    });
    if (preview) {
      expect(editor().state.doc.toString()).toBe(source);
      expect(host.querySelector(".status-toast")?.textContent).toContain(
        "read-only preview",
      );
    } else {
      expect(editor().state.doc.toString()).toBe(
        "{~~First~>Updated~~} {>>note<<}",
      );
    }
  },
);

it("opens preview web links externally without navigating away from the document", async () => {
  vi.mocked(api.readDocument).mockResolvedValue(
    "[Documentation](https://example.com/docs)",
  );
  await run("reload");
  await run("toggle-markdown-preview");
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  await act(async () => {
    host.querySelector(".markdown-preview-screen a")!.dispatchEvent(event);
  });
  expect(event.defaultPrevented).toBe(true);
  expect(openUrl).toHaveBeenCalledWith("https://example.com/docs");
  expect(editor().state.doc.toString()).toBe(
    "[Documentation](https://example.com/docs)",
  );
});

it("adapts a wrapped document and remembers the manual layout override across files", async () => {
  const doc = wrappedMarkdown();
  vi.mocked(api.readDocument).mockResolvedValue(doc);
  await run("reload");
  expect(editor().dom.classList.contains("cm-adaptive-layout")).toBe(true);
  expect(editor().state.readOnly).toBe(false);
  await run("toggle-adaptive-layout");
  expect(localStorage.getItem("liauth.adaptiveLayout")).toBe("0");
  expect(editor().dom.classList.contains("cm-adaptive-layout")).toBe(false);
  await run("reload");
  expect(editor().dom.classList.contains("cm-adaptive-layout")).toBe(false);
  expect(editor().state.doc.toString()).toBe(doc);
  await run("toggle-adaptive-layout");
  expect(editor().dom.classList.contains("cm-adaptive-layout")).toBe(true);
  vi.mocked(api.readDocument).mockResolvedValue("Normal prose.");
  await run("reload");
  expect(editor().dom.classList.contains("cm-adaptive-layout")).toBe(false);
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
  expectCounts(0, 0);
});

it("counts the newly opened chapter without requiring an edit", async () => {
  for (const words of [1984, 3852, 1390]) {
    const content = "word ".repeat(words).trim();
    vi.mocked(openDialog).mockResolvedValue(`/novel/chapter-${words}.md`);
    vi.mocked(api.readDocument).mockResolvedValue(content);
    await run("open");
    expect(editor().state.doc.toString()).toBe(content);
    expectCounts(words, content.length);
  }
});

it("refreshes counts when reloading the same file", async () => {
  const content = "One two three four";
  vi.mocked(api.readDocument).mockResolvedValue(content);
  await run("reload");
  expect(editor().state.doc.toString()).toBe(content);
  expectCounts(4, content.length);
});

it("refreshes counts after typing and during a pending update", async () => {
  expectCounts(2, "First {>>note<<}".length);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "New " } }),
  );
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expectCounts(3, "New First {>>note<<}".length);

  await act(async () =>
    editor().dispatch({ changes: { from: 0, insert: "Another " } }),
  );
  vi.mocked(openDialog).mockResolvedValue("/novel/next.md");
  vi.mocked(api.readDocument).mockResolvedValue("Next chapter has four");
  await run("open");
  expectCounts(4, "Next chapter has four".length);
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  expectCounts(4, "Next chapter has four".length);
});

it("counts a historical version and the current text when returning", async () => {
  const content = "Older text with five words";
  vi.mocked(api.fileAtCommit).mockResolvedValue(content);
  vi.mocked(api.historyDiff).mockResolvedValue([]);
  await run("panel-history");
  await act(async () =>
    (host.querySelector(".commit-list li") as HTMLElement).click(),
  );
  expect(editor().state.doc.toString()).toBe(content);
  expectCounts(5, content.length);
  await click("Back to current");
  expectCounts(2, "First {>>note<<}".length);
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
  await run("toggle-markdown-preview");
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
  expect(host.querySelector(".proof-hidden")).toBeNull();
});

it.each([false, true])(
  "watches a newly named folder-save document (commit fails: %s)",
  async (commitFails) => {
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
    if (commitFails)
      vi.mocked(api.saveFolder).mockRejectedValueOnce(
        new Error("index locked"),
      );
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
      false,
    );
    expect(
      vi.mocked(api.saveDocument).mock.calls.every((call) => call[3] === false),
    ).toBe(true);
    expect(api.saveFolder).toHaveBeenCalledWith("/novel");
    expect(editor().state.doc.toString()).toBe("New chapter");
    const newFileWatch = vi
      .mocked(watch)
      .mock.calls.find(([path]) => path === "/novel/new.md");
    expect(newFileWatch).toBeDefined();
    vi.mocked(api.readDocument).mockResolvedValue("Externally edited chapter");
    await act(async () => {
      newFileWatch![1]({} as never);
    });
    expect(editor().state.doc.toString()).toBe("Externally edited chapter");
    expectCounts(3, "Externally edited chapter".length);
  },
);

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
