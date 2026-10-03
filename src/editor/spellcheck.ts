import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
  Compartment,
  Facet,
  StateEffect,
  StateField,
  type Range,
} from "@codemirror/state";
import { decorationsChanged } from "./decorations";
import { notesField } from "./notes";
import * as api from "../api";
import { showSpellingMenu } from "../menu";

/**
 * macOS checks source text, while CodeMirror owns the marks. Browser-owned
 * underlines are lost when live preview or viewport rendering replaces DOM.
 */

/** Syntax nodes whose text is never prose. */
const NOT_PROSE = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "URL",
  "Autolink",
  "LinkTitle",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
  "CommentBlock",
  "ProcessingInstruction",
  "ProcessingInstructionBlock",
]);

const notProse = Decoration.mark({ attributes: { spellcheck: "false" } });
const settings = new Compartment();
const config = Facet.define<
  { language: string; notify?: (text: string) => void },
  { language: string; notify?: (text: string) => void }
>({
  combine: (values) => values[0] ?? { language: "" },
});
const ignoreWord = StateEffect.define<string>();
const ignoredWords = StateField.define<ReadonlySet<string>>({
  create: () => new Set(),
  update: (value, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(ignoreWord)) value = new Set([...value, effect.value]);
    }
    return value;
  },
});
const checked = StateEffect.define<{
  generation: number;
  ranges: api.SpellingRange[];
  fallback: boolean;
}>();

export function spellingConfiguration(
  language: string,
  notify?: (text: string) => void,
) {
  return [ignoredWords, settings.of(config.of({ language, notify }))];
}

export function setSpellingLanguage(view: EditorView, language: string) {
  view.dispatch({
    effects: settings.reconfigure(
      config.of({ ...view.state.facet(config), language }),
    ),
  });
}

function maskProse(view: EditorView, from: number, to: number): string {
  const text = view.state.sliceDoc(from, to).split("");
  const hide = (start: number, end: number) => {
    for (let i = Math.max(start, from); i < Math.min(end, to); i++) {
      if (text[i - from] !== "\n" && text[i - from] !== "\r")
        text[i - from] = " ";
    }
  };
  syntaxTree(view.state).iterate({
    from,
    to,
    enter: (node) => {
      if (NOT_PROSE.has(node.name)) {
        hide(node.from, node.to);
        return false;
      }
    },
  });
  for (const note of view.state.field(notesField, false) ?? []) {
    if (note.kind === "comment" && note.highlighted) {
      hide(note.from, note.hlFrom);
      hide(note.hlTo, note.to);
    } else if (note.kind === "suggestion") {
      hide(note.from, note.oldFrom);
      hide(note.oldTo, note.to);
    } else hide(note.from, note.to);
  }
  return text.join("");
}

function chunks(view: EditorView): { from: number; text: string }[] {
  const result: { from: number; text: string }[] = [];
  let previousEnd = 0;
  for (const visible of view.visibleRanges) {
    const from = Math.max(
      previousEnd,
      view.state.doc.lineAt(visible.from).from,
    );
    const to = view.state.doc.lineAt(visible.to).to;
    previousEnd = to;
    const text = maskProse(view, from, to);
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + 4_000, text.length);
      if (end < text.length) {
        const space = text.lastIndexOf(" ", end);
        const newline = text.lastIndexOf("\n", end);
        const boundary = Math.max(space, newline);
        if (boundary > start + 2_000) end = boundary;
        const char = text.charCodeAt(end - 1);
        if (char >= 0xd800 && char <= 0xdbff) end--;
      }
      const part = text.slice(start, end);
      if (part.trim()) result.push({ from: from + start, text: part });
      start = end;
    }
  }
  return result;
}

function excludedRanges(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (!NOT_PROSE.has(node.name) || node.from === node.to) return;
        marks.push(notProse.range(node.from, node.to));
        return false;
      },
    });
  }
  return Decoration.set(marks, true);
}

const checking = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    ranges: api.SpellingRange[] = [];
    generation = 0;
    fallback = false;
    destroyed = false;
    pending = false;
    timer: ReturnType<typeof setTimeout> | undefined;
    constructor(view: EditorView) {
      this.decorations = excludedRanges(view);
      this.schedule(view);
    }
    schedule(view: EditorView) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.check(view), 450);
    }
    async check(view: EditorView) {
      if (this.pending || this.destroyed || this.fallback) return;
      this.pending = true;
      const generation = this.generation;
      const language = view.state.facet(config).language;
      const ranges: api.SpellingRange[] = [];
      let fallback = false;
      try {
        for (const chunk of chunks(view)) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            api.checkSpelling(chunk.text, language),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Spelling check timed out")),
                10_000,
              );
            }),
          ]).finally(() => clearTimeout(timer));
          if (this.destroyed || generation !== this.generation) return;
          if (!result.supported) {
            fallback = true;
            break;
          }
          for (const range of result.ranges) {
            if (
              range.from >= 0 &&
              range.from < range.to &&
              range.to <= chunk.text.length
            ) {
              ranges.push({
                from: chunk.from + range.from,
                to: chunk.from + range.to,
              });
            }
          }
        }
      } catch (error) {
        if (this.destroyed || generation !== this.generation) return;
        fallback = true;
        view.state
          .facet(config)
          .notify?.(
            `Spelling service unavailable; using built-in checking: ${error}`,
          );
      } finally {
        this.pending = false;
        if (!this.destroyed && generation !== this.generation)
          this.schedule(view);
      }
      if (!this.destroyed && generation === this.generation) {
        view.dispatch({
          effects: checked.of({
            generation,
            ranges: fallback ? [] : ranges,
            fallback,
          }),
        });
      }
    }
    draw(view: EditorView) {
      const ignored = view.state.field(ignoredWords);
      const marks = this.ranges
        .filter(
          (range) => !ignored.has(view.state.sliceDoc(range.from, range.to)),
        )
        .map((range) =>
          Decoration.mark({ class: "cm-spelling-error" }).range(
            range.from,
            range.to,
          ),
        );
      this.decorations = excludedRanges(view).update({
        add: marks,
        sort: true,
      });
    }
    update(update: ViewUpdate) {
      // The parser finishes large documents asynchronously, in updates that
      // change neither the document nor the viewport.
      if (
        decorationsChanged(update) ||
        update.startState.facet(config).language !==
          update.state.facet(config).language
      ) {
        this.generation++;
        this.ranges = [];
        this.fallback = false;
        this.draw(update.view);
        this.schedule(update.view);
      }
      for (const transaction of update.transactions)
        for (const effect of transaction.effects) {
          if (
            effect.is(checked) &&
            effect.value.generation === this.generation
          ) {
            this.ranges = effect.value.ranges;
            this.fallback = effect.value.fallback;
            this.draw(update.view);
          }
          if (effect.is(ignoreWord)) this.draw(update.view);
        }
    }
    destroy() {
      this.destroyed = true;
      clearTimeout(this.timer);
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

export function openSpellingContextMenu(
  view: EditorView,
  target: EventTarget | null,
  rephrase?: (
    from: number,
    to: number,
    selection: string,
    document: string,
  ) => void,
): boolean {
  const checkingState = view.plugin(checking);
  const mark =
    target instanceof Element ? target.closest(".cm-spelling-error") : null;
  if (!checkingState || !mark || view.state.selection.ranges.length !== 1)
    return false;
  const position = view.posAtDOM(mark);
  const range = checkingState.ranges.find(
    (range) => range.from <= position && position < range.to,
  );
  if (!range) return false;
  const selection = view.state.selection.main;
  if (selection.from > range.from || selection.to < range.to) {
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      userEvent: "select.pointer",
    });
  }
  const selected = view.state.selection.main;
  const doc = view.state.doc;
  const language = view.state.facet(config).language;
  const word = view.state.sliceDoc(range.from, range.to);
  const current = () =>
    !checkingState.destroyed &&
    view.state.doc === doc &&
    view.state.facet(config).language === language;
  const report = (error: unknown) => {
    if (current())
      view.state
        .facet(config)
        .notify?.(`Could not complete spelling action: ${error}`);
  };
  void api
    .spellingSuggestions(word, language)
    .then((suggestions) => {
      if (!current()) return;
      return showSpellingMenu(
        suggestions,
        view.state.readOnly
          ? null
          : (replacement) => {
              if (!current() || view.state.readOnly) return;
              view.dispatch({
                changes: {
                  from: range.from,
                  to: range.to,
                  insert: replacement,
                },
                selection: { anchor: range.from + replacement.length },
                userEvent: "input.spelling",
              });
              view.focus();
            },
        () => {
          if (current()) view.dispatch({ effects: ignoreWord.of(word) });
        },
        () => {
          if (!current()) return;
          void api
            .learnSpellingWord(word)
            .then(() => {
              if (current()) view.dispatch({ effects: ignoreWord.of(word) });
            })
            .catch(report);
        },
        !view.state.readOnly && rephrase
          ? () => {
              if (current() && !view.state.readOnly)
                rephrase(
                  selected.from,
                  selected.to,
                  doc.sliceString(selected.from, selected.to),
                  doc.toString(),
                );
            }
          : undefined,
      );
    })
    .catch(report);
  return true;
}

export const spellcheck = [
  checking,
  EditorView.contentAttributes.of((view) => ({
    spellcheck: view.plugin(checking)?.fallback ? "true" : "false",
  })),
];
