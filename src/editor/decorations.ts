import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { EditorState, Range } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

export function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return state.selection.ranges.some((r) => r.from <= to && r.to >= from);
}

export function decorationsChanged(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    syntaxTree(update.startState) !== syntaxTree(update.state)
  );
}

interface HiddenDecorations {
  decos: Range<Decoration>[];
  hide: (
    from: number,
    to: number,
    spec?: Parameters<typeof Decoration.replace>[0],
  ) => void;
}

/** Every replacement is also atomic, so navigation skips invisible markup. */
export function hiddenDecorations(build: (ranges: HiddenDecorations) => void) {
  const decos: Range<Decoration>[] = [];
  const hides: Range<Decoration>[] = [];
  build({
    decos,
    hide(from, to, spec = {}) {
      const range = Decoration.replace(spec).range(from, to);
      decos.push(range);
      hides.push(range);
    },
  });
  return {
    decorations: Decoration.set(decos, true),
    atomic: Decoration.set(hides, true),
  };
}

export function hidingPlugin(
  build: (view: EditorView, ranges: HiddenDecorations) => void,
) {
  const ranges = (view: EditorView) =>
    hiddenDecorations((ranges) => build(view, ranges));
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      atomic: DecorationSet;
      constructor(view: EditorView) {
        ({ decorations: this.decorations, atomic: this.atomic } = ranges(view));
      }
      update(update: ViewUpdate) {
        if (decorationsChanged(update) || update.selectionSet) {
          ({ decorations: this.decorations, atomic: this.atomic } = ranges(
            update.view,
          ));
        }
      }
    },
    {
      decorations: (value) => value.decorations,
      provide: (plugin) =>
        EditorView.atomicRanges.of(
          (view) => view.plugin(plugin)?.atomic ?? Decoration.none,
        ),
    },
  );
}
