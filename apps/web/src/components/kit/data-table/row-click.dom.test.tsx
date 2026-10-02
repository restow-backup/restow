// @vitest-environment happy-dom
import type { ColumnDef } from "@tanstack/react-table";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { DataTable } from "./data-table.js";

/**
 * A clickable row (`onRowClick`): the click anywhere on the row opens it, a
 * control inside the row keeps its own click, and a table without the prop has
 * rows that do not look clickable.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Tenant {
  id: string;
  name: string;
}

const DATA: Tenant[] = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

const opened = vi.fn();
const named = vi.fn();

const COLUMNS: ColumnDef<Tenant>[] = [
  {
    id: "name",
    header: "Name",
    cell: ({ row }) => (
      <button type="button" data-testid="name" onClick={() => named(row.original.id)}>
        {row.original.name}
      </button>
    ),
  },
  { id: "id", accessorKey: "id", header: "Id" },
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
  named.mockReset();
});

async function mount(onRowClick?: (tenant: Tenant) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <DataTable
          id="rc"
          columns={COLUMNS}
          data={DATA}
          getRowId={(r) => r.id}
          onRowClick={onRowClick}
        />
      </I18nextProvider>,
    );
  });
}

const rows = () => [...document.querySelectorAll("tbody tr")];

describe("onRowClick", () => {
  it("opens the row clicked, with its data, and makes the rows look clickable", async () => {
    await mount((tenant) => opened(tenant.id));
    expect(rows()[0]?.className).toContain("cursor-pointer");
    await act(async () => {
      (rows()[1]?.querySelectorAll("td")[1] as HTMLElement).click();
    });
    expect(opened).toHaveBeenCalledWith("b");
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("leaves a control inside the row its own click", async () => {
    await mount((tenant) => opened(tenant.id));
    await act(async () => {
      (rows()[0]?.querySelector('[data-testid="name"]') as HTMLElement).click();
    });
    expect(named).toHaveBeenCalledWith("a");
    expect(opened).not.toHaveBeenCalled();
  });

  it("makes no row look clickable without the prop", async () => {
    await mount();
    expect(rows()[0]?.className ?? "").not.toContain("cursor-pointer");
    await act(async () => {
      (rows()[0]?.querySelectorAll("td")[1] as HTMLElement).click();
    });
    expect(opened).not.toHaveBeenCalled();
  });
});
