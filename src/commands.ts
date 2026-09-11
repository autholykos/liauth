export const THEMES = [
  { id: "paper", label: "Paper" },
  { id: "sepia", label: "Sepia" },
  { id: "dark", label: "Dark" },
  { id: "room", label: "Room" },
] as const;
export const FONTS = [
  { id: "serif", label: "Serif" },
  { id: "sans", label: "Sans" },
  { id: "mono", label: "Mono" },
] as const;
export type Theme = (typeof THEMES)[number]["id"];
export type FontPref = (typeof FONTS)[number]["id"];

export interface CommandSnapshot {
  theme: Theme;
  font: FontPref;
  vim: boolean;
  lineNumbers: boolean;
  spellcheck: boolean;
  pageLayout: boolean;
  novelProof: boolean;
  room: boolean;
  navOpen: boolean;
  showHiddenFiles: boolean;
  versioned: boolean;
  squashing: boolean;
  panel: string;
  recents: string[];
}

interface CommandDefinition {
  id: string;
  title: string;
  menuTitle?: string;
  accelerator?: string;
  checked?: boolean;
  palette?: boolean;
  visible?: boolean;
  fallback?: boolean;
}

const definitions = (s: CommandSnapshot) =>
  [
    { id: "open", title: "Open…", accelerator: "CmdOrCtrl+O" },
    {
      id: "open-folder",
      title: "Open Folder…",
      accelerator: "CmdOrCtrl+Shift+O",
    },
    { id: "save", title: "Save (Commit)", accelerator: "CmdOrCtrl+S" },
    { id: "save-as", title: "Save As…", accelerator: "CmdOrCtrl+Shift+S" },
    { id: "reload", title: "Reload from Disk", accelerator: "CmdOrCtrl+R" },
    {
      id: "export-pdf",
      title: s.novelProof ? "Export Novel PDF…" : "Export as PDF…",
      accelerator: "CmdOrCtrl+Shift+E",
    },
    { id: "check-updates", title: "Check for Updates…" },
    { id: "bold", title: "Bold", accelerator: "CmdOrCtrl+B" },
    { id: "italic", title: "Italic", accelerator: "CmdOrCtrl+I" },
    {
      id: "insert-note",
      title: "Insert Note",
      accelerator: "CmdOrCtrl+Shift+M",
    },
    {
      id: "insert-suggestion",
      title: "Insert Suggestion",
      accelerator: "CmdOrCtrl+Shift+U",
    },
    {
      id: "next-note",
      title: "Next Note/Suggestion",
      accelerator: "CmdOrCtrl+Shift+J",
    },
    {
      id: "toggle-room",
      title: s.room ? "Exit Writing Room" : "Enter Writing Room",
      menuTitle: "Writing Room",
      checked: s.room,
      accelerator: "CmdOrCtrl+Shift+F",
      fallback: true,
    },
    {
      id: "rsvp",
      title: "Speed Read",
      accelerator: "CmdOrCtrl+Shift+R",
      fallback: true,
    },
    {
      id: "toggle-lines",
      title: s.lineNumbers ? "Hide Line Numbers" : "Show Line Numbers",
      menuTitle: "Line Numbers",
      checked: s.lineNumbers,
      accelerator: "CmdOrCtrl+Shift+L",
    },
    {
      id: "toggle-spell",
      title: s.spellcheck ? "Disable Spell Checking" : "Enable Spell Checking",
      menuTitle: "Check Spelling",
      checked: s.spellcheck,
    },
    {
      id: "toggle-page",
      title: s.pageLayout ? "Exit Page Layout" : "Page Layout",
      menuTitle: "Page Layout",
      checked: s.pageLayout,
      accelerator: "CmdOrCtrl+Shift+P",
    },
    {
      id: "toggle-novel-proof",
      title: s.novelProof ? "Exit Novel Proof" : "Novel Proof",
      menuTitle: "Novel Proof",
      checked: s.novelProof,
    },
    {
      id: "toggle-vim",
      title: s.vim ? "Disable Vim Keybindings" : "Enable Vim Keybindings",
      menuTitle: "Vim Keybindings",
      checked: s.vim,
    },
    { id: "edit-vimrc", title: "Edit Vim Config…" },
    { id: "keylog", title: "Write Key Log" },
    {
      id: "zoom-in",
      title: "Zoom In",
      accelerator: "CmdOrCtrl+=",
      fallback: true,
    },
    {
      id: "zoom-out",
      title: "Zoom Out",
      accelerator: "CmdOrCtrl+-",
      fallback: true,
    },
    {
      id: "zoom-reset",
      title: "Actual Size",
      accelerator: "CmdOrCtrl+0",
      fallback: true,
    },
    {
      id: "toggle-nav",
      title: s.navOpen ? "Hide Files Sidebar" : "Show Files Sidebar",
      menuTitle: "Files Sidebar",
      checked: s.navOpen,
      accelerator: "CmdOrCtrl+Shift+B",
    },
    {
      id: "toggle-hidden-files",
      title: s.showHiddenFiles
        ? "Hide Hidden Files and Folders"
        : "Show Hidden Files and Folders",
      menuTitle: "Show Hidden Files and Folders",
      checked: s.showHiddenFiles,
    },
    {
      id: "panel-notes",
      title: "Toggle Notes Panel",
      menuTitle: "Notes",
      checked: s.panel === "notes",
    },
    { id: "panel-help", title: "Help", menuTitle: "Liauth Help" },
    {
      id: "panel-history",
      title: "Toggle History Panel",
      menuTitle: "History",
      checked: s.panel === "history",
      visible: s.versioned,
    },
    {
      id: "panel-review",
      title: "Toggle Branches Panel",
      menuTitle: "Branches",
      checked: s.panel === "review",
      visible: s.versioned,
    },
    { id: "new-review-branch", title: "New Branch…", visible: s.versioned },
    {
      id: "squash-recent",
      title: s.squashing
        ? "Squashing Recent Commits with Toki…"
        : "Squash Recent Commits",
      menuTitle: "Squash Recent Commits",
      visible: s.versioned,
    },
    {
      id: "enable-versioning",
      title: "Enable Versioning…",
      visible: !s.versioned,
    },
    {
      id: "palette",
      title: "Command Palette…",
      accelerator: "CmdOrCtrl+K",
      palette: false,
      fallback: true,
    },
    {
      id: "quit",
      title: "Quit Liauth",
      accelerator: "CmdOrCtrl+Q",
      palette: false,
    },
    { id: "clear-recents", title: "Clear Menu", palette: false },
  ] as const satisfies readonly CommandDefinition[];

type CommandId = ReturnType<typeof definitions>[number]["id"];
export type CommandActions = Record<CommandId, () => void> & {
  openRecent: (path: string) => void;
  theme: (theme: Theme) => void;
  font: (font: FontPref) => void;
};
export interface AppCommand extends CommandDefinition {
  run: () => void;
  shortcut?: string;
}

export function shortcutLabel(accelerator?: string): string | undefined {
  if (!accelerator) return undefined;
  const keys = accelerator.split("+");
  const key = keys[keys.length - 1].replace("=", "+").replace("-", "−");
  return `${keys.includes("Shift") ? "⇧" : ""}${keys.includes("CmdOrCtrl") ? "⌘" : ""}${key}`;
}

export function createCommands(
  s: CommandSnapshot,
  actions: CommandActions,
): AppCommand[] {
  const commands: readonly CommandDefinition[] = definitions(s);
  return [
    ...commands
      .filter((c) => c.visible !== false)
      .map((c) => ({
        ...c,
        shortcut: shortcutLabel(c.accelerator),
        run: actions[c.id as CommandId],
      })),
    ...THEMES.map((t) => ({
      id: `theme:${t.id}`,
      title: `Theme: ${t.label}`,
      menuTitle: t.label,
      checked: s.theme === t.id,
      run: () => actions.theme(t.id),
    })),
    ...FONTS.map((f) => ({
      id: `font:${f.id}`,
      title: `Font: ${f.label}`,
      menuTitle: f.label,
      checked: s.font === f.id,
      run: () => actions.font(f.id),
    })),
    ...s.recents.map((path) => ({
      id: `recent:${path}`,
      title: `Open Recent: ${path.split("/").pop()}`,
      menuTitle: path.split("/").pop() ?? path,
      run: () => actions.openRecent(path),
    })),
  ];
}

/** Window fallbacks share the native accelerator; editor keymaps stay local. */
export function fallbackCommand(
  commands: AppCommand[],
  event: KeyboardEvent,
): AppCommand | undefined {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
  return commands.find((command) => {
    if (!command.fallback || !command.accelerator) return false;
    const keys = command.accelerator.split("+");
    const key = keys[keys.length - 1].toLowerCase();
    const typed = event.key.toLowerCase();
    if ((key === "=" && typed === "+") || (key === "-" && typed === "_"))
      return true;
    return typed === key && event.shiftKey === keys.includes("Shift");
  });
}
