import { Fragment } from "react";
import type { ProjectFile, ProjectFiles } from "./api";
import type { DocumentSnapshot } from "./documentSession";
import { folderHas, folderPath, groupFolders, type Folder } from "./folders";
import { baseName } from "./format";

interface NavigatorActions {
  toggleNavigatorFolder: (path: string) => void;
  openNavigatorFolderMenu: (path: string) => void;
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
  const files = (project?.files ?? []).map((file) =>
    file.path === filePath
      ? { ...file, dirty, has_notes: noteCount > 0 }
      : file,
  );
  const tree = groupFolders(files);
  const noteDot = (
    <span
      className="nav-note-dot"
      title="Contains unresolved notes"
      aria-label="Contains unresolved notes"
    />
  );

  const heading = (folder: Folder<ProjectFile>, root = false) => {
    const path = folderPath(project!.root, folder.rel);
    const collapsed = collapsedDirs.has(path);
    const isDirty = folderHas(folder, (file) => file.dirty);
    const hasNotes = folderHas(folder, (file) => file.has_notes);
    return (
      <button
        className={`nav-folder-toggle${isDirty ? " dirty" : ""}`}
        title={`${path}${isDirty ? " — uncommitted changes" : ""}${hasNotes ? " — unresolved notes" : ""}`}
        aria-expanded={!collapsed}
        onClick={() => actions.toggleNavigatorFolder(path)}
        onContextMenu={(event) => {
          event.preventDefault();
          actions.openNavigatorFolderMenu(path);
        }}
      >
        <span className="nav-dir-chevron" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        <span className="nav-file-name">
          {root ? project!.name : baseName(folder.rel)}
        </span>
        {hasNotes ? noteDot : null}
      </button>
    );
  };
  const entries = (
    folder: Folder<ProjectFile>,
    depth: number,
  ): React.ReactNode => {
    if (project && collapsedDirs.has(folderPath(project.root, folder.rel)))
      return null;
    return (
      <>
        {folder.files.map((file) => (
          <li
            key={file.path}
            className={[
              "nav-file",
              file.path === filePath ? "selected" : "",
              file.dirty ? "dirty" : "",
              fileClipboard?.mode === "cut" && fileClipboard.path === file.path
                ? "cut"
                : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ paddingLeft: 10 + depth * 12 }}
            title={`${file.rel}${file.dirty ? " — uncommitted changes" : ""}${file.has_notes ? " — unresolved notes" : ""}`}
            onClick={() => {
              if (file.path !== filePath) void actions.openPath(file.path);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              actions.openNavigatorFileMenu(file);
            }}
          >
            <span className="nav-file-name">{baseName(file.rel)}</span>
            {file.has_notes ? noteDot : null}
          </li>
        ))}
        {folder.folders.map((child) => (
          <Fragment key={child.rel}>
            <li className="nav-dir" style={{ paddingLeft: 4 + depth * 12 }}>
              {heading(child)}
            </li>
            {entries(child, depth + 1)}
          </Fragment>
        ))}
      </>
    );
  };
  return (
    <aside className="nav-panel">
      <h3 className="nav-root">{project ? heading(tree, true) : "Project"}</h3>
      {!filePath && !project ? (
        <p className="muted">Open a document to list its project.</p>
      ) : null}
      {project?.truncated ? (
        <p className="muted">Showing first 500 markdown files.</p>
      ) : null}
      <ul className="nav-list">{entries(tree, 0)}</ul>
    </aside>
  );
}
