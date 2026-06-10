import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/**
 * Typewriter scrolling: the cursor line stays vertically centered and the
 * document moves underneath it. Appending the scroll effect to the same
 * transaction (rather than dispatching a follow-up) keeps it atomic and
 * loop-free.
 */
export const typewriterScroll = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged && !tr.selection) return null;
  return {
    effects: EditorView.scrollIntoView(tr.newSelection.main.head, {
      y: "center",
    }),
  };
});
