/**
 * Tokenizer for Rapid Serial Visual Presentation.
 *
 * Splits the raw markdown into displayable words, keeping each word's
 * offset in the source (so the player can start at the cursor and drop
 * the cursor back where reading stopped) while stripping markdown
 * decoration, link targets, and CriticMarkup comments from what's shown.
 */

export interface RsvpWord {
  text: string;
  offset: number; // position of the raw token in the document
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
  // CriticMarkup and emphasis/code decoration anywhere in the token.
  t = t.replace(/\{==|==\}|\{>>|<<\}|\{\+\+|\+\+\}|\{--|--\}/g, "");
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

export function buildRsvpWords(text: string): RsvpWord[] {
  const words: RsvpWord[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  let lastEnd = 0;
  let skippingComment = false;

  while ((m = re.exec(text))) {
    const raw = m[0];
    const gap = text.slice(lastEnd, m.index);
    lastEnd = m.index + raw.length;
    const paragraphBreak = /\n[ \t]*\n/.test(gap);

    // Skip CriticMarkup comment bodies entirely — notes aren't prose —
    // but keep any prose sharing a token with the comment delimiters.
    let body = raw;
    if (skippingComment) {
      const ci = body.indexOf("<<}");
      if (ci < 0) continue;
      skippingComment = false;
      body = body.slice(ci + 3);
      if (!body) continue;
    }
    const oi = body.indexOf("{>>");
    if (oi >= 0) {
      const ci = body.indexOf("<<}", oi);
      if (ci >= 0) {
        body = body.slice(0, oi) + body.slice(ci + 3);
      } else {
        body = body.slice(0, oi);
        skippingComment = true;
      }
      if (!body) continue;
    }

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

    words.push({ text: cleaned, offset: m.index, mult });
  }
  return words;
}
