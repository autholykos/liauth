import { describe, expect, it, vi } from "vitest";
import {
  createCommands,
  fallbackCommand,
  type CommandActions,
  type CommandSnapshot,
} from "../src/commands";
import { buildAppMenu, showNavigatorFolderMenu } from "../src/menu";
import { Menu } from "@tauri-apps/api/menu";

vi.mock("@tauri-apps/api/menu", () => {
  const factory = {
    new: vi.fn(async (options) => ({
      ...options,
      setAsAppMenu: vi.fn(),
      popup: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    })),
  };
  return {
    Menu: { ...factory },
    Submenu: factory,
    MenuItem: factory,
    CheckMenuItem: factory,
    PredefinedMenuItem: factory,
  };
});

const snapshot: CommandSnapshot = {
  theme: "paper",
  font: "serif",
  vim: false,
  lineNumbers: false,
  spellcheck: true,
  pageLayout: false,
  adaptiveLayout: true,
  novelProof: false,
  markdownPreview: false,
  readOnly: false,
  room: false,
  navOpen: false,
  showHiddenFiles: false,
  versioned: false,
  squashing: false,
  panel: "none",
  recents: ["/novel/chapter.md"],
};

describe("shared commands", () => {
  it("disables editing actions in the native menu and command registry while reading", async () => {
    const edit = vi.fn();
    const actions = new Proxy({}, { get: () => edit }) as CommandActions;
    const commands = createCommands(
      { ...snapshot, markdownPreview: true, readOnly: true },
      actions,
    );
    await buildAppMenu(commands, (id) =>
      commands.find((command) => command.id === id)!.run(),
    );
    const flatten = (items: any[]): any[] =>
      items.flatMap((item) => [item, ...flatten(item.items ?? [])]);
    const menu = flatten(
      vi.mocked(Menu.new).mock.calls.at(-1)![0]!.items as any[],
    );
    for (const id of ["bold", "italic", "insert-note", "insert-suggestion"]) {
      const command = commands.find((command) => command.id === id)!;
      expect(command.enabled).toBe(false);
      expect(menu.find((item) => item.id === id).enabled).toBe(false);
      command.run();
    }
    expect(edit).not.toHaveBeenCalled();
    expect(
      menu.find((item) => item.id === "toggle-markdown-preview").checked,
    ).toBe(true);
  });

  it("offers Save all in the native folder menu and disables it while busy", async () => {
    const save = vi.fn();
    await showNavigatorFolderMenu(() => {}, false, null, save);
    const items = vi.mocked(Menu.new).mock.calls.at(-1)![0]!.items as any[];
    const item = items.find((item) => item.id === "navigator-folder-save-all");
    expect(item.text).toBe("Save all");
    expect(item.enabled).toBe(true);
    item.action();
    expect(save).toHaveBeenCalledOnce();
    await showNavigatorFolderMenu(() => {}, false, null, null);
    const disabled = (
      vi.mocked(Menu.new).mock.calls.at(-1)![0]!.items as any[]
    ).find((item) => item.id === "navigator-folder-save-all");
    expect(disabled.enabled).toBe(false);
  });
  it("uses the same command through menu, palette and keyboard fallback", async () => {
    const room = vi.fn();
    const actions = new Proxy(
      {},
      { get: (_, key) => (key === "toggle-room" ? room : vi.fn()) },
    ) as CommandActions;
    const commands = createCommands(snapshot, actions);
    const run = (id: string) =>
      commands.find((command) => command.id === id)!.run();
    await buildAppMenu(commands, run);
    const menuItems = vi
      .mocked(Menu.new)
      .mock.calls.flatMap(([options]) => options?.items ?? []) as any[];
    const flatten = (items: any[]): any[] =>
      items.flatMap((item) => [item, ...flatten(item.items ?? [])]);
    const item = flatten(menuItems).find((item) => item.id === "toggle-room");
    expect(item.text).toBe("Writing Room");
    expect(item.checked).toBe(false);
    item.action();
    const palette = commands.find((command) => command.id === "toggle-room")!;
    expect(palette.title).toBe("Enter Writing Room");
    expect(palette.shortcut).toBe("⇧⌘F");
    palette.run();
    fallbackCommand(
      commands,
      new KeyboardEvent("keydown", { key: "F", metaKey: true, shiftKey: true }),
    )!.run();
    expect(room).toHaveBeenCalledTimes(3);
    expect(
      fallbackCommand(
        commands,
        new KeyboardEvent("keydown", { key: "f", metaKey: true }),
      ),
    ).toBeUndefined();
    expect(
      fallbackCommand(
        commands,
        new KeyboardEvent("keydown", {
          key: "F",
          metaKey: true,
          shiftKey: true,
          altKey: true,
        }),
      ),
    ).toBeUndefined();
  });

  it("derives dynamic labels, versioning commands and contextual actions", async () => {
    const recent = vi.fn();
    const theme = vi.fn();
    const actions = new Proxy(
      {},
      {
        get: (_, key) =>
          key === "openRecent" ? recent : key === "theme" ? theme : vi.fn(),
      },
    ) as CommandActions;
    const commands = createCommands(
      { ...snapshot, room: true, versioned: true, squashing: true },
      actions,
    );
    expect(commands.find((c) => c.id === "toggle-room")?.title).toBe(
      "Exit Writing Room",
    );
    expect(commands.find((c) => c.id === "squash-recent")?.title).toContain(
      "Squashing",
    );
    expect(commands.some((c) => c.id === "enable-versioning")).toBe(false);
    commands.find((c) => c.id === "recent:/novel/chapter.md")!.run();
    commands.find((c) => c.id === "theme:dark")!.run();
    expect(recent).toHaveBeenCalledWith("/novel/chapter.md");
    expect(theme).toHaveBeenCalledWith("dark");
    await expect(buildAppMenu(commands, () => {})).resolves.toBeUndefined();
    for (const key of ["+", "="]) {
      expect(
        fallbackCommand(
          commands,
          new KeyboardEvent("keydown", { key, ctrlKey: true }),
        )?.id,
      ).toBe("zoom-in");
    }
    expect(
      fallbackCommand(
        commands,
        new KeyboardEvent("keydown", {
          key: "R",
          metaKey: true,
          shiftKey: true,
        }),
      )?.id,
    ).toBe("rsvp");
  });
});
