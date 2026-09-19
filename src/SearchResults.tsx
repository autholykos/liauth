import { useId, type ReactNode } from "react";
import type { ProjectSearchMatch } from "./api";
import { groupFolders, type Folder } from "./folders";
import { baseName } from "./format";

function highlight(text: string, query: string): ReactNode {
  const asciiLower = (value: string) =>
    value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const needle = asciiLower(query.trim());
  if (!needle) return text;
  const searchable = asciiLower(text);
  const parts: ReactNode[] = [];
  let from = 0;
  for (
    let index = searchable.indexOf(needle);
    index !== -1;
    index = searchable.indexOf(needle, from)
  ) {
    parts.push(text.slice(from, index));
    parts.push(<mark key={index}>{text.slice(index, index + needle.length)}</mark>);
    from = index + needle.length;
  }
  parts.push(text.slice(from));
  return parts;
}

export function SearchResults({
  matches,
  rootName,
  query,
  expandedFiles,
  onToggleFile,
  onOpen,
}: {
  matches: ProjectSearchMatch[];
  rootName: string;
  query: string;
  expandedFiles: ReadonlySet<string>;
  onToggleFile: (path: string) => void;
  onOpen: (match: ProjectSearchMatch) => void;
}) {
  const id = useId();
  const render = (folder: Folder<ProjectSearchMatch>): ReactNode => {
    const files = new Map<string, ProjectSearchMatch[]>();
    for (const match of folder.files) {
      const occurrences = files.get(match.path);
      if (occurrences) occurrences.push(match);
      else files.set(match.path, [match]);
    }
    return (
      <div key={folder.rel}>
        {folder.files.length > 0 ? (
          <section
            className="nav-search-group"
            aria-label={folder.rel || rootName}
          >
            <h4 className="nav-search-folder" title={folder.rel || rootName}>
              {folder.rel || rootName}/{" "}
              <span className="muted">({folder.files.length})</span>
            </h4>
            <ul className="nav-search-files">
              {[...files].map(([path, occurrences]) => {
                const expanded = expandedFiles.has(path);
                const listId = `${id}-${encodeURIComponent(path)}`;
                return (
                  <li key={path}>
                    <button
                      className="nav-search-file"
                      title={occurrences[0].rel}
                      aria-expanded={expanded}
                      aria-controls={listId}
                      onClick={() => onToggleFile(path)}
                    >
                      <span className="nav-dir-chevron" aria-hidden="true">
                        {expanded ? "▾" : "▸"}
                      </span>
                      <span className="nav-file-name">
                        {baseName(occurrences[0].rel)}
                      </span>
                      <span className="muted">({occurrences.length})</span>
                    </button>
                    <ul
                      id={listId}
                      className="nav-search-results"
                      hidden={!expanded}
                    >
                      {expanded
                        ? occurrences.map((match) => (
                            <li key={`${match.line}:${match.column}`}>
                              <button
                                className="nav-search-result"
                                title={`${match.rel}:${match.line}`}
                                onClick={() => onOpen(match)}
                              >
                                <span className="nav-search-line">
                                  Line {match.line}
                                </span>
                                <span className="nav-search-preview">
                                  {highlight(match.preview, query)}
                                </span>
                              </button>
                            </li>
                          ))
                        : null}
                    </ul>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        {folder.folders.map(render)}
      </div>
    );
  };
  return render(groupFolders(matches));
}
