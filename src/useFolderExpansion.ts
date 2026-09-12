import { useCallback, useEffect, useMemo } from "react";
import { normalizePath, isInFolder } from "./folders";
import { parentPath } from "./format";
import { usePersistedSetting } from "./usePersistedSetting";

function parseCollapsed(stored: string | null): string[] {
  try {
    const value = JSON.parse(stored ?? "[]");
    return Array.isArray(value)
      ? value.filter((path) => typeof path === "string")
      : [];
  } catch {
    return [];
  }
}

export function useFolderExpansion(
  root: string | undefined,
  filePath: string | null,
  visible = true,
) {
  const [paths, setPaths] = usePersistedSetting(
    "liauth.collapsedFolders",
    parseCollapsed,
    JSON.stringify,
  );
  const collapsed = useMemo(() => new Set(paths), [paths]);

  // Opening/revealing a document expands its ancestors without changing the
  // user's choices for other folders or other projects.
  useEffect(() => {
    if (!visible || !root || !filePath || !isInFolder(filePath, root)) return;
    const ancestors = new Set<string>([normalizePath(root)]);
    for (
      let dir = parentPath(normalizePath(filePath));
      dir && isInFolder(dir, root);
      dir = parentPath(dir)
    ) {
      ancestors.add(dir);
    }
    setPaths((current) =>
      current.some((path) => ancestors.has(path))
        ? current.filter((path) => !ancestors.has(path))
        : current,
    );
  }, [root, filePath, visible, setPaths]);

  const toggle = useCallback(
    (path: string) => {
      const folder = normalizePath(path);
      setPaths((current) =>
        current.includes(folder)
          ? current.filter((path) => path !== folder)
          : [...current, folder],
      );
    },
    [setPaths],
  );
  return [collapsed, toggle] as const;
}
