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

import type { AppCommand } from "./commands";

export type NavigatorFileAction =
  | "rename"
  | "cut"
  | "copy"
  | "paste"
  | "delete";

const sep = () => PredefinedMenuItem.new({ item: "Separator" });

/** Native file menu for navigator rows. Cut/copy are app-level file
 * operations, so they intentionally use regular menu items rather than the
 * predefined text-editing commands. */
export async function showNavigatorFileMenu(
  run: (action: NavigatorFileAction) => void,
  canPaste: boolean,
): Promise<void> {
  const item = (action: NavigatorFileAction, text: string) =>
    MenuItem.new({
      id: `navigator-${action}`,
      text,
      action: () => run(action),
    });
  const items = [
    await item("rename", "Rename…"),
    await sep(),
    await item("cut", "Cut"),
    await item("copy", "Copy"),
  ];
  if (canPaste) items.push(await item("paste", "Paste Here"));
  items.push(await sep(), await item("delete", "Delete"));

  const menu = await Menu.new({ items });
  try {
    await menu.popup();
  } finally {
    await menu.close().catch(() => {});
  }
}

export async function showNavigatorFolderMenu(
  toggle: () => void,
  collapsed: boolean,
  paste: (() => void) | null,
  saveAll: (() => void) | null,
): Promise<void> {
  const menu = await Menu.new({
    items: [
      await MenuItem.new({
        id: "navigator-toggle-folder",
        text: collapsed ? "Expand Folder" : "Collapse Folder",
        action: toggle,
      }),
      await sep(),
      await MenuItem.new({
        id: "navigator-folder-save-all",
        text: "Save all",
        enabled: saveAll !== null,
        action: () => saveAll?.(),
      }),
      await MenuItem.new({
        id: "navigator-folder-paste",
        text: "Paste",
        enabled: paste !== null,
        action: () => paste?.(),
      }),
    ],
  });
  try {
    await menu.popup();
  } finally {
    await menu.close().catch(() => {});
  }
}

/** Native menu for a prose selection. Rephrase captures the range before the
 * menu opens; the predefined items keep the expected text-editing actions. */
export async function showEditorSelectionMenu(
  rephrase: () => void,
): Promise<void> {
  const menu = await Menu.new({
    items: [
      await MenuItem.new({
        id: "editor-rephrase",
        text: "Rephrase with Toki…",
        action: rephrase,
      }),
      await sep(),
      await PredefinedMenuItem.new({ item: "Cut" }),
      await PredefinedMenuItem.new({ item: "Copy" }),
    ],
  });
  try {
    await menu.popup();
  } finally {
    await menu.close().catch(() => {});
  }
}

export async function buildAppMenu(
  commands: AppCommand[],
  run: (id: string) => void,
): Promise<void> {
  const registry = new Map(commands.map((command) => [command.id, command]));
  const item = (id: string) => {
    const command = registry.get(id);
    if (!command) throw new Error(`Unknown menu command: ${id}`);
    const options = {
      id,
      text: command.menuTitle ?? command.title,
      accelerator: command.accelerator,
      action: () => run(id),
    };
    return command.checked === undefined
      ? MenuItem.new(options)
      : CheckMenuItem.new({ ...options, checked: command.checked });
  };
  const items = (...ids: string[]) => Promise.all(ids.map(item));
  const category = (prefix: string) =>
    items(...commands.filter((c) => c.id.startsWith(prefix)).map((c) => c.id));
  const recentItems = await category("recent:");
  const openRecent = await Submenu.new({
    text: "Open Recent",
    items: recentItems.length
      ? [...recentItems, await sep(), await item("clear-recents")]
      : [
          await MenuItem.new({
            id: "no-recents",
            text: "No Recent Documents",
            enabled: false,
          }),
        ],
  });
  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Liauth",
        items: [
          await PredefinedMenuItem.new({
            item: { About: null },
            text: "About Liauth",
          }),
          await item("check-updates"),
          await sep(),
          await item("palette"),
          await sep(),
          await PredefinedMenuItem.new({ item: "Hide", text: "Hide Liauth" }),
          await PredefinedMenuItem.new({ item: "HideOthers" }),
          await PredefinedMenuItem.new({ item: "ShowAll" }),
          await sep(),
          await item("quit"),
        ],
      }),
      await Submenu.new({
        text: "File",
        items: [
          ...(await items("open", "open-folder")),
          openRecent,
          await sep(),
          ...(await items("save", "save-as", "reload")),
          await sep(),
          await item("export-pdf"),
        ],
      }),
      await Submenu.new({
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
          ...(await items("bold", "italic")),
          await sep(),
          ...(await items("insert-note", "insert-suggestion", "next-note")),
        ],
      }),
      await Submenu.new({
        text: "View",
        items: [
          await Submenu.new({ text: "Theme", items: await category("theme:") }),
          await Submenu.new({ text: "Font", items: await category("font:") }),
          await sep(),
          ...(await items("zoom-in", "zoom-out", "zoom-reset")),
          await sep(),
          ...(await items(
            "toggle-nav",
            "toggle-hidden-files",
            "toggle-lines",
            "toggle-spell",
            "toggle-page",
            "toggle-novel-proof",
            "toggle-vim",
            "edit-vimrc",
          )),
          await sep(),
          ...(await items("toggle-room", "rsvp")),
        ],
      }),
      await Submenu.new({
        text: "Document",
        items: [
          ...(await (registry.has("panel-history")
            ? items(
                "panel-history",
                "panel-review",
                "new-review-branch",
                "squash-recent",
              )
            : items("enable-versioning"))),
          await sep(),
          await item("panel-notes"),
        ],
      }),
      await Submenu.new({
        text: "Window",
        items: [
          await PredefinedMenuItem.new({ item: "Minimize" }),
          await PredefinedMenuItem.new({ item: "Fullscreen" }),
        ],
      }),
      await Submenu.new({ text: "Help", items: await items("panel-help") }),
    ],
  });
  await menu.setAsAppMenu();
}
