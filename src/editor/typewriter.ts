import { EditorState } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const centered = (pos: number) => EditorView.scrollIntoView(pos, { y: "center" });

/**
 * Typewriter scrolling: the cursor line stays vertically centered and the
 * document moves underneath it. Appending the scroll effect to the same
 * transaction (rather than dispatching a follow-up) keeps it atomic and
 * loop-free. Pointer selections are the exception, centered on mouseup below.
 */
const centerOnChange = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged && !tr.selection) return null;
  if (tr.isUserEvent("select.pointer")) return null;
  return { effects: centered(tr.newSelection.main.head) };
});

/**
 * Centering while the mouse button is still down slides the text under the
 * pointer; WebKit then reports a mouse move at the same screen point and
 * CodeMirror extends the selection to whatever has moved beneath it, so a
 * plain click selects from the clicked spot to a line far away. Pointer
 * selections are therefore centered once the button is released. The
 * listener sits on the window so that it runs after CodeMirror's own
 * document-level mouseup, which may still move the selection. A release
 * outside the webview never reaches this window, so losing focus or a
 * mouse move with no button held ends the gesture as well.
 */
const centerAfterPointer = ViewPlugin.fromClass(
  class {
    private pending = false;
    private readonly win: Window;

    constructor(private readonly view: EditorView) {
      this.win = view.dom.ownerDocument.defaultView ?? window;
      this.win.addEventListener("mouseup", this.release);
      this.win.addEventListener("blur", this.release);
      this.win.addEventListener("mousemove", this.lostRelease);
    }

    update(update: ViewUpdate) {
      if (update.transactions.some((tr) => tr.isUserEvent("select.pointer"))) {
        this.pending = true;
      }
    }

    private release = () => {
      if (!this.pending) return;
      this.pending = false;
      this.view.dispatch({ effects: centered(this.view.state.selection.main.head) });
    };

    private lostRelease = (event: MouseEvent) => {
      if (event.buttons === 0) this.release();
    };

    destroy() {
      this.win.removeEventListener("mouseup", this.release);
      this.win.removeEventListener("blur", this.release);
      this.win.removeEventListener("mousemove", this.lostRelease);
    }
  },
);

export const typewriterScroll = [centerOnChange, centerAfterPointer];
