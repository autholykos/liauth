import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  repo_root: string | null;
  branch: string | null;
  merging: boolean;
  file_dirty: boolean;
}

export interface CommitInfo {
  id: string;
  summary: string;
  author: string;
  time: number; // unix seconds
}

export interface BranchInfo {
  name: string;
  is_head: boolean;
}

export interface MergeResult {
  status: "up_to_date" | "fast_forward" | "merged" | "conflicts";
  conflicts: string[];
}

/** Native print dialog; window.print() is a no-op in WKWebView. */
export const printPage = () => invoke<void>("print_page");

export const repoInfo = (filePath: string) =>
  invoke<RepoInfo>("repo_info", { filePath });

export const initRepo = (filePath: string) =>
  invoke<RepoInfo>("init_repo", { filePath });

export const readDocument = (filePath: string) =>
  invoke<string>("read_document", { filePath });

export const saveDocument = (
  filePath: string,
  content: string,
  message?: string,
  commit = true,
) =>
  invoke<CommitInfo | null>("save_document", {
    filePath,
    content,
    message: message ?? null,
    commit,
  });

export const fileHistory = (filePath: string, limit?: number) =>
  invoke<CommitInfo[]>("file_history", { filePath, limit: limit ?? null });

export const fileAtCommit = (filePath: string, commitId: string) =>
  invoke<string>("file_at_commit", { filePath, commitId });

export const listBranches = (filePath: string) =>
  invoke<BranchInfo[]>("list_branches", { filePath });

export const createBranch = (
  filePath: string,
  name: string,
  checkout: boolean,
) => invoke<void>("create_branch", { filePath, name, checkout });

export const checkoutBranch = (filePath: string, name: string) =>
  invoke<void>("checkout_branch", { filePath, name });

export const mergeBranch = (filePath: string, name: string) =>
  invoke<MergeResult>("merge_branch", { filePath, name });

export const abortMerge = (filePath: string) =>
  invoke<void>("abort_merge", { filePath });

export interface ContentMerge {
  content: string;
  conflicts: boolean;
}

export const mergeContents = (base: string, ours: string, theirs: string) =>
  invoke<ContentMerge>("merge_contents", { base, ours, theirs });

export interface VimConfig {
  path: string;
  content: string;
}

export const readVimConfig = () => invoke<VimConfig | null>("read_vim_config");

export const writeVimConfig = (content: string) =>
  invoke<VimConfig>("write_vim_config", { content });

export const takePendingOpen = () => invoke<string | null>("take_pending_open");

export interface EditPair {
  find: string;
  replace: string;
}

/** Ask the local model to turn one review note into find→replace edits.
 *  `repoRoot` locates the project's voice/style guide, when one exists. */
export const draftNoteEdits = (
  note: string,
  excerpt: string | null,
  document: string,
  repoRoot: string | null,
) =>
  invoke<EditPair[]>("draft_note_edits", { note, excerpt, document, repoRoot });

/** Fire-and-forget: pre-fill the model's KV cache with the voice guide and
 *  document so the first Draft edits call skips the multi-minute
 *  prompt-processing cost. */
export const warmNoteCache = (document: string, repoRoot: string | null) =>
  invoke<void>("warm_note_cache", { document, repoRoot });

export interface RephraseSkill {
  id: string;
  name: string;
  estimated_tokens: number;
  available: boolean;
  instructions: string;
}

export const listRephraseSkills = (repoRoot: string) =>
  invoke<RephraseSkill[]>("list_rephrase_skills", { repoRoot });

export const rephraseSelection = (
  selection: string,
  context: string,
  direction: string,
  synonymsOnly: boolean,
  repoRoot: string | null,
) =>
  invoke<string>("rephrase_selection", {
    selection,
    context,
    direction,
    synonymsOnly,
    repoRoot,
  });

export interface ProjectFile {
  path: string;
  rel: string;
  has_notes: boolean;
  dirty: boolean;
}

export interface ProjectFiles {
  root: string;
  name: string;
  files: ProjectFile[];
  truncated: boolean;
}

export const listProjectFiles = (filePath: string, showHidden: boolean) =>
  invoke<ProjectFiles | null>("list_project_files", { filePath, showHidden });

export const renameProjectFile = (filePath: string, newName: string) =>
  invoke<string>("rename_project_file", { filePath, newName });

export const pasteProjectFile = (
  filePath: string,
  destinationPath: string,
  cut: boolean,
) =>
  invoke<string>("paste_project_file", { filePath, destinationPath, cut });

export const deleteProjectFile = (filePath: string) =>
  invoke<void>("delete_project_file", { filePath });
