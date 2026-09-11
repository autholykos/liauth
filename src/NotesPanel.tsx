import type { CommentNote, NoteMatch, SuggestionNote } from "./editor/notes";
import { clip } from "./format";

interface NoteActions {
  addNote: () => void;
  addSuggestion: () => void;
  jumpToNote: (note: NoteMatch) => void;
  applySuggestion: (note: SuggestionNote, accept: boolean) => void;
  dismissNote: (note: CommentNote) => void;
  draftEdits: (note: CommentNote) => Promise<void>;
}

export function NotesPanel({
  notes,
  readOnly,
  drafting,
  actions,
}: {
  notes: NoteMatch[];
  readOnly: boolean;
  drafting: number | null;
  actions: NoteActions;
}) {
  const {
    addNote,
    addSuggestion,
    jumpToNote,
    applySuggestion,
    dismissNote,
    draftEdits,
  } = actions;
  return (
    <aside className="side-panel">
      <h3>Notes</h3>
      <button className="wide" onClick={addNote} disabled={readOnly}>
        Add note at cursor (⌘⇧M)
      </button>
      <button className="wide" onClick={addSuggestion} disabled={readOnly}>
        Suggest edit to selection (⌘⇧U)
      </button>
      {notes.length === 0 ? (
        <p className="muted">
          No notes. Select text and press ⌘⇧M to annotate it or ⌘⇧U to suggest a
          rewording; both are stored as CriticMarkup in the document and removed
          from PDF export.
        </p>
      ) : null}
      <ul className="note-list">
        {notes.map((n, i) => (
          <li key={`${n.from}-${i}`} onClick={() => jumpToNote(n)}>
            {n.kind === "suggestion" ? (
              <>
                <span className="note-excerpt note-old">
                  {n.oldText ? `“${clip(n.oldText)}”` : "(insertion)"}
                </span>
                <span className="note-comment">
                  {n.newText ? `→ ${clip(n.newText)}` : "→ (deletion)"}
                </span>
                <span className="branch-actions">
                  <button
                    disabled={readOnly}
                    onClick={(e) => {
                      e.stopPropagation();
                      applySuggestion(n, true);
                    }}
                  >
                    Accept
                  </button>
                  <button
                    disabled={readOnly}
                    onClick={(e) => {
                      e.stopPropagation();
                      applySuggestion(n, false);
                    }}
                  >
                    Reject
                  </button>
                </span>
              </>
            ) : (
              <>
                {n.highlighted ? (
                  <span className="note-excerpt">“{clip(n.excerpt)}”</span>
                ) : (
                  <span className="note-excerpt muted">(standalone)</span>
                )}
                <span className="note-comment">
                  {n.comment.trim() || "(empty)"}
                </span>
                <span className="branch-actions">
                  <button
                    disabled={readOnly}
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissNote(n);
                    }}
                  >
                    Dismiss
                  </button>
                  <button
                    disabled={readOnly || drafting !== null}
                    title="Ask the model to turn this note into suggestions"
                    onClick={(e) => {
                      e.stopPropagation();
                      void draftEdits(n);
                    }}
                  >
                    {drafting === n.from ? "Drafting…" : "Draft edits"}
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
