// @vitest-environment happy-dom
import * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type Mounted,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  mount,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";

import "../i18n.js";
import { adminSession, focusOn, press } from "../testing.js";
import { FolderTree } from "./folder-tree.js";

/**
 * The folder tree is a real tree: one tab stop that moves with the arrow keys, folders that
 * open and close, Space that ticks, Enter that opens, and folders that load one at a time.
 */

enableActEnvironment();

let mounted: Mounted | null = null;
let requests: URL[] = [];

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  requests = [];
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const dir = (path: string) => ({
  name: path.split("/").pop() ?? path,
  path,
  type: "dir" as const,
  size: null,
  mtime: null,
});
const file = (path: string) => ({
  name: path.split("/").pop() ?? path,
  path,
  type: "file" as const,
  size: 12,
  mtime: null,
});

const LISTING: Record<string, ReturnType<typeof dir>[]> = {
  "/": [dir("/etc"), dir("/home"), dir("/var"), file("/swapfile") as never],
  "/home": [dir("/home/anna"), dir("/home/ben")],
  "/home/anna": [],
  "/etc": [dir("/etc/ssh")],
  "/var": Array.from({ length: 3 }, (_, index) => dir(`/var/log${index + 1}`)),
};

/** A snapshot: the folders of every path, the big one in two pages. */
function stubBrowse() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(url);
      const path = url.searchParams.get("path") ?? "/";
      const cursor = url.searchParams.get("cursor");
      const all = LISTING[path] ?? [];
      const pageSize = path === "/var" ? 2 : 1000;
      const start = cursor ? Number(cursor) : 0;
      const entries = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : null;
      return new Response(
        JSON.stringify({ snapshotId: "snap-1", path, entries, nextCursor: next }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

function Harness({
  snapshotId = "snap-1",
  initial = [],
  onToggle,
  roots = [],
}: {
  snapshotId?: string | null;
  initial?: string[];
  onToggle?: (path: string) => void;
  roots?: string[];
}) {
  const [selected, setSelected] = React.useState<string[]>(initial);
  return (
    <FolderTree
      machineId="m1"
      snapshotId={snapshotId}
      roots={roots}
      selected={selected}
      label="Folders of FS-BERGISCH"
      onToggle={(path) => {
        onToggle?.(path);
        setSelected((current) =>
          current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path],
        );
      }}
    />
  );
}

async function render(node: React.ReactNode) {
  mounted = mount(node, { session: adminSession() });
  await flush(6);
}

const items = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const item = (path: string) => {
  const found = items().find((entry) => entry.getAttribute("data-path") === path);
  if (!found) throw new Error(`no row for ${path}`);
  return found;
};
const tabStops = () => items().filter((entry) => entry.tabIndex === 0);

describe("the folder tree", () => {
  it("is a tree of the folders of the newest backup, without the files", async () => {
    stubBrowse();
    await render(<Harness />);
    const tree = document.querySelector('[role="tree"]');
    expect(tree?.getAttribute("aria-label")).toBe("Folders of FS-BERGISCH");
    expect(items().map((entry) => entry.getAttribute("data-path"))).toEqual([
      "/etc",
      "/home",
      "/var",
    ]);
    for (const entry of items()) {
      expect(entry.getAttribute("aria-level")).toBe("1");
      expect(entry.getAttribute("aria-expanded")).toBe("false");
      expect(entry.getAttribute("aria-checked")).toBe("false");
    }
    expect(items().map((entry) => entry.getAttribute("aria-posinset"))).toEqual(["1", "2", "3"]);
    expect(items()[0]?.getAttribute("aria-setsize")).toBe("3");
    // The label of a row is its folder name, not everything below it.
    expect(items()[1]?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(
      document.getElementById(items()[1]?.getAttribute("aria-labelledby") ?? "")?.textContent,
    ).toBe("home");
  });

  it("has one tab stop, which follows the focus", async () => {
    stubBrowse();
    await render(<Harness />);
    expect(tabStops().map((entry) => entry.getAttribute("data-path"))).toEqual(["/etc"]);
    await focusOn(item("/etc"));
    await press(item("/etc"), "ArrowDown");
    expect(document.activeElement).toBe(item("/home"));
    await flush(1);
    expect(tabStops().map((entry) => entry.getAttribute("data-path"))).toEqual(["/home"]);
    await press(item("/home"), "End");
    expect(document.activeElement).toBe(item("/var"));
    await press(item("/var"), "Home");
    expect(document.activeElement).toBe(item("/etc"));
    await press(item("/etc"), "ArrowUp");
    // Nothing above the first row: the focus stays.
    expect(document.activeElement).toBe(item("/etc"));
  });

  it("opens a folder with ArrowRight, moves into it, and closes it with ArrowLeft", async () => {
    stubBrowse();
    await render(<Harness />);
    await focusOn(item("/home"));
    await press(item("/home"), "ArrowRight");
    await flush(5);
    expect(item("/home").getAttribute("aria-expanded")).toBe("true");
    expect(item("/home/anna").getAttribute("aria-level")).toBe("2");
    expect(requests.some((url) => url.searchParams.get("path") === "/home")).toBe(true);
    // Another ArrowRight on the open folder goes to its first child.
    await press(item("/home"), "ArrowRight");
    expect(document.activeElement).toBe(item("/home/anna"));
    // ArrowLeft on a child goes back to its parent; on the open parent it closes it.
    await press(item("/home/anna"), "ArrowLeft");
    expect(document.activeElement).toBe(item("/home"));
    await press(item("/home"), "ArrowLeft");
    expect(item("/home").getAttribute("aria-expanded")).toBe("false");
    expect(items().some((entry) => entry.getAttribute("data-path") === "/home/anna")).toBe(false);
  });

  it("moves down through the open rows in the order they are shown", async () => {
    stubBrowse();
    await render(<Harness />);
    await focusOn(item("/etc"));
    await press(item("/etc"), "ArrowRight");
    await flush(5);
    await press(item("/etc"), "ArrowDown");
    expect(document.activeElement).toBe(item("/etc/ssh"));
    await press(item("/etc/ssh"), "ArrowDown");
    expect(document.activeElement).toBe(item("/home"));
  });

  it("ticks the folder with Space and says so, and unticks it again", async () => {
    stubBrowse();
    const chosen: string[] = [];
    await render(<Harness onToggle={(path) => chosen.push(path)} />);
    await focusOn(item("/home"));
    await press(item("/home"), " ");
    expect(chosen).toEqual(["/home"]);
    expect(item("/home").getAttribute("aria-checked")).toBe("true");
    await press(item("/home"), " ");
    expect(chosen).toEqual(["/home", "/home"]);
    expect(item("/home").getAttribute("aria-checked")).toBe("false");
    // Space does not open or close the folder.
    expect(item("/home").getAttribute("aria-expanded")).toBe("false");
  });

  it("opens and closes a folder with Enter, and does not tick it", async () => {
    stubBrowse();
    const chosen: string[] = [];
    await render(<Harness onToggle={(path) => chosen.push(path)} />);
    await focusOn(item("/home"));
    await press(item("/home"), "Enter");
    await flush(5);
    expect(item("/home").getAttribute("aria-expanded")).toBe("true");
    await press(item("/home"), "Enter");
    expect(item("/home").getAttribute("aria-expanded")).toBe("false");
    expect(chosen).toEqual([]);
  });

  it("shows what a chosen folder covers as ticked, and Space on it changes nothing", async () => {
    stubBrowse();
    const chosen: string[] = [];
    await render(<Harness initial={["/home"]} onToggle={(path) => chosen.push(path)} />);
    await focusOn(item("/home"));
    await press(item("/home"), "Enter");
    await flush(5);
    const child = item("/home/anna");
    expect(child.getAttribute("aria-checked")).toBe("true");
    expect(child.getAttribute("data-covered")).toBe("true");
    expect(child.textContent).toContain("included");
    await focusOn(child);
    await press(child, " ");
    expect(chosen).toEqual([]);
  });

  it("shows a folder that has a chosen folder below it as mixed, and not as ticked", async () => {
    stubBrowse();
    await render(<Harness initial={["/home/anna"]} />);
    expect(item("/home").getAttribute("aria-checked")).toBe("mixed");
    expect(item("/etc").getAttribute("aria-checked")).toBe("false");
    await focusOn(item("/home"));
    await press(item("/home"), "Enter");
    await flush(5);
    expect(item("/home/anna").getAttribute("aria-checked")).toBe("true");
    expect(item("/home/ben").getAttribute("aria-checked")).toBe("false");
    // Ticking the folder itself takes the folder below it over: the box is ticked, not mixed.
    await press(item("/home"), " ");
    expect(item("/home").getAttribute("aria-checked")).toBe("true");
  });

  it("loads a big folder a page at a time, with Load more as a row of its own", async () => {
    stubBrowse();
    await render(<Harness />);
    await focusOn(item("/var"));
    await press(item("/var"), "ArrowRight");
    await flush(5);
    expect(
      items().filter((entry) => entry.getAttribute("data-path")?.startsWith("/var/")),
    ).toHaveLength(2);
    const more = document.querySelector<HTMLElement>('[data-load-more="true"]');
    expect(more?.getAttribute("aria-label")).toBe("Load more folders in /var");
    await press(item("/var/log2"), "ArrowDown");
    expect(document.activeElement).toBe(more);
    await press(more, "Enter");
    await flush(5);
    expect(item("/var/log3")).toBeTruthy();
    expect(document.querySelector('[data-load-more="true"]')).toBeNull();
    const cursors = requests
      .filter((url) => url.searchParams.get("path") === "/var")
      .map((url) => url.searchParams.get("cursor"));
    expect(cursors).toEqual([null, "2"]);
  });

  it("shows the configured folders as the roots when there is no backup yet, and opens nothing", async () => {
    stubBrowse();
    await render(<Harness snapshotId={null} roots={["/srv/data", "/opt"]} />);
    expect(items().map((entry) => entry.getAttribute("data-path"))).toEqual(["/srv/data", "/opt"]);
    for (const entry of items()) {
      expect(entry.hasAttribute("aria-expanded")).toBe(false);
    }
    await focusOn(item("/srv/data"));
    await press(item("/srv/data"), "ArrowRight");
    await press(item("/srv/data"), "Enter");
    expect(requests).toHaveLength(0);
    await press(item("/srv/data"), " ");
    expect(item("/srv/data").getAttribute("aria-checked")).toBe("true");
  });

  it("says why a folder cannot be read and offers another try", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ type: "urn:restow:problem:restic-busy", title: "busy", status: 503 }),
            { status: 503, headers: { "content-type": "application/problem+json" } },
          ),
      ),
    );
    await render(<Harness />);
    const alert = document.querySelector('[data-slot="folder-tree"] [role="alert"]');
    expect(alert?.textContent).toContain("The server is reading other backups right now");
    expect(document.querySelector('[data-slot="folder-tree"] button')?.textContent).toContain(
      "Try again",
    );
  });
});
