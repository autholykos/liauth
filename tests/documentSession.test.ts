import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentSession } from "../src/documentSession";
import * as api from "../src/api";

vi.mock("../src/api", () => ({
  readDocument: vi.fn(),
  saveDocument: vi.fn(),
  saveFolder: vi.fn(),
  repoInfo: vi.fn(),
  fileHistory: vi.fn(),
  listBranches: vi.fn(),
  listWorktrees: vi.fn(),
  fileAtCommit: vi.fn(),
  historyDiff: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const info: api.RepoInfo = {
  repo_root: "/project",
  branch: "main",
  merging: false,
  file_dirty: false,
};
const commit: api.CommitInfo = {
  id: "1234567",
  summary: "Saved",
  author: "Writer",
  time: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.readDocument).mockResolvedValue("original");
  vi.mocked(api.saveDocument).mockResolvedValue(commit);
  vi.mocked(api.saveFolder).mockResolvedValue(commit);
  vi.mocked(api.repoInfo).mockResolvedValue(info);
  vi.mocked(api.fileHistory).mockResolvedValue([commit]);
  vi.mocked(api.listBranches).mockResolvedValue([]);
  vi.mocked(api.listWorktrees).mockResolvedValue([]);
});

describe("document lifetime", () => {
  it("shows the most recently requested historical version", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    const slow = deferred<string>();
    vi.mocked(api.fileAtCommit)
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce("newer selection");
    vi.mocked(api.historyDiff).mockResolvedValue([]);
    const first = session.viewVersion(commit, "original");
    await session.viewVersion({ ...commit, id: "second" }, "original");
    slow.resolve("older selection");
    expect(await first).toBeNull();
    expect(session.getSnapshot().viewing?.id).toBe("second");
  });
  it("keeps the newer document when two opens finish in reverse order", async () => {
    const session = new DocumentSession();
    const old = deferred<string>();
    vi.mocked(api.readDocument).mockReturnValueOnce(old.promise);
    const first = session.open("/first.md");
    await session.open("/second.md");
    old.resolve("first");
    expect(await first).toBeNull();
    expect(session.getSnapshot().filePath).toBe("/second.md");
  });

  it("does not discard typing while a document is being read", async () => {
    const session = new DocumentSession();
    const read = deferred<string>();
    vi.mocked(api.readDocument).mockReturnValueOnce(read.promise);
    const opening = session.open("/first.md");
    session.edit();
    read.resolve("first");
    expect(await opening).toBeNull();
    expect(session.getSnapshot()).toMatchObject({
      filePath: null,
      dirty: true,
      diskDirty: true,
    });
  });

  it("closes all document state together and disposes a late watcher", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    await session.refreshGit("/first.md");
    const snapshot = session.getSnapshot();
    const watcher = vi.fn();
    session.attachWatcher(snapshot, watcher);
    session.edit();
    session.setConflict("external");
    session.setViewing({
      ...commit,
      currentContent: "original",
      historicalContent: "old",
      hunks: [],
    });
    session.setLastSave("saved");
    session.close();
    const lateWatcher = vi.fn();
    session.attachWatcher(snapshot, lateWatcher);
    expect(watcher).toHaveBeenCalledOnce();
    expect(lateWatcher).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({
      filePath: null,
      lastDisk: "",
      dirty: false,
      diskDirty: false,
      extConflict: null,
      viewing: null,
      reinstating: null,
      versioning: null,
      lastSave: "",
    });
  });
});

describe("versioning", () => {
  it("publishes repository and lists atomically, preserving unsaved edits", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    const history = deferred<api.CommitInfo[]>();
    vi.mocked(api.fileHistory).mockReturnValueOnce(history.promise);
    const refresh = session.refreshGit("/first.md");
    await Promise.resolve();
    session.edit();
    expect(session.getSnapshot().versioning).toBeNull();
    const listener = vi.fn();
    session.subscribe(listener);
    history.resolve([commit]);
    await refresh;
    expect(listener).toHaveBeenCalledOnce();
    expect(session.getSnapshot().versioning).toEqual({
      repo: info,
      history: [commit],
      branches: [],
      worktrees: [],
    });
    expect(session.getSnapshot().dirty).toBe(true);
  });

  it("rejects an older refresh and one belonging to a previous document", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    const old = deferred<api.RepoInfo>();
    vi.mocked(api.repoInfo).mockReturnValueOnce(old.promise);
    const refresh = session.refreshGit("/first.md");
    await session.refreshGit("/first.md");
    old.resolve({ ...info, branch: "old" });
    await refresh;
    expect(session.getSnapshot().versioning?.repo.branch).toBe("main");
    const late = deferred<api.RepoInfo>();
    vi.mocked(api.repoInfo).mockReturnValueOnce(late.promise);
    const pending = session.refreshGit("/first.md");
    await session.open("/second.md");
    late.resolve(info);
    await pending;
    expect(session.getSnapshot().versioning).toBeNull();
  });

  it("does not restore a stale dirty flag after a commit completes", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    const old = deferred<api.RepoInfo>();
    vi.mocked(api.repoInfo).mockReturnValueOnce(old.promise);
    const refresh = session.refreshGit("/first.md");
    session.edit();
    await session.save("changed");
    old.resolve({ ...info, file_dirty: true });
    await refresh;
    expect(session.getSnapshot().dirty).toBe(false);
  });
});

describe("saving", () => {
  it("saves the current buffer before committing its folder and preserves typing during the commit", async () => {
    const session = new DocumentSession();
    await session.open("/project/part/chapter.md");
    session.edit();
    const slow = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveFolder).mockReturnValueOnce(slow.promise);
    const save = session.saveFolder("/project/part", "changed");
    await vi.waitFor(() =>
      expect(api.saveFolder).toHaveBeenCalledWith("/project/part"),
    );
    expect(api.saveDocument).toHaveBeenCalledWith(
      "/project/part/chapter.md",
      "changed",
      undefined,
      false,
    );
    session.edit();
    const next = session.save("newer typing", false);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    slow.resolve(commit);
    await save;
    await next;
    expect(session.getSnapshot()).toMatchObject({
      lastDisk: "newer typing",
      dirty: true,
      diskDirty: false,
    });
  });

  it("does not save a similarly prefixed sibling folder's buffer", async () => {
    const session = new DocumentSession();
    await session.open("/project/part-two/chapter.md");
    session.edit();
    await session.saveFolder("/project/part", "changed");
    expect(api.saveDocument).not.toHaveBeenCalled();
    expect(api.saveFolder).toHaveBeenCalledWith("/project/part");
    expect(session.getSnapshot().diskDirty).toBe(true);
  });

  it("blocks folder saves of historical text or a conflicted buffer", async () => {
    const session = new DocumentSession();
    await session.open("/project/chapter.md");
    session.setConflict("disk");
    await expect(session.saveFolder("/project", "mine")).rejects.toThrow(
      "disk conflict",
    );
    session.setConflict(null);
    session.setViewing({
      ...commit,
      currentContent: "current",
      historicalContent: "old",
      hunks: [],
    });
    await expect(session.saveFolder("/project", "old")).rejects.toThrow(
      "current document",
    );
    expect(api.saveDocument).not.toHaveBeenCalled();
    expect(api.saveFolder).not.toHaveBeenCalled();
  });

  it("keeps uncommitted changes when folder commit fails after writing the buffer", async () => {
    const session = new DocumentSession();
    await session.open("/project/chapter.md");
    session.edit();
    vi.mocked(api.saveFolder).mockRejectedValueOnce(new Error("index locked"));
    await expect(session.saveFolder("/project", "new text")).rejects.toThrow(
      "index locked",
    );
    expect(session.getSnapshot()).toMatchObject({
      lastDisk: "new text",
      diskDirty: false,
      dirty: true,
    });
  });
  it("autosaves the disk baseline without clearing uncommitted changes", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    session.edit();
    await session.save("changed", false);
    expect(api.saveDocument).toHaveBeenCalledWith(
      "/first.md",
      "changed",
      undefined,
      false,
    );
    expect(session.getSnapshot()).toMatchObject({
      lastDisk: "changed",
      dirty: true,
      diskDirty: false,
    });
    await session.save("changed");
    expect(session.getSnapshot().dirty).toBe(false);
  });

  it("keeps edits made during a save dirty and writes overlapping saves in order", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    session.edit();
    const slow = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveDocument).mockReturnValueOnce(slow.promise);
    const first = session.save("first", false);
    await Promise.resolve();
    session.edit();
    const second = session.save("second", false);
    expect(api.saveDocument).toHaveBeenCalledTimes(1);
    slow.resolve(null);
    await first;
    await second;
    expect(
      vi.mocked(api.saveDocument).mock.calls.map((call) => call[1]),
    ).toEqual(["first", "second"]);
    expect(session.getSnapshot()).toMatchObject({
      lastDisk: "second",
      dirty: true,
      diskDirty: false,
    });
  });

  it("does not mark newer typing clean after a commit", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    session.edit();
    const slow = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveDocument).mockReturnValueOnce(slow.promise);
    const saving = session.save("first");
    await Promise.resolve();
    session.edit();
    slow.resolve(commit);
    await saving;
    expect(session.getSnapshot()).toMatchObject({
      lastDisk: "first",
      dirty: true,
      diskDirty: true,
    });
  });

  it("ignores save completion after reopening even the same path", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    session.edit();
    const slow = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveDocument).mockReturnValueOnce(slow.promise);
    const saving = session.save("first");
    await Promise.resolve();
    await session.open("/first.md");
    const snapshot = session.getSnapshot();
    slow.resolve(commit);
    expect((await saving).current).toBe(false);
    expect(session.getSnapshot()).toBe(snapshot);
  });

  it("preserves newer edits when Save As adopts its destination", async () => {
    const session = new DocumentSession();
    session.edit();
    const slow = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveDocument).mockReturnValueOnce(slow.promise);
    const saving = session.save("first", true, undefined, "/new.md");
    await Promise.resolve();
    session.edit();
    slow.resolve(commit);
    await saving;
    expect(session.getSnapshot()).toMatchObject({
      filePath: "/new.md",
      lastDisk: "first",
      dirty: true,
      diskDirty: true,
    });
  });

  it("leaves a later conflict intact and recovers after a failed write", async () => {
    const session = new DocumentSession();
    await session.open("/first.md");
    session.edit();
    const failed = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveDocument).mockReturnValueOnce(failed.promise);
    const save = session.save("first");
    const failure = expect(save).rejects.toThrow("disk full");
    failed.reject(new Error("disk full"));
    await failure;
    expect(session.getSnapshot().diskDirty).toBe(true);
    const slow = deferred<api.CommitInfo | null>();
    vi.mocked(api.saveDocument).mockReturnValueOnce(slow.promise);
    const retry = session.save("first");
    await Promise.resolve();
    session.setConflict("external");
    slow.resolve(commit);
    await retry;
    expect(session.getSnapshot().extConflict).toBe("external");
  });
});
