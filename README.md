# Liauth

A markdown editor that doesn't suck: Typora-style live preview with an embedded
git engine for versioning and asynchronous review.

## What it does

- **Live preview editing** — the markdown source is the document. Syntax
  markers (`#`, `**`, `` ` ``, `[]()`, `>`, `-`) render in place and reveal
  themselves only where your cursor is, Typora-style. Task-list checkboxes are
  clickable.
- **Versioning built in** — every save is a git commit (skipped when nothing
  changed). The History panel lists versions of the open file; any version can
  be viewed read-only or restored.
- **Review workflow** — create a review branch for a second pair of eyes, both
  sides edit independently, then "Merge in" reconciles. Conflicts appear as
  standard `<<< >>>` markers right in the editor; saving while a merge is in
  progress concludes it with a proper two-parent merge commit. Aborting
  restores the pre-merge state.
- **PDF export** — renders the document to HTML (markdown-it + DOMPurify) and
  hands it to the system print dialog (Save as PDF on macOS).

## Architecture

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri 2 (Rust) | small binaries, first-class libgit2 access |
| Git engine | `git2` (libgit2 bindings) | in-process, no shelling out — `src-tauri/src/git.rs` |
| Editor | CodeMirror 6 + Lezer markdown | text stays the document model, so git diffs stay meaningful — `src/editor/` |
| UI | React + TypeScript | toolbar, history/review panels — `src/App.tsx` |

Documents stay **plain `.md` files on disk**; the repo lives in the document's
folder. Files remain fully usable with any other tool, including plain `git`.

Real-time co-editing is deliberately out of scope for v1; the document layer is
plain text end to end, so a CRDT (Yjs/Loro) can be layered on later without
changing the storage model.

## Development

```sh
npm install
npm run tauri dev      # run the app
npm run build          # typecheck + bundle frontend
cd src-tauri && cargo test   # git engine end-to-end tests
```
