use git2::{
    BranchType, Commit, ErrorCode, MergeOptions, Oid, Repository, RepositoryState, Signature,
};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct RepoInfo {
    pub repo_root: Option<String>,
    pub branch: Option<String>,
    pub merging: bool,
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
    }
}

#[tauri::command]
pub fn repo_info(file_path: String) -> RepoInfo {
    match discover(&file_path) {
        Ok(repo) => info(&repo),
        Err(_) => RepoInfo {
            repo_root: None,
            branch: None,
            merging: false,
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

/// Write the file and, if it lives in a repository, stage and commit it.
/// While a merge is in progress, the commit gets both parents and
/// concludes the merge.
#[tauri::command]
pub fn save_document(
    file_path: String,
    content: String,
    message: Option<String>,
) -> Result<Option<CommitInfo>, String> {
    fs::write(&file_path, &content).map_err(|e| e.to_string())?;

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
        rel.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()
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
    let annotated = repo.reference_to_annotated_commit(&their_ref).map_err(err)?;
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
        let r = save_document(doc_s.clone(), "# Title\n\nv1 line\n".into(), None).unwrap();
        assert!(r.is_none());
        assert_eq!(read_document(doc_s.clone()).unwrap(), "# Title\n\nv1 line\n");

        // Enable versioning.
        init_repo(doc_s.clone()).unwrap();
        let c1 = save_document(doc_s.clone(), "# Title\n\nv1 line\n".into(), Some("Initial version".into()))
            .unwrap()
            .expect("first commit");
        assert_eq!(c1.summary, "Initial version");

        // Saving identical content must not create an empty commit.
        let r = save_document(doc_s.clone(), "# Title\n\nv1 line\n".into(), None).unwrap();
        assert!(r.is_none());

        // A real edit commits; history is newest-first.
        save_document(doc_s.clone(), "# Title\n\nv2 line\n".into(), None)
            .unwrap()
            .expect("second commit");
        let hist = file_history(doc_s.clone(), None).unwrap();
        assert_eq!(hist.len(), 2);
        assert_eq!(file_at_commit(doc_s.clone(), hist[1].id.clone()).unwrap(), "# Title\n\nv1 line\n");

        let main_branch = repo_info(doc_s.clone()).branch.expect("branch name");

        // Reviewer edits on their own branch.
        create_branch(doc_s.clone(), "review/anna".into(), true).unwrap();
        save_document(doc_s.clone(), "# Title\n\nreviewer line\n".into(), Some("Review edits".into()))
            .unwrap()
            .expect("review commit");

        // Author keeps working on the main branch — conflicting change.
        checkout_branch(doc_s.clone(), main_branch.clone()).unwrap();
        assert_eq!(read_document(doc_s.clone()).unwrap(), "# Title\n\nv2 line\n");
        save_document(doc_s.clone(), "# Title\n\nauthor line\n".into(), None)
            .unwrap()
            .expect("author commit");

        // Merge the review branch: must conflict.
        let m = merge_branch(doc_s.clone(), "review/anna".into()).unwrap();
        assert_eq!(m.status, "conflicts");
        assert_eq!(m.conflicts, vec!["doc.md".to_string()]);
        let conflicted = read_document(doc_s.clone()).unwrap();
        assert!(conflicted.contains("<<<<<<<"), "conflict markers expected: {conflicted}");
        assert!(repo_info(doc_s.clone()).merging);

        // Resolving = editing the markers away and saving.
        let merge_commit = save_document(
            doc_s.clone(),
            "# Title\n\nauthor and reviewer line\n".into(),
            Some("Merge review/anna".into()),
        )
        .unwrap()
        .expect("merge commit");
        assert!(!repo_info(doc_s.clone()).merging);

        let repo = Repository::discover(dir.path()).unwrap();
        let commit = repo.find_commit(Oid::from_str(&merge_commit.id).unwrap()).unwrap();
        assert_eq!(commit.parent_count(), 2, "merge commit must have two parents");

        // Fast-forward path: branch ahead, main untouched.
        create_branch(doc_s.clone(), "review/ben".into(), true).unwrap();
        save_document(doc_s.clone(), "# Title\n\nben's improvement\n".into(), None)
            .unwrap()
            .expect("ben commit");
        checkout_branch(doc_s.clone(), main_branch).unwrap();
        let m = merge_branch(doc_s.clone(), "review/ben".into()).unwrap();
        assert_eq!(m.status, "fast_forward");
        assert_eq!(read_document(doc_s.clone()).unwrap(), "# Title\n\nben's improvement\n");
    }

    /// abort_merge restores HEAD's tree and clears the merge state.
    #[test]
    fn abort_merge_restores_working_tree() {
        let dir = tempfile::tempdir().unwrap();
        let doc = dir.path().join("doc.md");
        let doc_s = p(&doc);

        init_repo(doc_s.clone()).unwrap();
        save_document(doc_s.clone(), "base\n".into(), None).unwrap().unwrap();
        let main_branch = repo_info(doc_s.clone()).branch.unwrap();

        create_branch(doc_s.clone(), "review/x".into(), true).unwrap();
        save_document(doc_s.clone(), "their change\n".into(), None).unwrap().unwrap();
        checkout_branch(doc_s.clone(), main_branch).unwrap();
        save_document(doc_s.clone(), "my change\n".into(), None).unwrap().unwrap();

        let m = merge_branch(doc_s.clone(), "review/x".into()).unwrap();
        assert_eq!(m.status, "conflicts");

        abort_merge(doc_s.clone()).unwrap();
        assert!(!repo_info(doc_s.clone()).merging);
        assert_eq!(read_document(doc_s.clone()).unwrap(), "my change\n");
    }
}
