import type { ColumnDef, VisibilityState } from "@tanstack/react-table";
import { Trash2 } from "lucide-react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { count, render } from "../test-utils.js";
import {
  columnVisibilityKey,
  mergeVisibility,
  readColumnVisibility,
  rememberedFor,
  sanitizeVisibility,
  writeColumnVisibility,
} from "./column-visibility.js";
import { rowActionsColumn } from "./columns.js";
import { DataTable } from "./data-table.js";
import { ariaSortFor, bodyState, hideableColumnIds, pageRange } from "./state.js";

interface Job {
  id: string;
  name: string;
  size: number;
  status: string;
}

const COLUMNS: ColumnDef<Job>[] = [
  { accessorKey: "name", header: "Name" },
  { accessorKey: "size", header: "Size", meta: { numeric: true } },
  { accessorKey: "status", header: "Status", enableSorting: false },
  rowActionsColumn<Job>({
    actions: () => [
      { id: "open", label: "Open", onSelect: () => {} },
      { id: "delete", label: "Delete", icon: Trash2, destructive: true, onSelect: () => {} },
    ],
    name: (job) => job.name,
  }),
];

const JOBS: Job[] = [
  { id: "2", name: "Bravo", size: 20, status: "done" },
  { id: "1", name: "Alpha", size: 10, status: "failed" },
];

function many(total: number): Job[] {
  return Array.from({ length: total }, (_, index) => ({
    id: String(index),
    name: `Job ${String(index).padStart(3, "0")}`,
    size: index,
    status: "done",
  }));
}

/** Body rows only (the header row is inside <thead>). */
function bodyRows(html: string): number {
  const body = html.slice(html.indexOf("<tbody"));
  return count(body, 'data-slot="table-row"');
}

/** The opening tag of the header cell that contains `label`. */
function headerCell(html: string, label: string): string {
  const cells = html.match(/<th\b[^>]*>.*?<\/th>/g) ?? [];
  const cell = cells.find((candidate) => candidate.includes(`>${label}<`));
  if (!cell) {
    throw new Error(`no header cell for ${label}`);
  }
  return cell.slice(0, cell.indexOf(">") + 1);
}

const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

function useStorage(storage: unknown): void {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get: () => storage,
  });
}

function mapStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  if (storageDescriptor) {
    Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

describe("DataTable states", () => {
  it("shows skeleton rows while the first load runs", () => {
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={undefined} loading />);
    // Five rows, one skeleton per column except the actions column.
    expect(count(html, 'data-slot="skeleton"')).toBe(5 * 3);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading entries …");
  });

  it("keeps loaded rows during a refetch instead of flashing skeletons", () => {
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} loading fetching />);
    expect(count(html, 'data-slot="skeleton"')).toBe(0);
    expect(bodyRows(html)).toBe(2);
    expect(html).toContain('aria-busy="true"');
  });

  it("shows the default empty state, or the one the page brings", () => {
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={[]} />);
    expect(html).toContain("No entries yet");
    expect(html).not.toContain("No matching entries");

    const custom = render(
      <DataTable id="jobs" columns={COLUMNS} data={[]} empty={<p>No backup jobs yet</p>} />,
    );
    expect(custom).toContain("No backup jobs yet");
    expect(custom).not.toContain("No entries yet");
  });

  it("tells filtered-empty apart from empty and offers a reset", () => {
    const html = render(
      <DataTable id="jobs" columns={COLUMNS} data={[]} filtered onResetFilters={() => {}} />,
    );
    expect(html).toContain("No matching entries");
    expect(html).toContain("Reset filters");
    expect(html).not.toContain("No entries yet");

    const custom = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={[]}
        filtered
        filteredEmpty={<p>No job matches</p>}
      />,
    );
    expect(custom).toContain("No job matches");
  });

  it("replaces the body with the cause and a retry when nothing loaded", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={undefined}
        error={new Error("boom")}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The list could not be loaded");
    expect(html).toContain("Retry");
    expect(bodyRows(html)).toBe(1);
  });

  it("keeps stale rows visible and says they are stale", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={JOBS}
        error={new Error("boom")}
        onRetry={() => {}}
      />,
    );
    expect(bodyRows(html)).toBe(2);
    expect(html).toContain("The list could not be refreshed");
    expect(html).not.toContain("The list could not be loaded");
    // The retry matches ErrorState's: icon and label.
    expect(html).toContain("lucide-rotate-cw");
  });

  it("says a refresh failed when the last load was empty", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={[]}
        error={new Error("boom")}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("The list could not be refreshed");
    expect(html).toContain("No entries yet");
    expect(html).toContain("Retry");
    expect(html).not.toContain("The list could not be loaded");
  });

  it("says a refresh failed when filters hide every row", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={[]}
        filtered
        onResetFilters={() => {}}
        error={new Error("boom")}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("The list could not be refreshed");
    expect(html).toContain("No matching entries");
  });

  it("does not warn about stale data while nothing failed", () => {
    expect(render(<DataTable id="jobs" columns={COLUMNS} data={[]} />)).not.toContain(
      "could not be refreshed",
    );
    expect(
      render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} error={null} />),
    ).not.toContain("could not be refreshed");
  });

  it("keeps one live region mounted and changes only its text", () => {
    const region = /<p[^>]*aria-live="polite"[^>]*>(.*?)<\/p>/;
    const loading = render(<DataTable id="jobs" columns={COLUMNS} data={undefined} loading />);
    expect(loading.match(region)?.[1]).toBe("Loading entries …");
    const loaded = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(loaded.match(region)?.[1]).toBe("");
  });
});

describe("DataTable sorting", () => {
  it("sets aria-sort on sortable headers only", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={JOBS}
        sorting={{ mode: "client", initial: [{ id: "name", desc: false }] }}
      />,
    );
    expect(headerCell(html, "Name")).toContain('aria-sort="ascending"');
    expect(headerCell(html, "Size")).toContain('aria-sort="none"');
    expect(headerCell(html, "Status")).not.toContain("aria-sort");
    expect(html).toContain('aria-label="Sort by Name"');
    // Sorted in the browser: Alpha before Bravo.
    expect(html.indexOf("Alpha")).toBeLessThan(html.indexOf("Bravo"));
  });

  it("follows the server's sort state in manual mode without reordering", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={JOBS}
        sorting={{ mode: "manual", state: [{ id: "size", desc: true }], onChange: () => {} }}
        pagination={{ mode: "manual", pageIndex: 0, pageSize: 25, rowCount: 2, onChange: () => {} }}
      />,
    );
    expect(headerCell(html, "Size")).toContain('aria-sort="descending"');
    expect(html.indexOf("Bravo")).toBeLessThan(html.indexOf("Alpha"));
  });

  it("does not offer browser sorting for server-driven lists", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={JOBS}
        pagination={{ mode: "loadMore", hasMore: true, onLoadMore: () => {} }}
      />,
    );
    expect(html).not.toContain("aria-sort");
  });
});

describe("DataTable cells and footer", () => {
  it("renders numeric columns right-aligned in tabular numbers", () => {
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).toMatch(/<td[^>]*class="[^"]*tabular-nums[^"]*"[^>]*>20<\/td>/);
    expect(headerCell(html, "Size")).toContain("text-right");
  });

  it("renders the row actions menu with the row name", () => {
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).toContain('aria-label="Actions for Alpha"');
    expect(html).toContain("sticky top-0");
  });

  it("paginates in the browser", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={many(30)}
        pagination={{ mode: "client", pageSize: 10 }}
      />,
    );
    expect(bodyRows(html)).toBe(10);
    expect(html).toContain("1–10 of 30");
    expect(html).toContain("Page 1 of 3");
  });

  it("shows the server's range in manual pagination", () => {
    const html = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={many(25)}
        pagination={{
          mode: "manual",
          pageIndex: 1,
          pageSize: 25,
          rowCount: 120,
          onChange: () => {},
        }}
      />,
    );
    expect(bodyRows(html)).toBe(25);
    expect(html).toContain("26–50 of 120");
    expect(html).toContain("Page 2 of 5");
  });

  it("offers load-more for cursor lists and says when everything is shown", () => {
    const more = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={JOBS}
        pagination={{ mode: "loadMore", hasMore: true, onLoadMore: () => {} }}
      />,
    );
    expect(more).toContain("Load more");
    expect(more).toContain("2 entries shown");

    const all = render(
      <DataTable
        id="jobs"
        columns={COLUMNS}
        data={JOBS}
        pagination={{ mode: "loadMore", hasMore: false, onLoadMore: () => {} }}
      />,
    );
    expect(all).not.toContain("Load more");
    expect(all).toContain("All 2 entries shown");
  });
});

describe("DataTable column visibility", () => {
  it("applies the remembered visibility of this table", () => {
    useStorage(mapStorage({ [columnVisibilityKey("jobs")]: JSON.stringify({ size: false }) }));
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).not.toContain(">Size<");
    expect(html).toContain(">Name<");
    expect(html).toContain("Columns");
  });

  it("never hides a column that cannot be shown again", () => {
    useStorage(mapStorage({ [columnVisibilityKey("jobs")]: JSON.stringify({ actions: false }) }));
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).toContain('aria-label="Actions for Alpha"');
  });

  it("renders every column when storage throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError: storage is disabled");
      },
    });
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).toContain(">Name<");
    expect(html).toContain(">Size<");
    expect(html).toContain(">Status<");
  });

  it("survives a storage whose methods throw", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota exceeded");
      },
    };
    expect(readColumnVisibility("jobs", broken)).toEqual({});
    expect(() => writeColumnVisibility("jobs", { size: false }, broken)).not.toThrow();
    expect(readColumnVisibility("jobs", null)).toEqual({});
  });

  it("ignores malformed stored values", () => {
    const key = columnVisibilityKey("jobs");
    expect(readColumnVisibility("jobs", mapStorage({ [key]: "{not json" }))).toEqual({});
    expect(readColumnVisibility("jobs", mapStorage({ [key]: "[false]" }))).toEqual({});
    expect(
      readColumnVisibility("jobs", mapStorage({ [key]: JSON.stringify({ a: false, b: "no" }) })),
    ).toEqual({ a: false });
  });

  it("round-trips per table id", () => {
    const storage = mapStorage();
    writeColumnVisibility("jobs", { size: false }, storage);
    expect(readColumnVisibility("jobs", storage)).toEqual({ size: false });
    expect(readColumnVisibility("other", storage)).toEqual({});
    expect(storage.map.has("restow.table.jobs.columns")).toBe(true);
  });

  it("keeps only hideable columns", () => {
    const hideable = hideableColumnIds(COLUMNS);
    expect([...hideable].sort()).toEqual(["name", "size", "status"]);
    expect(sanitizeVisibility({ size: false, actions: false, gone: false }, hideable)).toEqual({
      size: false,
    });
  });

  it("treats a column without a name as not hideable, like the columns menu", () => {
    const columns: ColumnDef<Job>[] = [
      { accessorKey: "name", header: "Name" },
      // A rendered header without meta.label has no entry in the columns menu.
      { accessorKey: "status", header: () => <span>State</span> },
      { accessorKey: "size", header: () => <span>Bytes</span>, meta: { label: "Size" } },
    ];
    expect([...hideableColumnIds(columns)].sort()).toEqual(["name", "size"]);

    useStorage(
      mapStorage({ [columnVisibilityKey("jobs")]: JSON.stringify({ status: false, size: false }) }),
    );
    const html = render(<DataTable id="jobs" columns={columns} data={JOBS} />);
    expect(html).toContain("<span>State</span>");
    expect(html).not.toContain("<span>Bytes</span>");
  });

  it("remembers leaf columns inside header groups, like the columns menu", () => {
    const columns: ColumnDef<Job>[] = [
      { accessorKey: "name", header: "Name" },
      {
        id: "details",
        header: "Details",
        columns: [
          { accessorKey: "size", header: "Size" },
          { accessorKey: "status", header: "Status", enableHiding: false },
        ],
      },
    ];
    // The group itself is not a menu entry; its hideable leaves are.
    expect([...hideableColumnIds(columns)].sort()).toEqual(["name", "size"]);

    useStorage(mapStorage({ [columnVisibilityKey("jobs")]: JSON.stringify({ size: false }) }));
    const html = render(<DataTable id="jobs" columns={columns} data={JOBS} />);
    expect(html).not.toContain(">Size<");
    expect(html).toContain(">Status<");
    expect(html).toContain(">Details<");
  });

  it("keeps remembered entries of columns that are not listed right now", () => {
    const listed = new Set(["name", "size"]);
    // "archive" is shown only on some installations: not listed now, but remembered.
    const remembered = { archive: false, size: true };
    expect(sanitizeVisibility(remembered, listed)).toEqual({ size: true });
    const next = mergeVisibility(remembered, { name: true, size: false }, listed);
    expect(next).toEqual({ archive: false, name: true, size: false });
    // Once the column is listed again, its remembered state applies.
    expect(sanitizeVisibility(next, new Set([...listed, "archive"]))).toEqual({
      archive: false,
      name: true,
      size: false,
    });
  });

  it("reads the remembered state again only when the table id changes", () => {
    const reads: string[] = [];
    const read = (tableId: string): VisibilityState => {
      reads.push(tableId);
      return tableId === "jobs" ? { size: false } : {};
    };
    const first = rememberedFor(null, "jobs", read);
    expect(first).toEqual({ tableId: "jobs", state: { size: false } });
    expect(rememberedFor(first, "jobs", read)).toBe(first);
    expect(rememberedFor(first, "restores", read)).toEqual({ tableId: "restores", state: {} });
    expect(reads).toEqual(["jobs", "restores"]);
  });

  it("drops a remembered state that would hide every listed column", () => {
    const hideable = new Set(["name", "size"]);
    expect(sanitizeVisibility({ name: false, size: false }, hideable)).toEqual({});
    expect(sanitizeVisibility({ name: false, size: true }, hideable)).toEqual({
      name: false,
      size: true,
    });
    expect(sanitizeVisibility({ name: false }, hideable)).toEqual({ name: false });

    useStorage(
      mapStorage({
        [columnVisibilityKey("jobs")]: JSON.stringify({ name: false, size: false, status: false }),
      }),
    );
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).toContain(">Name<");
    expect(html).toContain(">Size<");
  });
});

describe("DataTable sticky header", () => {
  it("caps the height from md on by default, so the header can stick", () => {
    const html = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} />);
    expect(html).toContain(
      "md:[&amp;_[data-slot=table-container]]:max-h-(--data-table-max-height)",
    );
    expect(html).toContain("--data-table-max-height:max(20rem, 70svh)");
    expect(headerCell(html, "Name")).toContain("sticky top-0");
  });

  it("applies an explicit cap on every screen, and none on request", () => {
    const capped = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} maxHeight="32rem" />);
    expect(capped).toContain(
      " [&amp;_[data-slot=table-container]]:max-h-(--data-table-max-height)",
    );
    expect(capped).not.toContain("md:[&amp;_[data-slot=table-container]]");
    expect(capped).toContain("--data-table-max-height:32rem");

    const free = render(<DataTable id="jobs" columns={COLUMNS} data={JOBS} maxHeight="none" />);
    expect(free).toContain("--data-table-max-height:none");
  });
});

describe("DataTable helpers", () => {
  it("prefers loaded rows over loading and error", () => {
    const base = { loading: false, hasData: true, error: null, rowCount: 3, filtered: false };
    expect(bodyState({ ...base, hasData: false, loading: true })).toBe("loading");
    expect(bodyState({ ...base, hasData: false, error: new Error("x") })).toBe("error");
    expect(bodyState({ ...base, loading: true, error: new Error("x") })).toBe("rows");
    expect(bodyState({ ...base, rowCount: 0 })).toBe("empty");
    expect(bodyState({ ...base, rowCount: 0, filtered: true })).toBe("filteredEmpty");
  });

  it("maps sort state to aria-sort", () => {
    expect(ariaSortFor(false, false)).toBeUndefined();
    expect(ariaSortFor(true, false)).toBe("none");
    expect(ariaSortFor(true, "asc")).toBe("ascending");
    expect(ariaSortFor(true, "desc")).toBe("descending");
  });

  it("computes page ranges", () => {
    expect(pageRange(0, 25, 0)).toEqual({ from: 0, to: 0 });
    expect(pageRange(0, 25, 10)).toEqual({ from: 1, to: 10 });
    expect(pageRange(2, 25, 60)).toEqual({ from: 51, to: 60 });
  });
});
