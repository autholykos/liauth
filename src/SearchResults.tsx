import type { ProjectSearchMatch } from "./api";
import { groupFolders, type Folder } from "./folders";
import { baseName } from "./format";

export function SearchResults({
  matches,
  rootName,
  onOpen,
}: {
  matches: ProjectSearchMatch[];
  rootName: string;
  onOpen: (match: ProjectSearchMatch) => void;
}) {
  const render = (folder: Folder<ProjectSearchMatch>): React.ReactNode => (
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
          <ul className="nav-search-results">
            {folder.files.map((match) => (
              <li key={`${match.path}:${match.line}:${match.column}`}>
                <button
                  className="nav-search-result"
                  title={`${match.rel}:${match.line}`}
                  onClick={() => onOpen(match)}
                >
                  <span className="nav-search-path">
                    {baseName(match.rel)}:{match.line}
                  </span>
                  <span className="nav-search-preview">{match.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {folder.folders.map(render)}
    </div>
  );
  return render(groupFolders(matches));
}
