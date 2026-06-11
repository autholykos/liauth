/**
 * Native macOS menu bar, built with the Tauri menu API. Every item routes
 * through a single command runner, so menus, keyboard shortcuts, and the
 * command palette share one registry in App.tsx. The menu is cheap to
 * build and is simply rebuilt whenever the state it displays changes.
 */
import {
  Menu,
  Submenu,
  MenuItem,
  CheckMenuItem,
  PredefinedMenuItem,
} from "@tauri-apps/api/menu";

export interface MenuSnapshot {
  theme: string;
  font: string;
  vim: boolean;
  lineNumbers: boolean;
  room: boolean;
  versioned: boolean;
  panel: string;
  recents: string[];
}

type Run = (id: string) => void;

const sep = () => PredefinedMenuItem.new({ item: "Separator" });

export async function buildAppMenu(run: Run, s: MenuSnapshot): Promise<void> {
  const item = (id: string, text: string, accelerator?: string) =>
    MenuItem.new({ id, text, accelerator, action: () => run(id) });
  const check = (
    id: string,
    text: string,
    checked: boolean,
    accelerator?: string,
  ) =>
    CheckMenuItem.new({
      id,
      text,
      checked,
      accelerator,
      action: () => run(id),
    });

  const appMenu = await Submenu.new({
    text: "Liauth",
    items: [
      await PredefinedMenuItem.new({
        item: { About: null },
        text: "About Liauth",
      }),
      await sep(),
      await item("palette", "Command Palette…", "CmdOrCtrl+K"),
      await sep(),
      await PredefinedMenuItem.new({ item: "Hide", text: "Hide Liauth" }),
      await PredefinedMenuItem.new({ item: "HideOthers" }),
      await PredefinedMenuItem.new({ item: "ShowAll" }),
      await sep(),
      await item("quit", "Quit Liauth", "CmdOrCtrl+Q"),
    ],
  });

  const recentItems = await Promise.all(
    s.recents.map((p) =>
      MenuItem.new({
        id: `recent:${p}`,
        text: p.split("/").pop() ?? p,
        action: () => run(`recent:${p}`),
      }),
    ),
  );
  const openRecent = await Submenu.new({
    text: "Open Recent",
    items:
      recentItems.length > 0
        ? [
            ...recentItems,
            await sep(),
            await item("clear-recents", "Clear Menu"),
          ]
        : [
            await MenuItem.new({
              id: "no-recents",
              text: "No Recent Documents",
              enabled: false,
            }),
          ],
  });

  const fileMenu = await Submenu.new({
    text: "File",
    items: [
      await item("open", "Open…", "CmdOrCtrl+O"),
      openRecent,
      await sep(),
      await item("save", "Save (Commit)", "CmdOrCtrl+S"),
      await item("save-as", "Save As…", "CmdOrCtrl+Shift+S"),
      await item("reload", "Reload from Disk", "CmdOrCtrl+R"),
      await sep(),
      await item("export-pdf", "Export as PDF…", "CmdOrCtrl+Shift+E"),
    ],
  });

  const editMenu = await Submenu.new({
    text: "Edit",
    items: [
      await PredefinedMenuItem.new({ item: "Undo" }),
      await PredefinedMenuItem.new({ item: "Redo" }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
      await PredefinedMenuItem.new({ item: "Paste" }),
      await PredefinedMenuItem.new({ item: "SelectAll" }),
      await sep(),
      await item("bold", "Bold", "CmdOrCtrl+B"),
      await item("italic", "Italic", "CmdOrCtrl+I"),
      await sep(),
      await item("insert-note", "Insert Note", "CmdOrCtrl+Shift+M"),
    ],
  });

  const themeMenu = await Submenu.new({
    text: "Theme",
    items: await Promise.all(
      [
        ["paper", "Paper"],
        ["sepia", "Sepia"],
        ["dark", "Dark"],
        ["room", "Room"],
      ].map(([id, label]) => check(`theme:${id}`, label, s.theme === id)),
    ),
  });

  const fontMenu = await Submenu.new({
    text: "Font",
    items: await Promise.all(
      [
        ["serif", "Serif"],
        ["sans", "Sans"],
        ["mono", "Mono"],
      ].map(([id, label]) => check(`font:${id}`, label, s.font === id)),
    ),
  });

  const viewMenu = await Submenu.new({
    text: "View",
    items: [
      themeMenu,
      fontMenu,
      await sep(),
      await item("zoom-in", "Zoom In", "CmdOrCtrl+="),
      await item("zoom-out", "Zoom Out", "CmdOrCtrl+-"),
      await item("zoom-reset", "Actual Size", "CmdOrCtrl+0"),
      await sep(),
      await check(
        "toggle-lines",
        "Line Numbers",
        s.lineNumbers,
        "CmdOrCtrl+Shift+L",
      ),
      await check("toggle-vim", "Vim Keybindings", s.vim),
      await sep(),
      await check("toggle-room", "Writing Room", s.room, "CmdOrCtrl+Shift+F"),
      await item("rsvp", "Speed Read", "CmdOrCtrl+Shift+R"),
    ],
  });

  const documentMenu = await Submenu.new({
    text: "Document",
    items: [
      ...(s.versioned
        ? [
            await check("panel-history", "History", s.panel === "history"),
            await check("panel-review", "Review", s.panel === "review"),
            await item("new-review-branch", "New Review Branch…"),
          ]
        : [await item("enable-versioning", "Enable Versioning…")]),
      await sep(),
      await check("panel-notes", "Notes", s.panel === "notes"),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Window",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize" }),
      await PredefinedMenuItem.new({ item: "Fullscreen" }),
    ],
  });

  const helpMenu = await Submenu.new({
    text: "Help",
    items: [await item("panel-help", "Liauth Help")],
  });

  const menu = await Menu.new({
    items: [
      appMenu,
      fileMenu,
      editMenu,
      viewMenu,
      documentMenu,
      windowMenu,
      helpMenu,
    ],
  });
  await menu.setAsAppMenu();
}
