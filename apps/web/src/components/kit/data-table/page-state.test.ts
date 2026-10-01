import {
  type ColumnDef,
  type PaginationState,
  type TableOptions,
  type Updater,
  createTable,
  functionalUpdate,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
} from "@tanstack/react-table";
import { describe, expect, it } from "vitest";

import { TABLE_DEFAULTS, clampPageIndex, hasStaleError, samePage, sameState } from "./state.js";

interface Item {
  id: string;
  size: number;
}

const COLUMNS: ColumnDef<Item>[] = [{ accessorKey: "size", header: "Size" }];

function items(total: number): Item[] {
  return Array.from({ length: total }, (_, index) => ({ id: String(index), size: index }));
}

/** Lets TanStack's queued work (it defers state resets to a microtask) run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A client-paginated TanStack table on page 3, driven the way the kit drives
 * it (controlled pagination state). Returns every pagination change TanStack
 * asks for and a way to hand the table a new `data` array, as a refetch does.
 */
function tableOnPage3(extra: Partial<TableOptions<Item>>) {
  const pagination: PaginationState = { pageIndex: 2, pageSize: 10 };
  const requested: PaginationState[] = [];
  const table = createTable<Item>({
    data: items(50),
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: {},
    onStateChange: () => {},
    renderFallbackValue: null,
    ...extra,
  });
  const apply = (data: Item[]) => {
    table.setOptions((previous) => ({
      ...previous,
      data,
      state: { ...table.initialState, pagination },
      onPaginationChange: (updater: Updater<PaginationState>) => {
        requested.push(functionalUpdate(updater, pagination));
      },
    }));
    table.getRowModel();
  };
  return { requested, apply };
}

describe("client pagination across refetches", () => {
  it("TanStack's default would send the table back to page 1 on new data", async () => {
    const { requested, apply } = tableOnPage3({});
    apply(items(50));
    await settle();
    apply(items(50));
    await settle();
    expect(requested).toEqual([{ pageIndex: 0, pageSize: 10 }]);
  });

  it("the kit's defaults keep the open page when data changes", async () => {
    const { requested, apply } = tableOnPage3(TABLE_DEFAULTS);
    apply(items(50));
    await settle();
    apply(items(50));
    await settle();
    apply(items(49));
    await settle();
    expect(requested).toEqual([]);
  });
});

describe("page helpers", () => {
  it("lands on the last page that still exists", () => {
    expect(clampPageIndex(2, 5)).toBe(2);
    expect(clampPageIndex(4, 3)).toBe(2);
    expect(clampPageIndex(3, 0)).toBe(0);
    expect(clampPageIndex(-1, 3)).toBe(0);
  });

  it("compares pages by index and size", () => {
    expect(samePage({ pageIndex: 1, pageSize: 25 }, { pageIndex: 1, pageSize: 25 })).toBe(true);
    expect(samePage({ pageIndex: 1, pageSize: 25 }, { pageIndex: 0, pageSize: 25 })).toBe(false);
    expect(samePage({ pageIndex: 1, pageSize: 25 }, { pageIndex: 1, pageSize: 50 })).toBe(false);
  });

  it("compares sorting and filter state by value", () => {
    expect(sameState([{ id: "size", desc: true }], [{ id: "size", desc: true }])).toBe(true);
    expect(sameState([{ id: "size", desc: true }], [{ id: "size", desc: false }])).toBe(false);
    expect(sameState([], [])).toBe(true);
    expect(sameState([{ id: "status", value: ["failed"] }], [])).toBe(false);
  });

  it("reports a stale error only after a successful load", () => {
    expect(hasStaleError(true, new Error("down"))).toBe(true);
    expect(hasStaleError(false, new Error("down"))).toBe(false);
    expect(hasStaleError(true, null)).toBe(false);
    expect(hasStaleError(true, undefined)).toBe(false);
  });
});
