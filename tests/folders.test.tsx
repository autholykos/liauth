import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FileNavigator } from "../src/FileNavigator";
import { SearchResults } from "../src/SearchResults";
import { DocumentSession } from "../src/documentSession";
import { groupFolders } from "../src/folders";
import { useFolderExpansion } from "../src/useFolderExpansion";
import type { ProjectFiles } from "../src/api";

let host: HTMLDivElement;
let root: Root;
const project: ProjectFiles = {
  root: "/novel",
  name: "Novel",
  truncated: false,
  files: [
    {
      path: "/novel/part/deep/a.md",
      rel: "part/deep/a.md",
      dirty: true,
      has_notes: true,
    },
    {
      path: "/novel/other/b.md",
      rel: "other/b.md",
      dirty: false,
      has_notes: false,
    },
    { path: "/novel/home.md", rel: "home.md", dirty: false, has_notes: false },
  ],
};
const actions = {
  toggleNavigatorFolder: vi.fn(),
  openNavigatorFolderMenu: vi.fn(),
  openNavigatorFileMenu: vi.fn(),
  openPath: vi.fn().mockResolvedValue(true),
};
const folderButton = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>(".nav-folder-toggle")].find(
    (button) => button.querySelector(".nav-file-name")?.textContent === name,
  )!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("creates intermediate folders and aggregates descendant indicators even when collapsed", async () => {
  const tree = groupFolders(project.files);
  expect(tree.folders.map((folder) => folder.rel)).toEqual(["other", "part"]);
  expect(tree.folders[1].folders[0].rel).toBe("part/deep");
  await act(async () =>
    root.render(
      <FileNavigator
        project={project}
        document={new DocumentSession().getSnapshot()}
        noteCount={0}
        collapsedDirs={new Set(["/novel/part"])}
        fileClipboard={null}
        actions={actions}
      />,
    ),
  );
  expect(folderButton("part").getAttribute("aria-expanded")).toBe("false");
  expect(folderButton("part").classList.contains("dirty")).toBe(true);
  expect(folderButton("part").querySelector(".nav-note-dot")).not.toBeNull();
  expect(folderButton("Novel").querySelector(".nav-note-dot")).not.toBeNull();
  expect(folderButton("other").querySelector(".nav-note-dot")).toBeNull();
  expect(host.textContent).not.toContain("a.md");
  await act(async () =>
    folderButton("part").dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true }),
    ),
  );
  expect(actions.openNavigatorFolderMenu).toHaveBeenCalledWith("/novel/part");
});

it("uses the open buffer for folder status instead of stale disk flags", async () => {
  const document = {
    ...new DocumentSession().getSnapshot(),
    filePath: "/novel/part/deep/a.md",
    dirty: false,
  };
  await act(async () =>
    root.render(
      <FileNavigator
        project={project}
        document={document}
        noteCount={0}
        collapsedDirs={new Set()}
        fileClipboard={null}
        actions={actions}
      />,
    ),
  );
  expect(folderButton("part").classList.contains("dirty")).toBe(false);
  expect(folderButton("part").querySelector(".nav-note-dot")).toBeNull();
  await act(async () =>
    root.render(
      <FileNavigator
        project={project}
        document={{ ...document, dirty: true }}
        noteCount={1}
        collapsedDirs={new Set()}
        fileClipboard={null}
        actions={actions}
      />,
    ),
  );
  for (const name of ["part", "deep", "Novel"]) {
    expect(folderButton(name).classList.contains("dirty")).toBe(true);
    expect(folderButton(name).querySelector(".nav-note-dot")).not.toBeNull();
  }
});

function Navigator({
  filePath,
  rootPath = "/novel",
}: {
  filePath: string;
  rootPath?: string;
}) {
  const [collapsedDirs, toggleNavigatorFolder] = useFolderExpansion(
    rootPath,
    filePath,
  );
  return (
    <FileNavigator
      project={{ ...project, root: rootPath }}
      document={{ ...new DocumentSession().getSnapshot(), filePath }}
      noteCount={0}
      collapsedDirs={collapsedDirs}
      fileClipboard={null}
      actions={{ ...actions, toggleNavigatorFolder }}
    />
  );
}

it("remembers collapsed folders after remounting and reveals the active file's ancestors", async () => {
  await act(async () => root.render(<Navigator filePath="/novel/home.md" />));
  await act(async () => {
    folderButton("part").click();
    folderButton("other").click();
  });
  expect(JSON.parse(localStorage.getItem("liauth.collapsedFolders")!)).toEqual([
    "/novel/part",
    "/novel/other",
  ]);
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => root.render(<Navigator filePath="/novel/home.md" />));
  expect(folderButton("part").getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    root.render(<Navigator filePath="/novel/part/deep/a.md" />),
  );
  expect(folderButton("part").getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("a.md");
  expect(folderButton("other").getAttribute("aria-expanded")).toBe("false");
  await act(async () =>
    root.render(
      <Navigator filePath="/elsewhere/home.md" rootPath="/elsewhere" />,
    ),
  );
  expect(folderButton("other").getAttribute("aria-expanded")).toBe("true");
  await act(async () => root.render(<Navigator filePath="/novel/home.md" />));
  expect(folderButton("other").getAttribute("aria-expanded")).toBe("false");
});

it("expands persisted ancestors on startup and tolerates malformed preferences", async () => {
  localStorage.setItem(
    "liauth.collapsedFolders",
    JSON.stringify([
      "/novel",
      "/novel/part",
      "/novel/part/deep",
      "/novel/other",
    ]),
  );
  await act(async () =>
    root.render(<Navigator filePath="/novel/part/deep/a.md" />),
  );
  expect(host.textContent).toContain("a.md");
  expect(folderButton("other").getAttribute("aria-expanded")).toBe("false");
  await act(async () => root.unmount());
  root = createRoot(host);
  localStorage.setItem("liauth.collapsedFolders", "broken JSON");
  await act(async () => root.render(<Navigator filePath="/novel/home.md" />));
  expect(folderButton("part").getAttribute("aria-expanded")).toBe("true");
});

it("groups search matches by folder while keeping each match navigable", async () => {
  const matches = [
    {
      path: "/novel/part/a.md",
      rel: "part/a.md",
      line: 3,
      column: 5,
      length: 4,
      preview: "alpha",
    },
    {
      path: "/novel/home.md",
      rel: "home.md",
      line: 2,
      column: 0,
      length: 4,
      preview: "root",
    },
    {
      path: "/novel/part/b.md",
      rel: "part/b.md",
      line: 7,
      column: 1,
      length: 4,
      preview: "beta",
    },
    {
      path: "/novel/part/sub/c.md",
      rel: "part/sub/c.md",
      line: 1,
      column: 0,
      length: 4,
      preview: "child",
    },
  ];
  const open = vi.fn();
  await act(async () =>
    root.render(
      <SearchResults matches={matches} rootName="Novel" onOpen={open} />,
    ),
  );
  expect(
    [...host.querySelectorAll("section")].map((group) =>
      group.getAttribute("aria-label"),
    ),
  ).toEqual(["Novel", "part", "part/sub"]);
  expect(
    host
      .querySelector('section[aria-label="part"]')
      ?.querySelectorAll("button"),
  ).toHaveLength(2);
  await act(async () =>
    (
      host.querySelector('button[title="part/b.md:7"]') as HTMLButtonElement
    ).click(),
  );
  expect(open).toHaveBeenCalledWith(matches[2]);
});
