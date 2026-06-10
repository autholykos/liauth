import { useCallback, useEffect, useState } from "react";
import { RsvpWord, orpIndex } from "./editor/rsvp";

const WPM_MIN = 100;
const WPM_MAX = 900;
const WPM_STEP = 25;

function initialWpm(): number {
  const stored = Number(localStorage.getItem("liauth.wpm"));
  return stored >= WPM_MIN && stored <= WPM_MAX ? stored : 350;
}

interface Props {
  words: RsvpWord[];
  startIndex: number;
  onExit: (offset: number) => void;
}

export function RsvpOverlay({ words, startIndex, onExit }: Props) {
  const [index, setIndex] = useState(startIndex);
  const [playing, setPlaying] = useState(true);
  const [wpm, setWpm] = useState(initialWpm);

  const i = Math.min(index, words.length - 1);
  const word = words[i];
  const finished = index >= words.length;

  useEffect(() => {
    localStorage.setItem("liauth.wpm", String(wpm));
  }, [wpm]);

  // The player: one timeout per word, length scaled by the word's
  // multiplier (sentence ends, long words, paragraph breaks).
  useEffect(() => {
    if (!playing || finished) return;
    const delay = (60000 / wpm) * words[index].mult;
    const t = window.setTimeout(() => setIndex((n) => n + 1), delay);
    return () => window.clearTimeout(t);
  }, [playing, index, wpm, words, finished]);

  useEffect(() => {
    if (finished) setPlaying(false);
  }, [finished]);

  const exit = useCallback(() => {
    onExit(words[Math.min(i, words.length - 1)].offset);
  }, [onExit, words, i]);

  useEffect(() => {
    const clampW = (w: number) => Math.min(WPM_MAX, Math.max(WPM_MIN, w));
    const handled = [
      "Escape",
      " ",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
    ];
    const onKey = (e: KeyboardEvent) => {
      if (!handled.includes(e.key) || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      switch (e.key) {
        case "Escape":
          exit();
          break;
        case " ":
          setPlaying((p) => (finished ? p : !p));
          break;
        case "ArrowLeft":
          setPlaying(false);
          setIndex((n) =>
            Math.max(0, Math.min(n, words.length - 1) - (e.shiftKey ? 10 : 1)),
          );
          break;
        case "ArrowRight":
          setPlaying(false);
          setIndex((n) =>
            Math.min(words.length - 1, n + (e.shiftKey ? 10 : 1)),
          );
          break;
        case "ArrowUp":
          setWpm((w) => clampW(w + WPM_STEP));
          break;
        case "ArrowDown":
          setWpm((w) => clampW(w - WPM_STEP));
          break;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [exit, words.length, finished]);

  const orp = orpIndex(word.text);
  const before = word.text.slice(0, orp);
  const pivot = word.text.slice(orp, orp + 1);
  const after = word.text.slice(orp + 1);

  return (
    <div className="rsvp-overlay" onClick={() => setPlaying((p) => !p)}>
      <div className="rsvp-stage">
        <div className="rsvp-guide rsvp-guide-top" />
        <div className="rsvp-word">
          <span className="rsvp-before">{before}</span>
          <span className="rsvp-pivot">{pivot}</span>
          <span className="rsvp-after">{after}</span>
        </div>
        <div className="rsvp-guide rsvp-guide-bottom" />
      </div>

      <div className="rsvp-progress">
        <div
          className="rsvp-progress-fill"
          style={{ width: `${((i + 1) / words.length) * 100}%` }}
        />
      </div>

      <div className="rsvp-status">
        <span>
          {finished ? "done" : playing ? "" : "paused"} {wpm} wpm ·{" "}
          {Math.min(i + 1, words.length)}/{words.length}
        </span>
        <span className="muted">
          space play/pause · ←/→ step (⇧ ×10) · ↑/↓ speed · esc exit
        </span>
      </div>
    </div>
  );
}
