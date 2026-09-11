import * as api from "./api";

export type ViewedVersion = api.CommitInfo & {
  currentContent: string;
  historicalContent: string;
  hunks: api.HistoryHunk[];
};
export interface Versioning {
  repo: api.RepoInfo;
  history: api.CommitInfo[];
  branches: api.BranchInfo[];
  worktrees: api.WorktreeInfo[];
}

const emptyDocument = () => ({
  filePath: null as string | null,
  lastDisk: "",
  dirty: false,
  diskDirty: false,
  extConflict: null as string | null,
  viewing: null as ViewedVersion | null,
  reinstating: null as number | null,
  versioning: null as Versioning | null,
  lastSave: "",
});
export type DocumentSnapshot = Readonly<
  ReturnType<typeof emptyDocument> & { id: number; revision: number }
>;

/** Live document state for async callbacks; React subscribes to the same value. */
export class DocumentSession {
  private state: DocumentSnapshot = { ...emptyDocument(), id: 0, revision: 0 };
  private listeners = new Set<() => void>();
  private openRequest = 0;
  private gitRequest = 0;
  private historyRequest = 0;
  private unwatch: (() => void) | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<DocumentSnapshot>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  sameDocument(snapshot: DocumentSnapshot): boolean {
    return (
      snapshot.id === this.state.id && snapshot.filePath === this.state.filePath
    );
  }
  isCurrent(snapshot: DocumentSnapshot): boolean {
    return (
      this.sameDocument(snapshot) &&
      snapshot.revision === this.state.revision &&
      snapshot.lastDisk === this.state.lastDisk &&
      snapshot.extConflict === this.state.extConflict
    );
  }

  async open(path: string): Promise<string | null> {
    const request = ++this.openRequest;
    const previous = this.state;
    const content = await api.readDocument(path);
    if (request !== this.openRequest || !this.isCurrent(previous)) return null;
    this.stopWatching();
    this.update({
      ...emptyDocument(),
      id: previous.id + 1,
      revision: 0,
      filePath: path,
      lastDisk: content,
    });
    return content;
  }
  close = () => {
    ++this.openRequest;
    this.stopWatching();
    this.update({ ...emptyDocument(), id: this.state.id + 1, revision: 0 });
  };
  edit = () => {
    this.update({
      dirty: true,
      diskDirty: true,
      revision: this.state.revision + 1,
    });
  };
  setViewing = (viewing: ViewedVersion | null) => {
    this.update({ viewing, revision: this.state.revision + 1 });
  };
  setReinstating = (reinstating: number | null) => {
    this.update({ reinstating });
  };
  setConflict = (extConflict: string | null) => {
    this.update({ extConflict });
  };
  setLastSave = (lastSave: string) => {
    this.update({ lastSave });
  };

  /** A completed write establishes the disk baseline even if typing continued.
   * Only the captured revision can become clean. Autosave never clears dirty. */
  private saved(
    snapshot: DocumentSnapshot,
    content: string,
    committed: boolean,
    path: string,
  ): void {
    const unchanged = snapshot.revision === this.state.revision;
    const extConflict =
      this.state.extConflict === snapshot.extConflict
        ? null
        : this.state.extConflict;
    ++this.gitRequest;
    this.update({
      filePath: path,
      versioning: path === snapshot.filePath ? this.state.versioning : null,
      lastDisk: content,
      diskDirty: !unchanged || extConflict !== null,
      dirty:
        unchanged && committed && extConflict === null
          ? false
          : this.state.dirty,
      extConflict,
    });
  }
  async save(
    content: string,
    commit = true,
    message?: string,
    path = this.state.filePath,
  ) {
    if (!path) throw new Error("Save requires a file name");
    const snapshot = this.state;
    // Blur, Vim and manual saves can overlap. Preserve their invocation order.
    const write = this.writes.then(() => {
      if (!this.sameDocument(snapshot))
        throw new Error("Document changed before saving");
      return api.saveDocument(path, content, message, commit);
    });
    this.writes = write.catch(() => {});
    const result = await write;
    if (!this.sameDocument(snapshot)) return { commit: result, current: false };
    if (path !== snapshot.filePath) {
      this.stopWatching();
    }
    this.saved(snapshot, content, commit, path);
    return { commit: result, current: true };
  }
  acceptDisk(content: string) {
    this.update({
      lastDisk: content,
      diskDirty: false,
      revision: this.state.revision + 1,
    });
  }
  mergeDisk(content: string) {
    this.update({
      lastDisk: content,
      extConflict: null,
      dirty: true,
      diskDirty: true,
      revision: this.state.revision + 1,
    });
  }

  async viewVersion(
    commit: api.CommitInfo,
    content: string,
  ): Promise<ViewedVersion | null> {
    const snapshot = this.state;
    if (!snapshot.filePath) return null;
    const request = ++this.historyRequest;
    const currentContent = snapshot.viewing?.currentContent ?? content;
    const historicalContent = await api.fileAtCommit(
      snapshot.filePath,
      commit.id,
    );
    const hunks = await api.historyDiff(currentContent, historicalContent);
    if (request !== this.historyRequest || !this.isCurrent(snapshot))
      return null;
    const selected = { ...commit, currentContent, historicalContent, hunks };
    this.setViewing(selected);
    return selected;
  }

  /** Publish repo and lists together; an older refresh cannot replace a newer one. */
  async refreshGit(path: string): Promise<api.RepoInfo> {
    const snapshot = this.state;
    const request = ++this.gitRequest;
    const repo = await api.repoInfo(path);
    let versioning: Versioning | null = null;
    if (repo.repo_root) {
      const [history, branches, worktrees] = await Promise.all([
        api.fileHistory(path),
        api.listBranches(path),
        api.listWorktrees(path),
      ]);
      versioning = { repo, history, branches, worktrees };
    }
    if (
      request === this.gitRequest &&
      this.sameDocument(snapshot) &&
      path === this.state.filePath
    ) {
      this.update({
        versioning,
        dirty: this.state.diskDirty || repo.file_dirty,
      });
    }
    return repo;
  }

  hasWatcher() {
    return this.unwatch !== null;
  }
  attachWatcher(snapshot: DocumentSnapshot, unwatch: () => void) {
    if (!this.sameDocument(snapshot)) {
      unwatch();
      return;
    }
    this.stopWatching();
    this.unwatch = unwatch;
  }
  stopWatching = () => {
    this.unwatch?.();
    this.unwatch = null;
  };
}
