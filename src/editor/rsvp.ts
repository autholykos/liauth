/**
 * Tokenizer for Rapid Serial Visual Presentation.
 *
 * Splits the raw markdown into displayable words, keeping each word's
 * offset in the source (so the player can start at the cursor and drop
 * the cursor back where reading stopped) while stripping markdown
 * decoration, link targets, and CriticMarkup comments from what's shown.
 */

import { hiddenSpans, scanNotes, type NoteMatch } from "./notes";

export interface RsvpWord {
  text: string;
  offset: number; // position of the raw token in the document
  end: number; // end of the raw token in the document
  mult: number; // display-duration multiplier
}

/** Spritz-style Optimal Recognition Point: the letter to pin in place. */
export function orpIndex(word: string): number {
  const len = word.replace(/[^\p{L}\p{N}]/gu, "").length || word.length;
  if (len <= 1) return 0;
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  if (len <= 13) return 3;
  return 4;
}

function cleanToken(tok: string): string {
  let t = tok;
  // Emphasis/code decoration anywhere in the token.
  t = t.replace(/[*_`~]+/g, "");
  // Links/images: drop the (target), keep the text.
  t = t.replace(/\]\([^)]*\)?/g, "]");
  t = t.replace(/^!?\[+/, "").replace(/\]+/g, "");
  // Leading structure markers and brackets/quotes.
  t = t.replace(/^[#>+|("'“‘[{-]+/, "");
  // Trailing closing brackets/quotes (keep sentence punctuation).
  t = t.replace(/[)"'”’\]}|]+$/, "");
  return t;
}

export function buildRsvpWords(
  text: string,
  notes: readonly NoteMatch[] = scanNotes(text),
): RsvpWord[] {
  const hidden = hiddenSpans(notes);
  let hiddenIndex = 0;
  const words: RsvpWord[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;

  while ((m = re.exec(text))) {
    const raw = m[0];
    const gap = text.slice(lastEnd, m.index);
    lastEnd = m.index + raw.length;
    const paragraphBreak = /\n[ \t]*\n/.test(gap);

    // Subtract annotation spans from the raw token, keeping source offsets.
    while (hiddenIndex < hidden.length && hidden[hiddenIndex].to <= m.index)
      hiddenIndex++;
    let body = "";
    let visibleFrom = m.index;
    for (
      let i = hiddenIndex;
      i < hidden.length && hidden[i].from < lastEnd;
      i++
    ) {
      body += text.slice(visibleFrom, Math.max(visibleFrom, hidden[i].from));
      visibleFrom = Math.min(lastEnd, hidden[i].to);
    }
    body += text.slice(visibleFrom, lastEnd);

    const cleaned = cleanToken(body);
    if (!cleaned) continue;

    // Breathe at paragraph boundaries: extend the previous word.
    if (paragraphBreak && words.length > 0) {
      words[words.length - 1].mult += 1.2;
    }

    let mult = 1;
    if (/[.!?…]$/.test(cleaned)) mult = 2.0;
    else if (/[,;:—]$/.test(cleaned)) mult = 1.4;
    if (cleaned.length >= 10) mult += 0.3;

    words.push({
      text: cleaned,
      offset: m.index,
      end: m.index + raw.length,
      mult,
    });
  }
  return words;
}
