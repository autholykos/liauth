use git2::{
    BranchType, Commit, DiffFormat, ErrorCode, MergeOptions, Oid, Repository, RepositoryState,
    Signature, Status, StatusOptions,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct RepoInfo {
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub merging: bool,
    pub file_dirty: bool,
}

#[derive(Serialize)]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    /// Unix timestamp in seconds.
    pub time: i64,
}

#[derive(Serialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
}

#[derive(Serialize)]
pub struct MergeResult {
    pub status: String, // "up_to_date" | "fast_forward" | "merged" | "conflicts"
    pub conflicts: Vec<String>,
}

#[derive(Serialize)]
pub struct HistoryHunk {
    pub index: usize,
    pub current: String,
    pub historical_start: usize,
    pub historical_lines: usize,
}

pub struct SquashPlan {
    pub branch: String,
    pub head: Oid,
    pub base: Oid,
    pub summaries: Vec<String>,
    pub diff: String,
}

fn err(e: git2::Error) -> String {
    e.message().to_string()
}

fn discover(file_path: &str) -> Result<Repository, String> {
    let dir = Path::new(file_path)
        .parent()
        .ok_or_else(|| "file has no parent directory".to_string())?;
    Repository::discover(dir).map_err(err)
}

fn workdir_rel(repo: &Repository, file_path: &str) -> Result<PathBuf, String> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| "repository has no working directory".to_string())?;
    // Canonicalize both sides: on macOS /var vs /private/var (and any other
    // symlinked path) would otherwise defeat strip_prefix.
    let workdir = fs::canonicalize(workdir).map_err(|e| e.to_string())?;
    let file = fs::canonicalize(file_path).map_err(|e| e.to_string())?;
    file.strip_prefix(&workdir)
        .map(|p| p.to_path_buf())
        .map_err(|_| "file is outside the repository".to_string())
}

fn signature(repo: &Repository) -> Result<Signature<'static>, String> {
    repo.signature()
        .or_else(|_| Signature::now("Liauth", "liauth@local"))
        .map_err(err)
}

fn head_commit(repo: &Repository) -> Result<Option<Commit<'_>>, String> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_commit().map_err(err)?)),
        Err(e) if e.code() == ErrorCode::UnbornBranch || e.code() == ErrorCode::NotFound => {
            Ok(None)
        }
        Err(e) => Err(err(e)),
    }
}

fn info(repo: &Repository) -> RepoInfo {
    let branch = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_string));
    RepoInfo {
        repo_root: repo.workdir().map(|p| p.display().to_string()),
        branch,
        merging: repo.state() == RepositoryState::Merge,
        file_dirty: false,
    }
}

fn info_for_file(repo: &Repository, file_path: &str) -> RepoInfo {
    let file_dirty = workdir_rel(repo, file_path)
        .ok()
        .and_then(|rel| repo.status_file(&rel).ok())
        .is_some_and(|s| s != Status::CURRENT);
    RepoInfo {
        file_dirty,
        ..info(repo)
    }
}

#[tauri::command]
pub fn repo_info(file_path: String) -> RepoInfo {
    match discover(&file_path) {
        Ok(repo) => info_for_file(&repo, &file_path),
        Err(_) => RepoInfo {
            repo_root: None,
            branch: None,
            merging: false,
            file_dirty: false,
        },
    }
}

#[tauri::command]
pub fn init_repo(file_path: String) -> Result<RepoInfo, String> {
    let dir = Path::new(&file_path)
        .parent()
        .ok_or_else(|| "file has no parent directory".to_string())?;
    let repo = Repository::init(dir).map_err(err)?;
    Ok(info(&repo))
}

#[tauri::command]
pub fn read_document(file_path: String) -> Result<String, String> {
    fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

/// Write the file and, when `commit` is set and it lives in a repository,
/// stage and commit it. While a merge is in progress, the commit gets both
/// parents and concludes the merge. Autosave passes `commit: false`: a
/// plain disk write that can never touch git state (and so can never
/// conclude a merge accidentally).
#[tauri::command]
pub fn save_document(
    file_path: String,
    content: String,
    message: Option<String>,
    commit: bool,
) -> Result<Option<CommitInfo>, String> {
    fs::write(&file_path, &content).map_err(|e| e.to_string())?;
    if !commit {
        return Ok(None);
    }

    let mut repo = match discover(&file_path) {
        Ok(r) => r,
        Err(_) => return Ok(None), // not versioned: plain save
    };
    let rel = workdir_rel(&repo, &file_path)?;

    let merging = repo.state() == RepositoryState::Merge;
    let mut merge_heads: Vec<Oid> = Vec::new();
    if merging {
        repo.mergehead_foreach(|oid| {
            merge_heads.push(*oid);
            true
        })
        .map_err(err)?;
    }

    let mut index = repo.index().map_err(err)?;
    index.add_path(&rel).map_err(err)?;
    index.write().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;

    let sig = signature(&repo)?;
    let default_msg = format!(
        "Save {}",
        rel.file_name()
            .map(|n| n.to_string_lossy())
            .unwrap_or_default()
    );
    let msg = message.unwrap_or(default_msg);

    let oid = {
        let tree = repo.find_tree(tree_id).map_err(err)?;
        let parent = head_commit(&repo)?;

        // Skip empty commits outside of a merge.
        if !merging {
            if let Some(ref p) = parent {
                if p.tree_id() == tree_id {
                    return Ok(None);
                }
            }
        }

        let mut parents: Vec<Commit> = parent.into_iter().collect();
        for head in &merge_heads {
            parents.push(repo.find_commit(*head).map_err(err)?);
        }
        let parent_refs: Vec<&Commit> = parents.iter().collect();

        repo.commit(Some("HEAD"), &sig, &sig, &msg, &tree, &parent_refs)
            .map_err(err)?
    };
    if merging {
        repo.cleanup_state().map_err(err)?;
    }

    Ok(Some(CommitInfo {
        id: oid.to_string(),
        summary: msg.lines().next().unwrap_or("").to_string(),
        author: sig.name().unwrap_or("").to_string(),
        time: sig.when().seconds(),
    }))
}

/// Commits that changed this file, newest first.
#[tauri::command]
pub fn file_history(file_path: String, limit: Option<usize>) -> Result<Vec<CommitInfo>, String> {
    let repo = discover(&file_path)?;
    let rel = workdir_rel(&repo, &file_path)?;
    let limit = limit.unwrap_or(200);

    if head_commit(&repo)?.is_none() {
        return Ok(vec![]);
    }

    let mut walk = repo.revwalk().map_err(err)?;
    walk.push_head().map_err(err)?;
    walk.set_sorting(git2::Sort::TIME).map_err(err)?;

    let blob_at = |commit: &Commit| -> Option<Oid> {
        commit
            .tree()
            .ok()
            .and_then(|t| t.get_path(&rel).ok())
            .map(|e| e.id())
    };

    let mut out = Vec::new();
    for oid in walk {
        let oid = oid.map_err(err)?;
        let commit = repo.find_commit(oid).map_err(err)?;
        let current = blob_at(&commit);
        if current.is_none() {
            continue;
        }
        let changed = if commit.parent_count() == 0 {
            true
        } else {
            (0..commit.parent_count()).all(|i| {
                commit
                    .parent(i)
                    .ok()
                    .as_ref()
                    .and_then(blob_at)
                    .map(|parent_blob| Some(parent_blob) != current)
                    .unwrap_or(true)
            })
        };
        if changed {
            out.push(CommitInfo {
                id: oid.to_string(),
                summary: commit.summary().ok().flatten().unwrap_or("").to_string(),
                author: commit.author().name().unwrap_or("").to_string(),
                time: commit.time().seconds(),
            });
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn file_at_commit(file_path: String, commit_id: String) -> Result<String, String> {
    let repo = discover(&file_path)?;
    let rel = workdir_rel(&repo, &file_path)?;
    let oid = Oid::from_str(&commit_id).map_err(err)?;
    let commit = repo.find_commit(oid).map_err(err)?;
    let tree = commit.tree().map_err(err)?;
    let entry = tree.get_path(&rel).map_err(err)?;
    let blob = repo.find_blob(entry.id()).map_err(err)?;
    String::from_utf8(blob.content().to_vec()).map_err(|_| "file is not valid UTF-8".to_string())
}

fn history_patch<'a>(current: &'a str, historical: &'a str) -> diffy::Patch<'a, str> {
    let mut options = diffy::DiffOptions::new();
    options.set_context_len(0);
    options.create_patch(current, historical)
}

fn history_hunk_text(hunk: &diffy::Hunk<'_, str>) -> (String, String) {
    let mut current = String::new();
    let mut historical = String::new();
    for line in hunk.lines() {
        match line {
            diffy::Line::Context(text) => {
                current.push_str(text);
                historical.push_str(text);
            }
            diffy::Line::Delete(text) => current.push_str(text),
            diffy::Line::Insert(text) => historical.push_str(text),
        }
    }
    (current, historical)
}

#[tauri::command]
pub fn history_diff(current: String, historical: String) -> Vec<HistoryHunk> {
    history_patch(&current, &historical)
        .hunks()
        .iter()
        .enumerate()
        .map(|(index, hunk)| {
            let (current, _) = history_hunk_text(hunk);
            let range = hunk.new_range();
            HistoryHunk {
                index,
                current,
                historical_start: range.start(),
                historical_lines: range.len(),
            }
        })
        .collect()
}

#[tauri::command]
pub fn reinstate_history_hunk(
    current: String,
    historical: String,
    index: usize,
) -> Result<String, String> {
    let patch = history_patch(&current, &historical);
    let hunk = patch
        .hunks()
        .get(index)
        .ok_or_else(|| "history change no longer exists".to_string())?;
    let (_, replacement) = history_hunk_text(hunk);
    let range = hunk.old_range();
    let mut starts = vec![0];
    starts.extend(current.match_indices('\n').map(|(offset, _)| offset + 1));
    let first_line = range.start().saturating_sub(1);
    let from = if range.is_empty() {
        starts.get(range.start()).copied().unwrap_or(current.len())
    } else {
        starts.get(first_line).copied().unwrap_or(current.len())
    };
    let to = if range.is_empty() {
        from
    } else {
        starts
            .get(first_line + range.len())
            .copied()
            .unwrap_or(current.len())
    };
    let mut result = current;
    result.replace_range(from..to, &replacement);
    Ok(result)
}

fn require_clean_repo(repo: &Repository) -> Result<(), String> {
    if repo.state() != RepositoryState::Clean {
        return Err("finish the current git operation before squashing".to_string());
    }
    let mut options = StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    if !repo.statuses(Some(&mut options)).map_err(err)?.is_empty() {
        return Err("commit or discard all changes before squashing".to_string());
    }
    Ok(())
}

fn first_parent_distance(repo: &Repository, head: Oid, candidate: Oid) -> Option<usize> {
    let mut oid = head;
    for distance in 0.. {
        if oid == candidate {
            return Some(distance);
        }
        let commit = repo.find_commit(oid).ok()?;
        if commit.parent_count() == 0 {
            return None;
        }
        oid = commit.parent_id(0).ok()?;
    }
    unreachable!()
}

fn squash_marker(branch: &str) -> String {
    format!("refs/liauth/last-squash/{branch}")
}

fn squash_backup(branch: &str) -> String {
    format!("refs/liauth/pre-squash/{branch}")
}

pub fn squash_plan(file_path: &str) -> Result<SquashPlan, String> {
    const MAX_DIFF_BYTES: usize = 64 * 1024;

    let repo = discover(file_path)?;
    require_clean_repo(&repo)?;
    let head_ref = repo.head().map_err(err)?;
    if !head_ref.is_branch() {
        return Err("squash requires a checked-out local branch".to_string());
    }
    let branch = head_ref.shorthand().map_err(err)?.to_string();
    let head = head_ref
        .target()
        .ok_or_else(|| "current branch has no commit".to_string())?;

    let marker = repo
        .find_reference(&squash_marker(&branch))
        .ok()
        .and_then(|reference| reference.target());
    let upstream_base = repo
        .find_branch(&branch, BranchType::Local)
        .ok()
        .and_then(|local| local.upstream().ok())
        .and_then(|upstream| upstream.get().target())
        .and_then(|upstream| repo.merge_base(head, upstream).ok());
    let base = [marker, upstream_base]
        .into_iter()
        .flatten()
        .filter_map(|candidate| {
            first_parent_distance(&repo, head, candidate).map(|distance| (candidate, distance))
        })
        .min_by_key(|(_, distance)| *distance)
        .map(|(candidate, _)| candidate)
        .ok_or_else(|| {
            "no squash boundary found; configure and pull a tracking branch first".to_string()
        })?;

    let mut summaries = Vec::new();
    let mut oid = head;
    while oid != base {
        let commit = repo.find_commit(oid).map_err(err)?;
        if commit.parent_count() != 1 {
            return Err("cannot squash a range containing merge commits".to_string());
        }
        summaries.push(commit.summary().ok().flatten().unwrap_or("").to_string());
        oid = commit.parent_id(0).map_err(err)?;
    }
    summaries.reverse();
    if summaries.len() < 2 {
        return Err("fewer than two commits since the last squash or pull".to_string());
    }

    let base_tree = repo.find_commit(base).map_err(err)?.tree().map_err(err)?;
    let head_tree = repo.find_commit(head).map_err(err)?.tree().map_err(err)?;
    if base_tree.id() == head_tree.id() {
        return Err("the selected commits have no net changes".to_string());
    }
    let diff = repo
        .diff_tree_to_tree(Some(&base_tree), Some(&head_tree), None)
        .map_err(err)?;
    let mut bytes = Vec::new();
    let mut truncated = false;
    diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        let content = line.content();
        let prefix = matches!(origin, '+' | '-' | ' ').then_some(origin as u8);
        let needed = content.len() + usize::from(prefix.is_some());
        if bytes.len() + needed > MAX_DIFF_BYTES {
            truncated = true;
            return false;
        }
        if let Some(prefix) = prefix {
            bytes.push(prefix);
        }
        bytes.extend_from_slice(content);
        true
    })
    .map_err(err)?;
    let mut diff = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        diff.push_str("\n[diff truncated]\n");
    }

    Ok(SquashPlan {
        branch,
        head,
        base,
        summaries,
        diff,
    })
}

pub fn apply_squash(
    file_path: &str,
    plan: &SquashPlan,
    message: &str,
) -> Result<CommitInfo, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Toki returned an empty commit message".to_string());
    }
    if message.lines().next().unwrap_or("").chars().count() > 72 {
        return Err("Toki returned a commit subject longer than 72 characters".to_string());
    }
    let latest = squash_plan(file_path)?;
    if latest.branch != plan.branch || latest.head != plan.head || latest.base != plan.base {
        return Err("squash boundary changed while Toki was generating the message".to_string());
    }
    let repo = discover(file_path)?;
    require_clean_repo(&repo)?;
    let mut head_ref = repo.head().map_err(err)?;
    if head_ref.shorthand().map_err(err)? != plan.branch || head_ref.target() != Some(plan.head) {
        return Err("branch changed while Toki was generating the message".to_string());
    }

    let head = repo.find_commit(plan.head).map_err(err)?;
    let base = repo.find_commit(plan.base).map_err(err)?;
    let tree = head.tree().map_err(err)?;
    let sig = signature(&repo)?;
    let oid = repo
        .commit(None, &sig, &sig, message, &tree, &[&base])
        .map_err(err)?;
    repo.reference(
        &squash_backup(&plan.branch),
        plan.head,
        true,
        "liauth pre-squash checkpoint",
    )
    .map_err(err)?;
    repo.reference(
        &squash_marker(&plan.branch),
        oid,
        true,
        "liauth squash boundary",
    )
    .map_err(err)?;
    head_ref
        .set_target(oid, "liauth squash recent commits")
        .map_err(err)?;

    Ok(CommitInfo {
        id: oid.to_string(),
        summary: message.lines().next().unwrap_or("").to_string(),
        author: sig.name().unwrap_or("").to_string(),
        time: sig.when().seconds(),
    })
}

#[tauri::command]
pub fn list_branches(file_path: String) -> Result<Vec<BranchInfo>, String> {
    let repo = discover(&file_path)?;
    let mut out = Vec::new();
    for branch in repo.branches(Some(BranchType::Local)).map_err(err)? {
        let (branch, _) = branch.map_err(err)?;
        out.push(BranchInfo {
            name: branch.name().map_err(err)?.unwrap_or("").to_string(),
            is_head: branch.is_head(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn create_branch(file_path: String, name: String, checkout: bool) -> Result<(), String> {
    let repo = discover(&file_path)?;
    let head = head_commit(&repo)?.ok_or_else(|| "repository has no commits yet".to_string())?;
    repo.branch(&name, &head, false).map_err(err)?;
    if checkout {
        checkout_branch(file_path, name)?;
    }
    Ok(())
}

#[tauri::command]
pub fn checkout_branch(file_path: String, name: String) -> Result<(), String> {
    let repo = discover(&file_path)?;
    let refname = format!("refs/heads/{name}");
    let obj = repo.revparse_single(&refname).map_err(err)?;
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.safe();
    repo.checkout_tree(&obj, Some(&mut opts)).map_err(err)?;
    repo.set_head(&refname).map_err(err)?;
    Ok(())
}

/// Merge `name` into the current branch. On conflicts the working tree
/// gets standard conflict markers and the repo stays in the merge state;
/// the next `save_document` concludes it.
#[tauri::command]
pub fn merge_branch(file_path: String, name: String) -> Result<MergeResult, String> {
    let repo = discover(&file_path)?;
    let refname = format!("refs/heads/{name}");
    let their_ref = repo.find_reference(&refname).map_err(err)?;
    let annotated = repo
        .reference_to_annotated_commit(&their_ref)
        .map_err(err)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated]).map_err(err)?;

    if analysis.is_up_to_date() {
        return Ok(MergeResult {
            status: "up_to_date".into(),
            conflicts: vec![],
        });
    }

    if analysis.is_fast_forward() {
        let target = annotated.id();
        let mut head = repo.head().map_err(err)?;
        head.set_target(target, "fast-forward merge").map_err(err)?;
        let obj = repo.find_object(target, None).map_err(err)?;
        let mut opts = git2::build::CheckoutBuilder::new();
        opts.force();
        repo.checkout_tree(&obj, Some(&mut opts)).map_err(err)?;
        return Ok(MergeResult {
            status: "fast_forward".into(),
            conflicts: vec![],
        });
    }

    let mut merge_opts = MergeOptions::new();
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.allow_conflicts(true).conflict_style_merge(true);
    repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut checkout))
        .map_err(err)?;

    let index = repo.index().map_err(err)?;
    if index.has_conflicts() {
        let conflicts: Vec<String> = index
            .conflicts()
            .map_err(err)?
            .filter_map(|c| c.ok())
            .filter_map(|c| c.our.or(c.their).or(c.ancestor))
            .filter_map(|e| String::from_utf8(e.path).ok())
            .collect();
        return Ok(MergeResult {
            status: "conflicts".into(),
            conflicts,
        });
    }

    // Clean merge: commit it right away.
    let mut index = repo.index().map_err(err)?;
    let tree_id = index.write_tree().map_err(err)?;
    let tree = repo.find_tree(tree_id).map_err(err)?;
    let sig = signature(&repo)?;
    let head = head_commit(&repo)?.ok_or_else(|| "no HEAD commit".to_string())?;
    let theirs = repo.find_commit(annotated.id()).map_err(err)?;
    let branch_name = repo
        .head()
        .ok()
        .and_then(|h| h.shorthand().ok().map(str::to_string))
        .unwrap_or_else(|| "HEAD".into());
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        &format!("Merge '{name}' into {branch_name}"),
        &tree,
        &[&head, &theirs],
    )
    .map_err(err)?;
    repo.cleanup_state().map_err(err)?;
    Ok(MergeResult {
        status: "merged".into(),
        conflicts: vec![],
    })
}

#[derive(Serialize)]
pub struct ContentMerge {
    pub content: String,
    pub conflicts: bool,
}

/// Three-way merge of in-memory contents (diff3, the same algorithm git
/// uses). Used to reconcile the editor buffer with concurrent writes to
/// the file on disk: base = last content both sides derived from.
#[tauri::command]
pub fn merge_contents(base: String, ours: String, theirs: String) -> ContentMerge {
    match diffy::merge(&base, &ours, &theirs) {
        Ok(content) => ContentMerge {
            content,
            conflicts: false,
        },
        Err(content) => ContentMerge {
            content,
            conflicts: true,
        },
    }
}

/// Abort an in-progress merge and restore HEAD's version of the tree.
#[tauri::command]
pub fn abort_merge(file_path: String) -> Result<(), String> {
    let repo = discover(&file_path)?;
    let head = head_commit(&repo)?.ok_or_else(|| "no HEAD commit".to_string())?;
    let obj = head.as_object();
    let mut opts = git2::build::CheckoutBuilder::new();
    opts.force();
    repo.checkout_tree(obj, Some(&mut opts)).map_err(err)?;
    repo.cleanup_state().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(path: &std::path::Path) -> String {
        path.display().to_string()
    }

    /// Full document lifecycle: plain save, enable versioning, history,
    /// reviewer branch, conflicting edits, merge, resolve-by-saving.
    #[test]
    fn review_workflow_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);

        // Unversioned save: writes the file, no commit.
        let r = save_document(doc_s.clone(), "# Title\n\nv1 line\n".into(), None, true).unwrap();
        assert!(r.is_none());
        assert_eq!(
            read_document(doc_s.clone()).unwrap(),
            "# Title\n\nv1 line\n"
        );

        // Enable versioning.
        init_repo(doc_s.clone()).unwrap();
        let c1 = save_document(
            doc_s.clone(),
            "# Title\n\nv1 line\n".into(),
            Some("Initial version".into()),
            true,
        )
        .unwrap()
        .expect("first commit");
        assert_eq!(c1.summary, "Initial version");

        // Saving identical content must not create an empty commit.
        let r = save_document(doc_s.clone(), "# Title\n\nv1 line\n".into(), None, true).unwrap();
        assert!(r.is_none());

        // A real edit commits; history is newest-first.
        save_document(doc_s.clone(), "# Title\n\nv2 line\n".into(), None, true)
            .unwrap()
            .expect("second commit");
        let hist = file_history(doc_s.clone(), None).unwrap();
        assert_eq!(hist.len(), 2);
        assert_eq!(
            file_at_commit(doc_s.clone(), hist[1].id.clone()).unwrap(),
            "# Title\n\nv1 line\n"
        );

        let main_branch = repo_info(doc_s.clone()).branch.expect("branch name");

        // Reviewer edits on their own branch.
        create_branch(doc_s.clone(), "review/anna".into(), true).unwrap();
        save_document(
            doc_s.clone(),
            "# Title\n\nreviewer line\n".into(),
            Some("Review edits".into()),
            true,
        )
        .unwrap()
        .expect("review commit");

        // Author keeps working on the main branch — conflicting change.
        checkout_branch(doc_s.clone(), main_branch.clone()).unwrap();
        assert_eq!(
            read_document(doc_s.clone()).unwrap(),
            "# Title\n\nv2 line\n"
        );
        save_document(doc_s.clone(), "# Title\n\nauthor line\n".into(), None, true)
            .unwrap()
            .expect("author commit");

        // Merge the review branch: must conflict.
        let m = merge_branch(doc_s.clone(), "review/anna".into()).unwrap();
        assert_eq!(m.status, "conflicts");
        assert_eq!(m.conflicts, vec!["doc.md".to_string()]);
        let conflicted = read_document(doc_s.clone()).unwrap();
        assert!(
            conflicted.contains("<<<<<<<"),
            "conflict markers expected: {conflicted}"
        );
        assert!(repo_info(doc_s.clone()).merging);

        // Resolving = editing the markers away and saving.
        let merge_commit = save_document(
            doc_s.clone(),
            "# Title\n\nauthor and reviewer line\n".into(),
            Some("Merge review/anna".into()),
            true,
        )
        .unwrap()
        .expect("merge commit");
        assert!(!repo_info(doc_s.clone()).merging);

        let repo = Repository::discover(dir.path()).unwrap();
        let commit = repo
            .find_commit(Oid::from_str(&merge_commit.id).unwrap())
            .unwrap();
        assert_eq!(
            commit.parent_count(),
            2,
            "merge commit must have two parents"
        );

        // Fast-forward path: branch ahead, main untouched.
        create_branch(doc_s.clone(), "review/ben".into(), true).unwrap();
        save_document(
            doc_s.clone(),
            "# Title\n\nben's improvement\n".into(),
            None,
            true,
        )
        .unwrap()
        .expect("ben commit");
        checkout_branch(doc_s.clone(), main_branch).unwrap();
        let m = merge_branch(doc_s.clone(), "review/ben".into()).unwrap();
        assert_eq!(m.status, "fast_forward");
        assert_eq!(
            read_document(doc_s.clone()).unwrap(),
            "# Title\n\nben's improvement\n"
        );
    }

    /// abort_merge restores HEAD's tree and clears the merge state.
    #[test]
    fn abort_merge_restores_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);

        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s.clone(), "base\n".into(), None, true)
            .unwrap()
            .unwrap();
        let main_branch = repo_info(doc_s.clone()).branch.unwrap();

        create_branch(doc_s.clone(), "review/x".into(), true).unwrap();
        save_document(doc_s.clone(), "their change\n".into(), None, true)
            .unwrap()
            .unwrap();
        checkout_branch(doc_s.clone(), main_branch).unwrap();
        save_document(doc_s.clone(), "my change\n".into(), None, true)
            .unwrap()
            .unwrap();

        let m = merge_branch(doc_s.clone(), "review/x".into()).unwrap();
        assert_eq!(m.status, "conflicts");

        abort_merge(doc_s.clone()).unwrap();
        assert!(!repo_info(doc_s.clone()).merging);
        assert_eq!(read_document(doc_s.clone()).unwrap(), "my change\n");
    }

    /// commit: false writes the file but never touches git state.
    #[test]
    fn autosave_writes_without_committing() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);

        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s.clone(), "v1\n".into(), None, true)
            .unwrap()
            .unwrap();

        let r = save_document(doc_s.clone(), "autosaved\n".into(), None, false).unwrap();
        assert!(r.is_none());
        assert_eq!(read_document(doc_s.clone()).unwrap(), "autosaved\n");
        assert_eq!(file_history(doc_s.clone(), None).unwrap().len(), 1);
    }

    #[test]
    fn repo_info_reports_file_dirty() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);

        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s.clone(), "v1\n".into(), None, true)
            .unwrap()
            .unwrap();
        assert!(!repo_info(doc_s.clone()).file_dirty);

        save_document(doc_s.clone(), "autosaved\n".into(), None, false).unwrap();
        assert!(repo_info(doc_s.clone()).file_dirty);

        save_document(doc_s.clone(), "autosaved\n".into(), None, true)
            .unwrap()
            .unwrap();
        assert!(!repo_info(doc_s).file_dirty);
    }

    #[test]
    fn history_diff_reinstates_only_the_selected_change() {
        let current = "one\ncurrent alpha\nmiddle one\nmiddle two\ncurrent omega\nlast\n";
        let historical = "one\nhistorical alpha\nmiddle one\nmiddle two\nhistorical omega\nlast\n";
        let hunks = history_diff(current.into(), historical.into());
        assert_eq!(hunks.len(), 2);
        assert_eq!(hunks[0].current, "current alpha\n");
        assert_eq!(hunks[0].historical_start, 2);
        assert_eq!(hunks[0].historical_lines, 1);
        assert_eq!(hunks[1].historical_start, 5);
        assert_eq!(hunks[1].historical_lines, 1);

        let reinstated =
            reinstate_history_hunk(current.into(), historical.into(), hunks[0].index).unwrap();
        assert_eq!(
            reinstated,
            "one\nhistorical alpha\nmiddle one\nmiddle two\ncurrent omega\nlast\n"
        );
    }

    #[test]
    fn history_reinstate_handles_insertions_and_deletions() {
        let deletion = history_diff("a\nextra\nb\n".into(), "a\nb\n".into());
        assert_eq!(deletion[0].historical_start, 1);
        assert_eq!(deletion[0].historical_lines, 0);
        assert_eq!(
            reinstate_history_hunk("a\nextra\nb\n".into(), "a\nb\n".into(), 0).unwrap(),
            "a\nb\n"
        );

        let leading_deletion = history_diff("extra\nafter\n".into(), "after\n".into());
        assert_eq!(leading_deletion[0].historical_start, 0);
        assert_eq!(leading_deletion[0].historical_lines, 0);

        let trailing_deletion = history_diff("a\nextra\n".into(), "a\n".into());
        assert_eq!(trailing_deletion[0].historical_start, 1);
        assert_eq!(trailing_deletion[0].historical_lines, 0);

        let insertion = history_diff("a\nb".into(), "a\nold\nb".into());
        assert_eq!(insertion[0].historical_start, 2);
        assert_eq!(insertion[0].historical_lines, 1);
        assert_eq!(
            reinstate_history_hunk("a\nb".into(), "a\nold\nb".into(), 0).unwrap(),
            "a\nold\nb"
        );

        let leading_insertion = history_diff("after\n".into(), "before\nafter\n".into());
        assert_eq!(leading_insertion[0].historical_start, 1);
        assert_eq!(leading_insertion[0].historical_lines, 1);
        assert_eq!(
            reinstate_history_hunk("after\n".into(), "before\nafter\n".into(), 0).unwrap(),
            "before\nafter\n"
        );

        let trailing_insertion = history_diff("a\n".into(), "a\nold\n".into());
        assert_eq!(trailing_insertion[0].historical_start, 2);
        assert_eq!(trailing_insertion[0].historical_lines, 1);
    }

    #[test]
    fn squash_plan_rewrites_only_commits_after_the_marker() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);

        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s.clone(), "base\n".into(), Some("Base".into()), true)
            .unwrap()
            .unwrap();
        let repo = Repository::discover(dir.path()).unwrap();
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();
        let base = repo.head().unwrap().target().unwrap();
        repo.reference(&squash_marker(&branch), base, true, "test squash boundary")
            .unwrap();

        save_document(
            doc_s.clone(),
            "first\n".into(),
            Some("First edit".into()),
            true,
        )
        .unwrap()
        .unwrap();
        save_document(
            doc_s.clone(),
            "second\n".into(),
            Some("Second edit".into()),
            true,
        )
        .unwrap()
        .unwrap();
        let old_head = repo.head().unwrap().target().unwrap();
        let old_tree = repo.find_commit(old_head).unwrap().tree_id();

        let plan = squash_plan(&doc_s).unwrap();
        assert_eq!(plan.base, base);
        assert_eq!(plan.head, old_head);
        assert_eq!(plan.summaries, ["First edit", "Second edit"]);
        assert!(plan.diff.contains("second"));

        assert!(apply_squash(&doc_s, &plan, &"x".repeat(73)).is_err());
        assert_eq!(repo.head().unwrap().target(), Some(old_head));

        let squashed = apply_squash(&doc_s, &plan, "Consolidate manuscript edits").unwrap();
        let new_head = Oid::from_str(&squashed.id).unwrap();
        let commit = repo.find_commit(new_head).unwrap();
        assert_eq!(commit.parent_id(0).unwrap(), base);
        assert_eq!(commit.tree_id(), old_tree);
        assert_eq!(repo.head().unwrap().target(), Some(new_head));
        assert_eq!(
            repo.find_reference(&squash_backup(&branch))
                .unwrap()
                .target(),
            Some(old_head)
        );
        assert_eq!(
            repo.find_reference(&squash_marker(&branch))
                .unwrap()
                .target(),
            Some(new_head)
        );
        assert!(squash_plan(&doc_s).is_err());
    }

    #[test]
    fn squash_requires_a_clean_worktree_including_untracked_files() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);
        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s, "base\n".into(), Some("Base".into()), true)
            .unwrap()
            .unwrap();
        std::fs::write(dir.path().join("untracked.md"), "draft\n").unwrap();
        let repo = Repository::discover(dir.path()).unwrap();
        assert!(require_clean_repo(&repo).is_err());
    }

    #[test]
    fn squash_plan_uses_the_integrated_upstream_point() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);
        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s.clone(), "base\n".into(), Some("Base".into()), true)
            .unwrap()
            .unwrap();
        let repo = Repository::discover(dir.path()).unwrap();
        let branch_name = repo.head().unwrap().shorthand().unwrap().to_string();
        let base = repo.head().unwrap().target().unwrap();
        repo.remote("origin", "https://example.invalid/repo.git")
            .unwrap();
        repo.reference(
            &format!("refs/remotes/origin/{branch_name}"),
            base,
            true,
            "test upstream",
        )
        .unwrap();
        repo.find_branch(&branch_name, BranchType::Local)
            .unwrap()
            .set_upstream(Some(&format!("origin/{branch_name}")))
            .unwrap();
        save_document(doc_s.clone(), "one\n".into(), Some("One".into()), true)
            .unwrap()
            .unwrap();
        save_document(doc_s.clone(), "two\n".into(), Some("Two".into()), true)
            .unwrap()
            .unwrap();

        let plan = squash_plan(&doc_s).unwrap();
        assert_eq!(plan.base, base);
        assert_eq!(plan.summaries, ["One", "Two"]);
    }
}
