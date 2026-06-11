import { ReactNode, useState } from "react";
import { fuzzy, fuzzyWords } from "./fuzzy";
import { VimrcSummary } from "./editor/vimrc";

interface Props {
  vimActive: boolean;
  vimrc: VimrcSummary | null;
}

const SHORTCUTS: { keys: ReactNode; label: string }[] = [
  { keys: <kbd>⌘K</kbd>, label: "command palette" },
  { keys: <kbd>⌘S</kbd>, label: "save (commit)" },
  {
    keys: (
      <>
        <kbd>⌘B</kbd> / <kbd>⌘I</kbd>
      </>
    ),
    label: "bold / italic",
  },
  { keys: <kbd>⌘⇧M</kbd>, label: "insert note" },
  { keys: <kbd>⌘⇧F</kbd>, label: "writing room" },
  { keys: <kbd>⌘⇧R</kbd>, label: "speed read" },
  {
    keys: (
      <>
        <kbd>⌘+</kbd> / <kbd>⌘−</kbd> / <kbd>⌘0</kbd>
      </>
    ),
    label: "zoom",
  },
  { keys: <kbd>⌘R</kbd>, label: "reload from disk" },
];

export function HelpPanel({ vimActive, vimrc }: Props) {
  const [query, setQuery] = useState("");

  // Each section carries the searchable words of its copy; the rendered
  // JSX stays free-form. A section is shown when every query token
  // fuzzy-matches one of its words.
  const sections: { title: string; search: string; body: ReactNode }[] = [
    {
      title: "Documents",
      search:
        "documents plain markdown md files autosave disk save commit version buffer",
      body: (
        <p>
          Documents are plain <code>.md</code> files — usable with any other
          tool. The buffer autosaves to disk when you switch apps (and when
          leaving vim insert mode). <kbd>⌘S</kbd> is more: it{" "}
          <em>commits a version</em>.
        </p>
      ),
    },
    {
      title: "Versioning",
      search:
        "versioning enable git repository folder save commit history panel restore version",
      body: (
        <p>
          <em>Enable Versioning</em> creates a git repository in the document's
          folder. Every <kbd>⌘S</kbd> becomes a version in the History panel —
          click one to view it, restore it if needed.
        </p>
      ),
    },
    {
      title: "Review",
      search:
        "review branch merge conflicts markers reviewer second eyes edit outside",
      body: (
        <p>
          Create a review branch for a second pair of eyes. Both sides edit
          independently; <em>Merge in</em> reconciles. Conflicts appear as{" "}
          <code>&lt;&lt;&lt;</code> markers in the editor — fix them and save to
          conclude the merge. Files edited outside Liauth merge the same way,
          automatically.
        </p>
      ),
    },
    {
      title: "Notes",
      search:
        "notes annotate select criticmarkup comment resolve panel pdf export strip",
      body: (
        <p>
          Select text and press <kbd>⌘⇧M</kbd> to annotate it. Notes live in the
          markdown itself (CriticMarkup), so they version and merge like any
          edit. The Notes panel lists and resolves them; PDF export strips them.
        </p>
      ),
    },
    {
      title: "Writing",
      search:
        "writing room fullscreen typewriter scrolling toolbar rsvp speed read themes fonts zoom view menu",
      body: (
        <p>
          <kbd>⌘⇧F</kbd> enters the writing room: fullscreen, no chrome,
          typewriter scrolling (mouse to the top edge reveals the toolbar).{" "}
          <kbd>⌘⇧R</kbd> speed-reads from the cursor. Themes, fonts, and zoom
          live in the View menu.
        </p>
      ),
    },
    {
      title: "Vim",
      search:
        "vim modal editing motions registers visual mode ex commands write room rsvp " +
        "mappings vimrc config map noremap mapleader leader set options keybindings " +
        "search replace substitute regex pcre nopcre",
      body: (
        <>
          <p>
            Modal editing with motions, registers, and visual mode. Custom ex
            commands: <code>:w</code> saves and commits, <code>:room</code>{" "}
            toggles the writing room, <code>:rsvp</code> speed-reads.
          </p>
          <p>
            Replace with <code>:%s/old/new/g</code> (<code>%</code> = whole
            document; plain <code>:s</code> is the current line only). Patterns
            use JavaScript regex syntax unless you <code>set nopcre</code> in
            your vim config.
          </p>
          <p>
            Mappings load from <code>~/.config/liauth/vimrc</code> (fallback{" "}
            <code>~/.vimrc</code>): the <code>map</code>/<code>noremap</code>{" "}
            families, <code>mapleader</code>, and a few <code>set</code>{" "}
            options.
            {vimrc ? (
              <>
                {" "}
                Currently: <strong>{vimrc.applied}</strong> entries from{" "}
                <code>{vimrc.path}</code>
                {vimrc.skipped.length > 0
                  ? `, ${vimrc.skipped.length} skipped (devtools console lists why)`
                  : ""}
                .
              </>
            ) : (
              <> No vim config file found.</>
            )}
          </p>
        </>
      ),
    },
  ];

  const q = query.trim();
  const visibleSections = q
    ? sections.filter((s) => fuzzyWords(q, `${s.title} ${s.search}`) !== null)
    : sections;
  // Shortcuts filter row by row, so "zoom" finds just the zoom keys.
  const visibleShortcuts = q
    ? SHORTCUTS.filter((s) => fuzzy(q, s.label) !== null)
    : SHORTCUTS;

  return (
    <aside className="side-panel help-panel">
      <h3>Help</h3>

      <input
        className="help-search"
        type="search"
        placeholder="Search help…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) {
            e.stopPropagation();
            setQuery("");
          }
        }}
      />

      {visibleSections.map((s) => (
        <section key={s.title}>
          <h4>
            {s.title}
            {s.title === "Vim" && !vimActive
              ? " (currently off — View ▸ Vim Keybindings)"
              : ""}
          </h4>
          {s.body}
        </section>
      ))}

      {visibleShortcuts.length > 0 ? (
        <section>
          <h4>Shortcuts</h4>
          <ul className="help-keys">
            {visibleShortcuts.map((s) => (
              <li key={s.label}>
                {s.keys} <span>{s.label}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {visibleSections.length === 0 && visibleShortcuts.length === 0 ? (
        <p className="muted">Nothing matches “{query}”.</p>
      ) : null}
    </aside>
  );
}
