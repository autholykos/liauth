import { VimrcSummary } from "./editor/vimrc";

interface Props {
  vimActive: boolean;
  vimrc: VimrcSummary | null;
}

export function HelpPanel({ vimActive, vimrc }: Props) {
  return (
    <aside className="side-panel help-panel">
      <h3>Help</h3>

      <section>
        <h4>Documents</h4>
        <p>
          Documents are plain <code>.md</code> files — usable with any other
          tool. The buffer autosaves to disk when you switch apps (and when
          leaving vim insert mode). <kbd>⌘S</kbd> is more: it{" "}
          <em>commits a version</em>.
        </p>
      </section>

      <section>
        <h4>Versioning</h4>
        <p>
          <em>Enable Versioning</em> creates a git repository in the
          document's folder. Every <kbd>⌘S</kbd> becomes a version in the
          History panel — click one to view it, restore it if needed.
        </p>
      </section>

      <section>
        <h4>Review</h4>
        <p>
          Create a review branch for a second pair of eyes. Both sides edit
          independently; <em>Merge in</em> reconciles. Conflicts appear as{" "}
          <code>&lt;&lt;&lt;</code> markers in the editor — fix them and save
          to conclude the merge. Files edited outside Liauth merge the same
          way, automatically.
        </p>
      </section>

      <section>
        <h4>Notes</h4>
        <p>
          Select text and press <kbd>⌘⇧M</kbd> to annotate it. Notes live in
          the markdown itself (CriticMarkup), so they version and merge like
          any edit. The Notes panel lists and resolves them; PDF export strips
          them.
        </p>
      </section>

      <section>
        <h4>Writing</h4>
        <p>
          <kbd>⌘⇧F</kbd> enters the writing room: fullscreen, no chrome,
          typewriter scrolling (mouse to the top edge reveals the toolbar).{" "}
          <kbd>⌘⇧R</kbd> speed-reads from the cursor. Themes, fonts, and zoom
          live in the View menu.
        </p>
      </section>

      <section>
        <h4>Shortcuts</h4>
        <ul className="help-keys">
          <li>
            <kbd>⌘K</kbd> <span>command palette</span>
          </li>
          <li>
            <kbd>⌘S</kbd> <span>save (commit)</span>
          </li>
          <li>
            <kbd>⌘B</kbd> / <kbd>⌘I</kbd> <span>bold / italic</span>
          </li>
          <li>
            <kbd>⌘⇧M</kbd> <span>insert note</span>
          </li>
          <li>
            <kbd>⌘⇧F</kbd> <span>writing room</span>
          </li>
          <li>
            <kbd>⌘⇧R</kbd> <span>speed read</span>
          </li>
          <li>
            <kbd>⌘+</kbd> / <kbd>⌘−</kbd> / <kbd>⌘0</kbd> <span>zoom</span>
          </li>
          <li>
            <kbd>⌘R</kbd> <span>reload from disk</span>
          </li>
        </ul>
      </section>

      <section>
        <h4>Vim {vimActive ? "" : "(currently off — View ▸ Vim Keybindings)"}</h4>
        <p>
          Modal editing with motions, registers, and visual mode. Custom ex
          commands: <code>:w</code> saves and commits, <code>:room</code>{" "}
          toggles the writing room, <code>:rsvp</code> speed-reads.
        </p>
        <p>
          Mappings load from <code>~/.config/liauth/vimrc</code> (fallback{" "}
          <code>~/.vimrc</code>): the <code>map</code>/<code>noremap</code>{" "}
          families, <code>mapleader</code>, and a few <code>set</code> options.
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
      </section>
    </aside>
  );
}
