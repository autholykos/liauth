import type { Versioning } from "./documentSession";
import { baseName, fmtAgo } from "./format";

interface BranchActions {
  newReviewBranch: () => Promise<void>;
  doMerge: (name: string) => Promise<void>;
  openInWorktree: (path: string) => Promise<void>;
  deleteBranch: (name: string, worktree?: string | null) => Promise<void>;
  switchBranch: (name: string) => Promise<void>;
}

export function BranchesPanel({
  versioning,
  actions,
}: {
  versioning: Versioning;
  actions: BranchActions;
}) {
  const { repo, branches, worktrees } = versioning;
  const currentWorktree = worktrees.find((w) => w.is_current);
  const {
    newReviewBranch,
    doMerge,
    openInWorktree,
    deleteBranch,
    switchBranch,
  } = actions;
  return (
    <aside className="side-panel">
      <h3>Branches</h3>
      <p className="muted">
        On <strong>{repo?.branch}</strong>
        {currentWorktree && !currentWorktree.is_main
          ? ` in worktree ${currentWorktree.name}`
          : ""}
      </p>
      <button className="wide" onClick={() => void newReviewBranch()}>
        New branch…
      </button>
      <ul className="branch-list">
        {branches.map((b) => (
          <li key={b.name} className={b.is_head ? "selected" : ""}>
            <span className="branch-name">
              ⎇ {b.name}
              {b.is_head ? " (current)" : ""}
              <span className="muted">
                {" "}
                · {fmtAgo(b.last_commit_time)}
                {b.checked_out_in ? ` · in ${baseName(b.checked_out_in)}` : ""}
              </span>
            </span>
            {b.is_head ? null : b.checked_out_in ? (
              <span className="branch-actions">
                <button onClick={() => void doMerge(b.name)}>Merge in</button>
                <button onClick={() => void openInWorktree(b.checked_out_in!)}>
                  Open there
                </button>
                <button
                  title="Delete branch and its worktree"
                  onClick={() => void deleteBranch(b.name, b.checked_out_in)}
                >
                  ×
                </button>
              </span>
            ) : (
              <span className="branch-actions">
                <button onClick={() => void switchBranch(b.name)}>
                  Switch
                </button>
                <button onClick={() => void doMerge(b.name)}>Merge in</button>
                <button
                  title="Delete branch"
                  onClick={() => void deleteBranch(b.name)}
                >
                  ×
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {worktrees.length > 1 ? (
        <>
          <h3>Worktrees</h3>
          <ul className="branch-list">
            {worktrees.map((w) => (
              <li key={w.path} className={w.is_current ? "selected" : ""}>
                <span className="branch-name">
                  {w.name}
                  {w.branch ? ` · ${w.branch}` : ""}
                  {w.is_current ? " (this one)" : ""}
                </span>
                {w.is_current ? null : (
                  <span className="branch-actions">
                    <button onClick={() => void openInWorktree(w.path)}>
                      Open here
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}
