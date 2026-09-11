import { Fragment } from "react";
import type { ProjectFile, ProjectFiles } from "./api";
import type { DocumentSnapshot } from "./documentSession";

interface NavigatorActions {
  toggleNavigatorFolder: (dir: string) => void;
  openNavigatorFolderMenu: (dir: string, destination: ProjectFile) => void;
  openNavigatorFileMenu: (file: ProjectFile) => void;
  openPath: (path: string) => Promise<boolean>;
}

export function FileNavigator({
  project,
  document,
  noteCount,
  collapsedDirs,
  fileClipboard,
  actions,
}: {
  project: ProjectFiles | null;
  document: DocumentSnapshot;
  noteCount: number;
  collapsedDirs: Set<string>;
  fileClipboard: { path: string; mode: "cut" | "copy" } | null;
  actions: NavigatorActions;
}) {
  const { filePath, dirty } = document;
  const {
    toggleNavigatorFolder,
    openNavigatorFolderMenu,
    openNavigatorFileMenu,
    openPath,
  } = actions;
  return (
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
          const rel = f.rel.replace(/\\/g, "/");
          const cut = rel.lastIndexOf("/");
          const dir = cut >= 0 ? rel.slice(0, cut) : "";
          const name = cut >= 0 ? rel.slice(cut + 1) : rel;
          const prev = i > 0 ? all[i - 1].rel.replace(/\\/g, "/") : "";
          const prevCut = prev.lastIndexOf("/");
          const prevDir = prevCut >= 0 ? prev.slice(0, prevCut) : "";
          const hiddenByCollapsedParent = [...collapsedDirs].some((parent) =>
            dir.startsWith(`${parent}/`),
          );
          if (hiddenByCollapsedParent) return null;
          const collapsed = collapsedDirs.has(dir);
          const hasNotes = f.path === filePath ? noteCount > 0 : f.has_notes;
          const isDirty = f.path === filePath ? dirty : f.dirty;
          const cls = [
            "nav-file",
            f.path === filePath ? "selected" : "",
            isDirty ? "dirty" : "",
            dir ? "nested" : "",
            fileClipboard?.mode === "cut" && fileClipboard.path === f.path
              ? "cut"
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <Fragment key={f.path}>
              {dir && dir !== prevDir ? (
                <li
                  className="nav-dir"
                  title={`${collapsed ? "Expand" : "Collapse"} ${dir}`}
                  aria-expanded={!collapsed}
                  onClick={() => toggleNavigatorFolder(dir)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openNavigatorFolderMenu(dir, f);
                  }}
                >
                  <span className="nav-dir-chevron" aria-hidden="true">
                    {collapsed ? "▸" : "▾"}
                  </span>
                  {dir}/
                </li>
              ) : null}
              {!collapsed ? (
                <li
                  className={cls}
                  title={`${f.rel}${isDirty ? " — uncommitted changes" : ""}${hasNotes ? " — unresolved notes" : ""}`}
                  onClick={() => {
                    if (f.path !== filePath) void openPath(f.path);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    openNavigatorFileMenu(f);
                  }}
                >
                  <span className="nav-file-name">{name}</span>
                  {hasNotes ? (
                    <span
                      className="nav-note-dot"
                      title="Contains unresolved notes"
                      aria-label="Contains unresolved notes"
                    />
                  ) : null}
                </li>
              ) : null}
            </Fragment>
          );
        })}
      </ul>
    </aside>
  );
}
