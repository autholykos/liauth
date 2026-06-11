/**
 * Fuzzy matching shared by the command palette and the help search.
 */

/** Subsequence fuzzy match; returns a score (lower = better) or null. */
export function fuzzy(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return t.length;
  let qi = 0;
  let score = 0;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += last >= 0 ? ti - last - 1 : ti;
      last = ti;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

/**
 * Word-level fuzzy match for prose: every whitespace-separated query token
 * must subsequence-match some word of the target. Plain `fuzzy` over a long
 * text matches almost anything (a subsequence can span many words), which
 * makes it useless as a filter.
 */
export function fuzzyWords(query: string, target: string): number | null {
  const words = target.toLowerCase().split(/\s+/);
  let total = 0;
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (!token) continue;
    let best: number | null = null;
    for (const w of words) {
      const s = fuzzy(token, w);
      if (s !== null && (best === null || s < best)) best = s;
    }
    if (best === null) return null;
    total += best;
  }
  return total;
}
