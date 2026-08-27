import { useEffect, useRef, useState } from "react";

export interface RephraseSkillOption {
  id: string;
  name: string;
  estimated_tokens: number;
  available: boolean;
  instructions: string;
}

interface Props {
  selection: string;
  skills: RephraseSkillOption[];
  skillsLoading: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (direction: string, synonymsOnly: boolean) => void;
  onClose: () => void;
}

// Presets are templates for the direction field, not hidden modes: clicking
// one prefills the textarea and the author edits from there. The model sees
// the direction alone, so what is on screen is exactly what it receives.
// Texts stay in Italian, the language of the manuscripts.
const PRESETS = [
  {
    id: "more_concise",
    label: "More concise",
    text: "Elimina le ridondanze e accorcia il testo senza perdere informazioni né tono.",
  },
  {
    id: "more_vivid",
    label: "More vivid",
    text: "Preferisci sostantivi concreti, verbi attivi e immagini sensoriali, senza inventare fatti.",
  },
  {
    id: "simplify_syntax",
    label: "Simplify syntax",
    text: "Riduci la complessità sintattica e le subordinate conservando voce e significato.",
  },
  {
    id: "humanize",
    label: "Humanize",
    text: "Togli le formule generiche e di maniera, migliora ritmo e idiosincrasia naturali. Non introdurre errori e non cercare di eludere rilevatori.",
  },
  {
    id: "synonyms_only",
    label: "Synonyms only",
    text: "Sostituisci soltanto singole parole. Conserva ordine delle parole, sintassi, punteggiatura, spazi e numero di frasi.",
  },
];

const SYNONYMS_ONLY_TEXT = PRESETS.find((p) => p.id === "synonyms_only")!.text;

export function RephraseDialog({
  selection,
  skills,
  skillsLoading,
  busy,
  error,
  onSubmit,
  onClose,
}: Props) {
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

  // A preset or skill counts as "active" only while the field still holds
  // its text verbatim; any edit turns the direction into a custom one. The
  // Synonyms-only guard (low temperature, structure check) follows the same
  // rule, so an edited direction is never rejected by a check it did not ask for.
  const trimmed = direction.trim();
  const activePreset = PRESETS.find((p) => p.text === trimmed)?.id ?? null;
  const activeSkill =
    skills.find((s) => s.instructions.trim() === trimmed)?.id ?? null;
  const synonymsOnly = trimmed === SYNONYMS_ONLY_TEXT;

  const prefill = (text: string) => {
    setDirection(text);
    directionRef.current?.focus();
  };

  const submit = () => {
    if (!trimmed) return;
    onSubmit(trimmed, synonymsOnly);
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
              className={activePreset === preset.id ? "active" : ""}
              aria-pressed={activePreset === preset.id}
              disabled={busy}
              onClick={() => prefill(preset.text)}
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
              value={activeSkill ?? ""}
              disabled={busy}
              onChange={(event) => {
                const skill = skills.find((s) => s.id === event.target.value);
                if (skill) prefill(skill.instructions);
              }}
            >
              <option value="">Choose a skill…</option>
              {skills.map((skill) => (
                <option
                  key={skill.id}
                  value={skill.id}
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
            placeholder="Pick a preset to start from, or write your own. For example: riformula in positivo con un costrutto comparativo (più che…, anziché…), senza «non»."
            onChange={(event) => setDirection(event.target.value)}
          />
        </label>

        {error ? <p className="rephrase-error">{error}</p> : null}

        <div className="rephrase-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !trimmed}>
            {busy ? "Rephrasing…" : "Rephrase"}
          </button>
        </div>
      </form>
    </div>
  );
}
