import { invoke } from "@tauri-apps/api/core";

export interface RepoInfo {
  repo_root: string | null;
  branch: string | null;
  merging: boolean;
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
) =>
  invoke<CommitInfo | null>("save_document", {
    filePath,
    content,
    message: message ?? null,
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

export interface VimConfig {
  path: string;
  content: string;
}

export const readVimConfig = () => invoke<VimConfig | null>("read_vim_config");
