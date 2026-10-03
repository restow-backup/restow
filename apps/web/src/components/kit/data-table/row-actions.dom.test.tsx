// @vitest-environment happy-dom
import type { ColumnDef } from "@tanstack/react-table";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { DataTable } from "./data-table.js";
import { isContextMenuKey, rowActionsColumn, wantsNativeMenu } from "./row-actions.js";

/**
 * The row actions of the data table: the same entries as the "…" menu open as the context menu of
 * the row, with a right click or from the keyboard (the context menu key, Shift+F10) wherever the
 * focus is in the row; links and selected text keep the browser's own menu; a selected row among
 * several offers what can be done with the whole selection, and the selection bar shows it too.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Machine {
  id: string;
  name: string;
}

const DATA: Machine[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Bravo" },
  { id: "c", name: "Charlie" },
];

const opened = vi.fn();
const removed = vi.fn();
const fromSelection = vi.fn();

const COLUMNS: ColumnDef<Machine>[] = [
  {
    id: "name",
    accessorKey: "name",
    header: "Name",
    cell: ({ row }) => (
      <span>
        <button type="button" data-testid={`name-${row.original.id}`}>
          {row.original.name}
        </button>{" "}
        <a href={`/machines/${row.original.id}`} data-testid={`link-${row.original.id}`}>
          details
        </a>
      </span>
    ),
  },
  rowActionsColumn<Machine>({
    name: (machine) => machine.name,
    actions: (machine) => [
      { id: "open", label: "Open machine", onSelect: () => opened(machine.id) },
      {
        id: "backup",
        label: "Back up now",
        disabled: true,
        reason: "The machine is in no backup job.",
        onSelect: () => {},
      },
      {
        id: "remove",
        label: "Remove",
        destructive: true,
        onSelect: () => removed(machine.id),
      },
    ],
    selectionActions: (machines) => [
      {
        id: "newJob",
        label: `New job from ${machines.length} machines`,
        onSelect: () => fromSelection(machines.map((machine) => machine.id)),
      },
    ],
  }),
];

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  opened.mockReset();
  removed.mockReset();
  fromSelection.mockReset();
  window.getSelection()?.removeAllRanges();
  for (const node of document.body.querySelectorAll("[data-radix-popper-content-wrapper]")) {
    node.remove();
  }
});

async function mount(selectable = false) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <DataTable
          id="row-actions-test"
          columns={COLUMNS}
          data={DATA}
          getRowId={(machine) => machine.id}
          selectable={selectable}
        />
      </I18nextProvider>,
    );
  });
}

const rows = () => [...document.querySelectorAll<HTMLElement>("tbody tr")];
const menu = () => document.querySelector<HTMLElement>('[data-slot="row-context-menu"]');
const entries = () =>
  [...(menu()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].map((item) =>
    item.textContent?.trim(),
  );

async function rightClick(target: Element, init: MouseEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: 20,
        clientY: 20,
        ...init,
      }),
    );
  });
}

async function press(target: HTMLElement, init: KeyboardEventInit) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}

describe("the context menu of a row", () => {
  it("opens on a right click with the row's actions, the destructive one last", async () => {
    await mount();
    await rightClick(rows()[1]?.querySelector("td") as HTMLElement);
    expect(menu()).not.toBeNull();
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for Bravo");
    expect(entries()).toEqual([
      "Open machine",
      "Back up nowThe machine is in no backup job.",
      "Remove",
    ]);
    // The disabled entry says why, and names the reason for assistive technology.
    const backup = menu()?.querySelector<HTMLElement>('[data-action="backup"]');
    expect(backup?.hasAttribute("data-disabled")).toBe(true);
    const reasonId = backup?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe("The machine is in no backup job.");
    expect(rows()[1]?.getAttribute("data-state")).toBe("open");

    await act(async () => {
      menu()?.querySelector<HTMLElement>('[data-action="open"]')?.click();
    });
    expect(opened).toHaveBeenCalledWith("b");
  });

  it("offers the same entries as the … menu", async () => {
    await mount();
    const trigger = rows()[0]?.querySelector<HTMLElement>('[data-slot="row-actions-trigger"]');
    expect(trigger?.getAttribute("aria-label")).toBe("Actions for Alpha");
    await rightClick(rows()[0]?.querySelector("td") as HTMLElement);
    expect(entries()).toHaveLength(3);
  });

  it("opens from the keyboard: the context menu key or Shift+F10 where the focus is", async () => {
    await mount();
    const name = rows()[2]?.querySelector<HTMLElement>('[data-testid="name-c"]') as HTMLElement;
    await press(name, { key: "F10", shiftKey: true });
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for Charlie");
    await act(async () => {
      menu()?.querySelector<HTMLElement>('[data-action="remove"]')?.click();
    });
    expect(removed).toHaveBeenCalledWith("c");

    await press(name, { key: "ContextMenu" });
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for Charlie");
  });

  it("leaves links, selected text and Shift with a right click to the browser", async () => {
    await mount();
    await rightClick(rows()[0]?.querySelector('[data-testid="link-a"]') as HTMLElement);
    expect(menu()).toBeNull();
    await rightClick(rows()[0]?.querySelector("td") as HTMLElement, { shiftKey: true });
    expect(menu()).toBeNull();

    const text = rows()[0]?.querySelector('[data-testid="name-a"]')?.firstChild as Node;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 3);
    window.getSelection()?.addRange(range);
    await rightClick(rows()[0]?.querySelector("td") as HTMLElement);
    expect(menu()).toBeNull();
  });
});

describe("a selection of rows", () => {
  it("offers the selection's actions on a selected row and in the bar, the row's own elsewhere", async () => {
    await mount(true);
    const boxes = () => rows().map((row) => row.querySelector<HTMLElement>('[role="checkbox"]'));
    expect(boxes()[0]?.getAttribute("aria-label")).toBe("Select Alpha");
    await act(async () => {
      boxes()[0]?.click();
    });
    await act(async () => {
      boxes()[2]?.click();
    });
    expect(rows()[0]?.getAttribute("data-selected")).toBe("true");
    expect(rows()[1]?.hasAttribute("data-selected")).toBe(false);

    const bar = document.querySelector<HTMLElement>('[data-slot="data-table-selection"]');
    expect(bar?.textContent).toContain("2 rows selected");
    expect(bar?.querySelector('[data-action="newJob"]')?.textContent).toBe(
      "New job from 2 machines",
    );

    await rightClick(rows()[2]?.querySelector("td + td") as HTMLElement);
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for 2 selected rows");
    expect(entries()).toEqual(["New job from 2 machines"]);
    await act(async () => {
      menu()?.querySelector<HTMLElement>('[data-action="newJob"]')?.click();
    });
    expect(fromSelection).toHaveBeenCalledWith(["a", "c"]);

    await rightClick(rows()[1]?.querySelector("td + td") as HTMLElement);
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for Bravo");
    expect(entries()[0]).toBe("Open machine");

    await act(async () => {
      [...(bar?.querySelectorAll("button") ?? [])]
        .find((button) => button.textContent === "Clear selection")
        ?.click();
    });
    expect(document.querySelector('[data-slot="data-table-selection"]')).toBeNull();
  });
});

describe("which events open the row's menu", () => {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  const link = document.createElement("a");
  link.href = "/x";
  row.append(cell);
  cell.append(link);
  const noSelection = { isCollapsed: true, rangeCount: 0, getRangeAt: () => new Range() };

  it("keeps the browser's menu for links, fields and Shift, never from the keyboard", () => {
    expect(wantsNativeMenu({ button: 2, shiftKey: false, target: cell }, row, noSelection)).toBe(
      false,
    );
    expect(wantsNativeMenu({ button: 2, shiftKey: false, target: link }, row, noSelection)).toBe(
      true,
    );
    expect(wantsNativeMenu({ button: 2, shiftKey: true, target: cell }, row, noSelection)).toBe(
      true,
    );
    // A menu raised from the keyboard (button 0) is always the row's.
    expect(wantsNativeMenu({ button: 0, shiftKey: false, target: link }, row, noSelection)).toBe(
      false,
    );
  });

  it("knows the keys that ask for a context menu", () => {
    expect(isContextMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isContextMenuKey({ key: "F10", shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: "F10", shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ key: "Enter", shiftKey: true })).toBe(false);
  });
});
