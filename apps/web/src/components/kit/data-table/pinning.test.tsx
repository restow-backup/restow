import type { ColumnDef } from "@tanstack/react-table";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { render } from "../test-utils.js";
import { DataTable } from "./data-table.js";
import { declaredWidths, pinningState, truncatedTitle, widthStyle } from "./pinning.js";

interface Machine {
  id: string;
  host: string;
  os: string;
  status: string;
  note: string;
}

const MACHINES: Machine[] = [
  { id: "1", host: "alpha.example.test", os: "Linux", status: "ok", note: "first" },
  { id: "2", host: "bravo.example.test", os: "macOS", status: "late", note: "second" },
];

const COLUMNS: ColumnDef<Machine>[] = [
  { id: "host", accessorKey: "host", header: "Host", size: 240 },
  { id: "os", accessorKey: "os", header: "System", size: 120 },
  { id: "status", accessorKey: "status", header: "Status", size: 160 },
  { id: "note", accessorKey: "note", header: "Note", maxSize: 200 },
];

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

/** The opening tag of the first cell (`th` or `td`) whose text is `label`. */
function cellTag(html: string, tag: "th" | "td", label: string): string {
  const cells = html.match(new RegExp(`<${tag}\\b[^>]*>.*?</${tag}>`, "g")) ?? [];
  const cell = cells.find((candidate) => candidate.includes(label));
  if (!cell) {
    throw new Error(`no ${tag} for ${label}`);
  }
  return cell.slice(0, cell.indexOf(">") + 1);
}

/** Header labels in the order they are rendered. */
function headerOrder(html: string): string[] {
  const head = html.slice(html.indexOf("<thead"), html.indexOf("</thead>"));
  return [...head.matchAll(/<th\b[^>]*>(?:<button[^>]*>)?([A-Za-z]+)/g)].map((match) => match[1]);
}

describe("pinningState", () => {
  it("pins the given ids to the left", () => {
    expect(pinningState(["host", "os"])).toEqual({ left: ["host", "os"], right: [] });
  });

  it("pins nothing without ids", () => {
    expect(pinningState(undefined)).toEqual({ left: [], right: [] });
  });
});

describe("DataTable with one pinned column", () => {
  const html = render(
    <DataTable id="m1" columns={COLUMNS} data={MACHINES} pinnedColumns={["host"]} />,
  );

  it("pins the head and every cell of the column at the left edge", () => {
    for (const tag of [cellTag(html, "th", "Host"), cellTag(html, "td", "alpha.example.test")]) {
      expect(tag).toContain('data-pinned="left"');
      expect(tag).toMatch(/style="[^"]*left:0(px)?[;"]/);
      expect(tag).toContain("sticky");
    }
  });

  it("leaves the other columns unpinned", () => {
    expect(cellTag(html, "th", "System")).not.toContain("data-pinned");
    expect(cellTag(html, "td", "Linux")).not.toContain("data-pinned");
  });

  it("gives the pinned column its fixed size", () => {
    expect(cellTag(html, "td", "alpha.example.test")).toContain("--pin-w:240px");
  });

  it("makes the pinned head the corner: sticky both ways, above the other heads", () => {
    const corner = cellTag(html, "th", "Host");
    expect(corner).toContain("sticky top-0");
    expect(corner).toContain("z-20");
    const other = cellTag(html, "th", "System");
    expect(other).toContain("sticky top-0");
    expect(other).toContain("z-10");
    expect(other).not.toContain("z-20");
  });

  it("keeps pinned body cells below the sticky head", () => {
    const cell = cellTag(html, "td", "alpha.example.test");
    expect(cell).toContain("z-5");
    expect(cell).not.toContain("z-20");
  });

  it("casts the edge shadow from the only pinned column", () => {
    expect(cellTag(html, "td", "alpha.example.test")).toContain(
      "group-data-[scrolled=true]/scroll:after:opacity-100",
    );
    expect(cellTag(html, "th", "Host")).toContain(
      "group-data-[scrolled=true]/scroll:after:opacity-100",
    );
  });
});

describe("DataTable with two pinned columns", () => {
  const html = render(
    <DataTable id="m2" columns={COLUMNS} data={MACHINES} pinnedColumns={["host", "os"]} />,
  );

  it("starts the second column where the first ends", () => {
    expect(cellTag(html, "td", "alpha.example.test")).toMatch(/style="[^"]*left:0(px)?[;"]/);
    expect(cellTag(html, "td", "Linux")).toMatch(/style="[^"]*left:240px[;"]/);
    expect(cellTag(html, "th", "System")).toMatch(/style="[^"]*left:240px[;"]/);
  });

  it("casts the shadow from the last pinned column, and from the first only on phones", () => {
    const first = cellTag(html, "td", "alpha.example.test");
    const second = cellTag(html, "td", "Linux");
    expect(first).toContain("sm:after:hidden");
    expect(second).toContain("max-sm:after:hidden");
    expect(second).toContain("group-data-[scrolled=true]/scroll:after:opacity-100");
  });

  it("pins the second column on tablets and up, and keeps its head sticky on top on phones", () => {
    const head = cellTag(html, "th", "System");
    expect(head).toContain("sm:sticky");
    expect(head).toContain("max-sm:sticky");
    expect(head).not.toContain("max-sm:static");
  });
});

describe("DataTable column order and widths", () => {
  it("renders pinned columns first, whatever their place in the definition", () => {
    const html = render(
      <DataTable id="m3" columns={COLUMNS} data={MACHINES} pinnedColumns={["status", "host"]} />,
    );
    expect(headerOrder(html).slice(0, 2)).toEqual(["Status", "Host"]);
    // Offsets follow the pinned order, not the definition order.
    expect(cellTag(html, "td", "ok")).toMatch(/left:0(px)?[;"]/);
    expect(cellTag(html, "td", "alpha.example.test")).toMatch(/left:160px/);
  });

  it("pins nothing by default", () => {
    const html = render(<DataTable id="m4" columns={COLUMNS} data={MACHINES} />);
    expect(html).not.toContain("data-pinned");
  });

  it("keeps a column at least as wide as it declared, so the table scrolls instead of squeezing", () => {
    const html = render(<DataTable id="m5" columns={COLUMNS} data={MACHINES} />);
    expect(cellTag(html, "th", "System")).toContain("min-width:120px");
    expect(cellTag(html, "td", "Linux")).toContain("min-width:120px");
  });

  it("leaves a column without a declared width automatic", () => {
    const html = render(
      <DataTable
        id="m6"
        columns={[{ id: "host", accessorKey: "host", header: "Host" }]}
        data={MACHINES}
      />,
    );
    expect(cellTag(html, "th", "Host")).not.toContain("min-width");
  });

  it("holds a column with a maximum to one truncated line with its text as the tooltip", () => {
    const html = render(<DataTable id="m7" columns={COLUMNS} data={MACHINES} />);
    expect(cellTag(html, "td", "first")).toContain("max-width:200px");
    expect(html).toMatch(/<div title="first" class="[^"]*overflow-hidden[^"]*whitespace-nowrap/);
  });

  it("applies an explicit table minimum", () => {
    const html = render(<DataTable id="m8" columns={COLUMNS} data={MACHINES} minWidth="64rem" />);
    expect(html).toMatch(/<table[^>]*style="min-width:64rem"/);
  });

  it("keeps the pinned column in the placeholder rows while loading", () => {
    const html = render(
      <DataTable id="m9" columns={COLUMNS} data={undefined} loading pinnedColumns={["host"]} />,
    );
    const body = html.slice(html.indexOf("<tbody"));
    expect(body.match(/data-pinned="left"/g)).toHaveLength(5);
  });

  it("keeps the empty message in view instead of centring it in a row as wide as the columns", () => {
    const html = render(
      <DataTable id="m10" columns={COLUMNS} data={[]} pinnedColumns={["host"]} />,
    );
    expect(html).toContain("sticky left-4");
    expect(html).toContain("@container");
  });
});

describe("declaredWidths", () => {
  it("reports the minimum from minSize, else size, and the maximum from maxSize", () => {
    const column = (def: object) => ({ columnDef: def }) as never;
    expect(declaredWidths(column({ size: 120 }))).toEqual({ min: 120 });
    expect(declaredWidths(column({ size: 120, minSize: 80 }))).toEqual({ min: 80 });
    expect(declaredWidths(column({ maxSize: 200 }))).toEqual({ max: 200 });
    expect(declaredWidths(column({}))).toEqual({});
  });

  it("ignores TanStack's unbounded default maximum", () => {
    const column = { columnDef: { maxSize: Number.POSITIVE_INFINITY } } as never;
    expect(declaredWidths(column)).toEqual({});
  });
});

describe("widthStyle", () => {
  it("is empty without widths", () => {
    expect(widthStyle({})).toBeUndefined();
  });

  it("maps min and max to CSS", () => {
    expect(widthStyle({ min: 100, max: 300 })).toEqual({ minWidth: 100, maxWidth: 300 });
  });
});

describe("truncatedTitle", () => {
  it("prefers the title the page gave", () => {
    expect(truncatedTitle("shown", true, "explicit")).toBe("explicit");
    expect(truncatedTitle("shown", false, "explicit")).toBe("explicit");
  });

  it("uses a plain value as it is", () => {
    expect(truncatedTitle("shown", true, undefined)).toBe("shown");
    expect(truncatedTitle(42, true, undefined)).toBe("42");
  });

  it("leaves a custom cell to title itself", () => {
    expect(truncatedTitle("shown", false, undefined)).toBeUndefined();
  });

  it("has no tooltip for a value that is not text", () => {
    expect(truncatedTitle({ nested: true }, true, undefined)).toBeUndefined();
  });
});
