import { useEffect, useRef, useState } from "react";

export interface RephraseSkillOption {
  id: string;
  name: string;
  estimated_tokens: number;
  available: boolean;
}

interface Props {
  selection: string;
  skills: RephraseSkillOption[];
  skillsLoading: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (preset: string, skillId: string | null, direction: string) => void;
  onClose: () => void;
}

const PRESETS = [
  { id: "more_concise", label: "More concise" },
  { id: "more_vivid", label: "More vivid" },
  { id: "simplify_syntax", label: "Simplify syntax" },
  { id: "humanize", label: "Humanize" },
  { id: "synonyms_only", label: "Synonyms only" },
];

export function RephraseDialog({
  selection,
  skills,
  skillsLoading,
  busy,
  error,
  onSubmit,
  onClose,
}: Props) {
  const [choice, setChoice] = useState("more_concise");
  const [direction, setDirection] = useState("");
  const directionRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    directionRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const submit = () => {
    const skillId = choice.startsWith("skill:") ? choice.slice(6) : null;
    onSubmit(skillId ? "skill" : choice, skillId, direction);
  };

  return (
    <div className="rephrase-overlay" onMouseDown={onClose}>
      <form
        className="rephrase-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Rephrase with Toki"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) submit();
        }}
      >
        <h3>Rephrase with Toki</h3>
        <p className="rephrase-selection">{selection}</p>

        <div className="rephrase-presets" aria-label="Rephrase preset">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={choice === preset.id ? "active" : ""}
              aria-pressed={choice === preset.id}
              disabled={busy}
              onClick={() => setChoice(preset.id)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {skillsLoading ? (
          <p className="muted">Loading project rephrase skills…</p>
        ) : skills.length > 0 ? (
          <label>
            Project skill
            <select
              className="rephrase-skill"
              value={choice.startsWith("skill:") ? choice : ""}
              disabled={busy}
              onChange={(event) => {
                if (event.target.value) setChoice(event.target.value);
              }}
            >
              <option value="">Choose a skill…</option>
              {skills.map((skill) => (
                <option
                  key={skill.id}
                  value={`skill:${skill.id}`}
                  disabled={!skill.available}
                >
                  {skill.name} (≈{skill.estimated_tokens}/1024 tokens
                  {skill.available ? "" : ", too long"})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label>
          Direction
          <textarea
            ref={directionRef}
            value={direction}
            maxLength={4096}
            disabled={busy}
            placeholder="For example: preserve the comic cadence and make the ending less explicit."
            onChange={(event) => setDirection(event.target.value)}
          />
        </label>

        {error ? <p className="rephrase-error">{error}</p> : null}

        <div className="rephrase-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy}>
            {busy ? "Rephrasing…" : "Rephrase"}
          </button>
        </div>
      </form>
    </div>
  );
}
