# Desktop E2E coverage

Run `npm run test:e2e` on macOS 14+. The E2E build forces the window hidden,
non-focusable and initially unfocused, and sets the macOS application activation
policy to Prohibited before its event loop starts. It must not show or activate
the application on the user's desktop. The runner
builds and launches the actual Tauri application with an optional embedded
WebDriver. React, CodeMirror, IPC, Rust, filesystem, Git and NSSpellChecker are
real. Only the external Jev HTTP service is controlled in the default suite.
`npm run test:e2e:live` uses the real Nanto endpoint with synthetic documents.

Each run retains its fixture repositories, HTTP requests, app log, screenshots,
DOM snapshots and JSON results under `artifacts/e2e/`. Tests do not use the user's
documents or configuration. The driver and endpoint override are compiled only
with the `e2e` Cargo feature; release builds must omit that feature.

## Failure inventory and migration

| Area | Failure modes to exercise | Existing coverage retained until replaced |
| --- | --- | --- |
| Jev | Missing credentials, wrong HTTP contract, batching, Unicode selection, stale results, cancellation, provider failure vs no matches | Rust parsing/bounds, malformed responses and overlapping request IDs |
| Spelling | Loaded text unchecked, wrong dictionary, UTF-16 drift, code/comment exclusions, lost marks after rendering, persisted language | Native-menu correction/Undo/Ignore/Learn, stale callbacks, timeout and unavailable dictionaries |
| Documents | Autosave loss, wrong document reopened, external overwrite, merge discarding either edit | Out-of-order open/drop/save completions and binary rejection |
| Git | Save without commit, wrong branch, lost changes after merge, incorrect history | Worktree, staging, squash, conflict and recovery edge cases |
| Editor | Preview mutates source, lost Undo, Vim search-repeat and focus regressions | Pointer gestures, diagnostic exceptions, adaptive-layout edge cases |
| Navigation | Wrong file opened, search ignores unsaved text, wrong match selected | Folder aggregation and preference corruption |

Remove a focused test only after its observable behavior is exercised by a
passing desktop scenario. Keep failure-injection tests for races that the E2E
harness cannot yet reproduce deterministically. Native menus/dialogs are not DOM
elements; WebView coverage alone does not establish their behavior.

## Migrated coverage

The default `npm test` runs the desktop suite. `npm run test:focused` retains the
remaining Vitest tests. CI runs both, plus Rust integration tests; the scheduled
and manually dispatched workflows also run the live Jev suite.

Six frontend tests were replaced: the unsaved-document semantic search and
preview navigation scenario, four stale-response cases (edit, switch, query,
cancel), and provider-error/no-match/result-invalidation behavior. The spelling
scenario covers loaded documents, stable marks, Unicode and Markdown exclusions.

The driver synthesizes DOM input in the real WKWebView. Opening fixtures uses the
normal Tauri `open-file` event; bulk text input uses a DOM paste event with an
in-memory DataTransfer, without reading or writing the system clipboard. Window
blur is dispatched for the autosave scenario. These tests do not establish OS
file-picker behavior, native contextual menus, real keyboard focus or macOS input
prediction behavior. Those tests remain in place or require a dedicated runner.

The external-change scenario exposed a missing production dependency feature:
`tauri-plugin-fs/watch`. It now verifies real filesystem notifications, automatic
merging, conflict markers, manual resolution and saving.
