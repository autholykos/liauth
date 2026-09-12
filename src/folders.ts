export const normalizePath = (path: string) =>
  path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";

export function folderPath(root: string, relative: string): string {
  const base = normalizePath(root);
  return normalizePath(`${base}${base === "/" ? "" : "/"}${relative}`);
}

export function isInFolder(path: string, folder: string): boolean {
  const parent = normalizePath(folder);
  const child = normalizePath(path);
  return (
    child === parent || child.startsWith(parent === "/" ? parent : `${parent}/`)
  );
}

export interface Folder<T> {
  rel: string;
  files: T[];
  folders: Folder<T>[];
}

/** Include intermediate folders even when only their descendants have files. */
export function groupFolders<T extends { rel: string }>(
  files: readonly T[],
): Folder<T> {
  const root: Folder<T> = { rel: "", files: [], folders: [] };
  const folders = new Map([["", root]]);
  for (const file of files) {
    const parts = file.rel.replace(/\\/g, "/").split("/");
    parts.pop();
    let parent = root;
    let rel = "";
    for (const part of parts) {
      rel = rel ? `${rel}/${part}` : part;
      let folder = folders.get(rel);
      if (!folder) {
        folder = { rel, files: [], folders: [] };
        folders.set(rel, folder);
        parent.folders.push(folder);
      }
      parent = folder;
    }
    parent.files.push(file);
  }
  for (const folder of folders.values()) {
    folder.folders.sort((a, b) => a.rel.localeCompare(b.rel));
    folder.files.sort((a, b) => a.rel.localeCompare(b.rel));
  }
  return root;
}

export function folderHas<T>(
  folder: Folder<T>,
  predicate: (file: T) => boolean,
): boolean {
  return (
    folder.files.some(predicate) ||
    folder.folders.some((child) => folderHas(child, predicate))
  );
}
