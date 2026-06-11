import { useEffect, useMemo, useRef, useState } from "react";

export interface PaletteCommand {
  id: string;
  title: string;
  shortcut?: string;
}

interface Props {
  commands: PaletteCommand[];
  onRun: (id: string) => void;
  onClose: () => void;
}

/** Subsequence fuzzy match; returns a score (lower = better) or null. */
function fuzzy(query: string, target: string): number | null {
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

export function CommandPalette({ commands, onRun, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    return commands
      .map((c) => ({ c, score: fuzzy(query, c.title) }))
      .filter((x): x is { c: PaletteCommand; score: number } => x.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((x) => x.c);
  }, [commands, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const run = (id: string) => {
    onClose();
    onRun(id);
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(filtered.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter" && filtered[selected]) {
              e.preventDefault();
              run(filtered[selected].id);
            }
          }}
        />
        <ul className="palette-list" ref={listRef}>
          {filtered.map((c, i) => (
            <li
              key={c.id}
              className={i === selected ? "selected" : ""}
              onMouseEnter={() => setSelected(i)}
              onClick={() => run(c.id)}
            >
              <span>{c.title}</span>
              {c.shortcut ? (
                <span className="palette-shortcut">{c.shortcut}</span>
              ) : null}
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="muted">No matching command</li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
