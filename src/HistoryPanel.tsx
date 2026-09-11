import type { CommitInfo } from "./api";
import type { DocumentSnapshot } from "./documentSession";
import { fmtTime } from "./format";

export function HistoryPanel({
  document,
  squashing,
  viewVersion,
  squashRecentCommits,
}: {
  document: DocumentSnapshot;
  squashing: boolean;
  viewVersion: (commit: CommitInfo) => Promise<void>;
  squashRecentCommits: (base?: string) => Promise<void>;
}) {
  const { viewing, reinstating } = document;
  const history = document.versioning?.history ?? [];
  return (
    <aside className="side-panel">
      <h3>History</h3>
      {history.length === 0 ? <p className="muted">No versions yet.</p> : null}
      <ul className="commit-list">
        {history.map((c) => (
          <li
            key={c.id}
            className={viewing?.id === c.id ? "selected" : ""}
            onClick={() => {
              if (reinstating === null) void viewVersion(c);
            }}
            aria-disabled={reinstating !== null}
          >
            <span className="commit-summary">{c.summary}</span>
            <span className="commit-meta">
              {c.author} · {fmtTime(c.time)} · {c.id.slice(0, 7)}
            </span>
            <button
              className="commit-squash"
              title="Squash every newer commit into one on top of this one; Toki writes the message"
              disabled={squashing || reinstating !== null}
              onClick={(e) => {
                e.stopPropagation();
                void squashRecentCommits(c.id);
              }}
            >
              Squash to here
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
