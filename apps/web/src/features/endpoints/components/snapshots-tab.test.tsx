// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type {
  BrowseEntry,
  BrowseResult,
  EndpointDetail,
  EndpointSnapshot,
  TaskResult,
} from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { SnapshotsTab } from "./snapshots-tab.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "tenant-7", name: "Contoso" },
  }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock("@/components/ui/sonner", () => ({ toast, Toaster: () => null }));

const fetchSnapshots = vi.fn();
const fetchBrowse = vi.fn();
const createTask = vi.fn();
const createDownload = vi.fn();
const startBrowserDownload = vi.fn();
vi.mock("../browser-download.js", () => ({
  startBrowserDownload: (...args: unknown[]) => startBrowserDownload(...args),
}));
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    // A small limit, so the refusal can be shown without ten thousand rows.
    LIMITS: { ...actual.LIMITS, downloadPaths: 50 },
    fetchSnapshots: (...args: unknown[]) => fetchSnapshots(...args),
    fetchBrowse: (...args: unknown[]) => fetchBrowse(...args),
    createTask: (...args: unknown[]) => createTask(...args),
    createDownload: (...args: unknown[]) => createDownload(...args),
  };
});

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const FULL_ID = "a".repeat(64);
const OLDER_ID = "b".repeat(64);

function snapshot(
  id: string,
  time: string,
  over: Partial<EndpointSnapshot> = {},
): EndpointSnapshot {
  return {
    id,
    shortId: id.slice(0, 8),
    time,
    hostname: "web-01",
    paths: ["/data"],
    filesNew: 3,
    totalFilesProcessed: 120,
    totalBytesProcessed: 4096,
    verification: { state: "unverified", checkedAt: null },
    flags: [],
    ...over,
  };
}

function entry(name: string, type: BrowseEntry["type"], path: string): BrowseEntry {
  return {
    name,
    path,
    type,
    size: type === "dir" ? null : 2048,
    mtime: "2026-09-29T08:00:00.000Z",
  };
}

function listing(
  path: string,
  entries: BrowseEntry[],
  nextCursor: string | null = null,
): BrowseResult {
  return { snapshotId: FULL_ID, path, entries, nextCursor };
}

// The server lists a folder in its final order: folders first, then by name.
const ROOT = listing("/data", [
  entry("docs", "dir", "/data/docs"),
  entry("notes.txt", "file", "/data/notes.txt"),
  entry("report.pdf", "file", "/data/report.pdf"),
]);

function detail(over: Partial<EndpointDetail> = {}): EndpointDetail {
  return {
    id: ENDPOINT_ID,
    hostname: "web-01",
    displayName: "Web front",
    status: "active",
    connection: "online",
    profile: "server",
    ...over,
  } as EndpointDetail;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("SnapshotsTab", () => {
  let page: Mounted;

  beforeEach(() => {
    fetchSnapshots.mockReset();
    fetchBrowse.mockReset();
    createTask.mockReset();
    createDownload.mockReset();
    startBrowserDownload.mockReset();
    for (const fn of Object.values(toast)) fn.mockReset();
    createDownload.mockResolvedValue({
      id: "dl-1",
      expiresAt: "2026-09-30T10:10:00.000Z",
      items: 2,
    });
    fetchSnapshots.mockResolvedValue([
      snapshot(OLDER_ID, "2026-09-28T22:00:00.000Z"),
      snapshot(FULL_ID, "2026-09-29T22:00:00.000Z", {
        verification: { state: "green", checkedAt: "2026-09-30T01:00:00.000Z" },
      }),
    ]);
    fetchBrowse.mockImplementation(async (_id: string, _snapshot: string, path: string) =>
      path === "/" || path === "/data"
        ? ROOT
        : listing(path, [
            entry("a.txt", "file", `${path}/a.txt`),
            entry("b.txt", "file", `${path}/b.txt`),
          ]),
    );
  });
  afterEach(() => page?.unmount());

  async function open(over: Partial<EndpointDetail> = {}, onShowOverview = () => {}) {
    page = mount();
    await page.render(<SnapshotsTab detail={detail(over)} onShowOverview={onShowOverview} />);
    await page.settle();
  }

  async function pickNewest() {
    await page.click(page.byText("button", FULL_ID.slice(0, 8)));
    await page.settle();
  }

  function box(label: string): HTMLButtonElement {
    const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`no checkbox ${label}`);
    return found;
  }

  function downloadButton(): HTMLButtonElement {
    return page.byText<HTMLButtonElement>("button", "ZIP");
  }

  it("lists the snapshots newest first with their verification, and browses nothing yet", async () => {
    await open();
    const items = [...document.querySelectorAll('[data-slot="snapshot-list"] li')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain(FULL_ID.slice(0, 8));
    expect(items[1]?.textContent).toContain(OLDER_ID.slice(0, 8));
    expect(items[0]?.querySelector('[data-verification="green"]')).not.toBeNull();
    expect(items[1]?.querySelector('[data-verification="unverified"]')).not.toBeNull();
    expect(items[0]?.textContent).toContain("120 files");
    // One separator per day on the timeline, and the jump to a date above it.
    expect(
      document.querySelectorAll('[data-slot="snapshot-list"] [data-slot="timeline-day"]'),
    ).toHaveLength(2);
    expect(page.text()).toContain("Jump to date");
    expect(page.text()).toContain("Pick a restore point");
    // Browsing is audited, so nothing is read before the admin picks a snapshot.
    expect(fetchBrowse).not.toHaveBeenCalled();
  });

  it("marks a snapshot retention found suspicious", async () => {
    fetchSnapshots.mockResolvedValue([
      snapshot(FULL_ID, "2031-01-01T00:00:00.000Z", { flags: ["unrecorded", "future_time"] }),
      snapshot(OLDER_ID, "2026-09-28T22:00:00.000Z"),
    ]);
    await open();
    const flagged = document.querySelectorAll('[data-slot="snapshot-flags"]');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.textContent).toContain("Not reported by any backup");
    expect(flagged[0]?.textContent).toContain("Dated in the future");
    expect(flagged[0]?.textContent).toContain("it may be compromised");
  });

  it("says when there is no snapshot yet", async () => {
    fetchSnapshots.mockResolvedValue([]);
    await open();
    expect(page.text()).toContain("No restore point yet");
  });

  it("says when the repository is busy and offers to try again", async () => {
    fetchSnapshots.mockRejectedValue(
      new ApiError(
        503,
        {
          type: "urn:restow:problem:endpoint-repository-locked",
          title: "Repository busy",
          status: 503,
        },
        "x",
      ),
    );
    await open();
    expect(page.text()).toContain("The backup data is busy");
    expect(page.text()).toContain("busy with a backup or maintenance");
    expect(page.maybeByText("button", "Retry")).not.toBeNull();
  });

  it("opens a snapshot at its root in the order the server lists it, and says browsing is audited", async () => {
    await open();
    await pickNewest();
    expect(fetchBrowse).toHaveBeenCalledWith(ENDPOINT_ID, FULL_ID, "/", null);
    const names = [...document.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
    expect(names[0]).toContain("docs");
    expect(names[1]).toContain("notes.txt");
    expect(names[2]).toContain("report.pdf");
    expect(page.text()).toContain("recorded in the audit log");
  });

  describe("a folder with more entries than one page", () => {
    const page1 = listing(
      "/data",
      [entry("docs", "dir", "/data/docs"), entry("a.txt", "file", "/data/a.txt")],
      "cursor-1",
    );
    const page2 = listing("/data", [entry("z.txt", "file", "/data/z.txt")]);

    function loadMore(): HTMLButtonElement | null {
      return page.maybeByText<HTMLButtonElement>("[data-browser='more'] button", "");
    }

    it("shows the first page and loads the next on request, appending to what is there", async () => {
      fetchBrowse.mockImplementation(
        async (_id: string, _snapshot: string, _path: string, cursor: string | null) =>
          cursor === "cursor-1" ? page2 : page1,
      );
      await open();
      await pickNewest();
      expect(document.querySelector("[data-browser='more']")?.textContent).toContain(
        "2 entries shown",
      );
      expect([...document.querySelectorAll("tbody tr")].map((row) => row.textContent)).toHaveLength(
        2,
      );
      // Selecting "all" in a partly loaded folder says what it covers.
      expect(
        document.querySelector(
          'button[aria-label="Select everything loaded so far in this folder"]',
        ),
      ).not.toBeNull();

      await page.click(page.byText("[data-browser='more'] button", "Load more"));
      await page.settle();
      expect(fetchBrowse).toHaveBeenLastCalledWith(ENDPOINT_ID, FULL_ID, "/", "cursor-1");
      const rows = [...document.querySelectorAll("tbody tr")].map((row) => row.textContent ?? "");
      expect(rows).toHaveLength(3);
      expect(rows[2]).toContain("z.txt");
      // The last page has no cursor: nothing more to load, the plain label is back.
      expect(document.querySelector("[data-browser='more']")).toBeNull();
      expect(
        document.querySelector('button[aria-label="Select everything in this folder"]'),
      ).not.toBeNull();
    });

    it("keeps the pages it has when the next one cannot be loaded, and tries again", async () => {
      let failures = 1;
      fetchBrowse.mockImplementation(
        async (_id: string, _snapshot: string, _path: string, cursor: string | null) => {
          if (cursor === "cursor-1") {
            if (failures-- > 0) {
              throw new ApiError(500, null, "boom");
            }
            return page2;
          }
          return page1;
        },
      );
      await open();
      await pickNewest();
      await page.click(page.byText("[data-browser='more'] button", "Load more"));
      await page.settle();
      expect(document.querySelector("[data-browser='more']")?.textContent).toContain(
        "More entries could not be loaded",
      );
      expect(document.querySelectorAll("tbody tr")).toHaveLength(2);
      expect(page.text()).not.toContain("The folder could not be read");
      await page.click(page.byText("[data-browser='more'] button", "Try again"));
      await page.settle();
      expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
      expect(document.querySelector("[data-browser='more']")).toBeNull();
    });

    it("does not offer more when the folder fits one page", async () => {
      await open();
      await pickNewest();
      expect(document.querySelector("[data-browser='more']")).toBeNull();
      expect(loadMore()).toBeNull();
    });
  });

  it("explains a busy server when a folder cannot be read", async () => {
    fetchBrowse.mockRejectedValue(
      new ApiError(
        429,
        { type: "urn:restow:problem:restic-busy", title: "Server busy", status: 429 },
        "x",
      ),
    );
    await open();
    await pickNewest();
    expect(page.text()).toContain("The backup data is busy");
    expect(page.text()).toContain("Try again in a moment");
  });

  it("navigates into a folder and back through the path bar", async () => {
    await open();
    await pickNewest();
    await page.click(page.byText("button", "docs"));
    await page.settle();
    expect(fetchBrowse).toHaveBeenLastCalledWith(ENDPOINT_ID, FULL_ID, "/data/docs", null);
    expect(page.text()).toContain("a.txt");
    const bar = document.querySelector('nav[aria-label="Folder path"]');
    expect(bar?.textContent).toContain("data");
    expect(bar?.textContent).toContain("docs");
    await page.click(page.byText("nav[aria-label='Folder path'] button", "Top level"));
    await page.settle();
    // The root was read before and a snapshot never changes, so it is not read (and audited) again.
    expect(page.text()).toContain("notes.txt");
    expect(fetchBrowse).toHaveBeenCalledTimes(2);
  });

  it("prepares the ZIP on the server with every path, then starts it for the active tenant", async () => {
    await open();
    await pickNewest();
    // Nothing selected, nothing to download.
    expect(downloadButton().disabled).toBe(true);
    await page.click(box("Select notes.txt"));
    await page.click(box("Select docs"));
    expect(page.text()).toContain("2 items selected");
    expect(downloadButton().disabled).toBe(false);
    await page.click(downloadButton());
    await page.settle();
    // The paths travel in the body of the request, not in an address.
    expect(createDownload).toHaveBeenCalledWith(ENDPOINT_ID, FULL_ID, [
      "/data/docs",
      "/data/notes.txt",
    ]);
    expect(startBrowserDownload).toHaveBeenCalledTimes(1);
    const url = new URL(startBrowserDownload.mock.calls[0]?.[0] as string, "http://localhost");
    expect(url.pathname).toBe(`/api/v1/endpoints/${ENDPOINT_ID}/downloads/dl-1`);
    expect(url.search).toBe("?tenant=tenant-7");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says it is preparing while the server checks the selection, and only starts once it is ready", async () => {
    let finish: (value: unknown) => void = () => {};
    createDownload.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await open();
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(downloadButton());
    expect(page.text()).toContain("Preparing ZIP");
    expect(downloadButton().disabled).toBe(true);
    expect(startBrowserDownload).not.toHaveBeenCalled();
    finish({ id: "dl-2", expiresAt: "2026-09-30T10:10:00.000Z", items: 1 });
    await page.settle();
    expect(startBrowserDownload).toHaveBeenCalledTimes(1);
    expect(page.text()).not.toContain("Preparing ZIP");
  });

  it("tells why a ZIP could not be prepared and starts nothing", async () => {
    createDownload.mockRejectedValue(
      new ApiError(
        404,
        {
          type: "urn:restow:problem:endpoint-path-not-found",
          title: "Path not found in the snapshot",
          status: 404,
        },
        "x",
      ),
    );
    await open();
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(downloadButton());
    await page.settle();
    expect(startBrowserDownload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("The ZIP could not be prepared", {
      description: "A selected path is not part of this snapshot.",
    });
    // The button is usable again.
    expect(downloadButton().disabled).toBe(false);
  });

  it("keeps the selection across folders and lets a selected folder cover what is inside", async () => {
    await open();
    await pickNewest();
    await page.click(box("Select report.pdf"));
    await page.click(page.byText("button", "docs"));
    await page.settle();
    await page.click(box("Select a.txt"));
    expect(page.text()).toContain("2 items selected");
    // Selecting the parent folder afterwards includes both, so only the parent and the PDF are named.
    await page.click(page.byText("nav[aria-label='Folder path'] button", "data"));
    await page.settle();
    await page.click(box("Select docs"));
    expect(page.text()).toContain("2 items selected");
    await page.click(downloadButton());
    await page.settle();
    expect(createDownload).toHaveBeenCalledWith(ENDPOINT_ID, FULL_ID, [
      "/data/docs",
      "/data/report.pdf",
    ]);
  });

  it("clears the selection and switches it off when another snapshot is picked", async () => {
    await open();
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(page.byText("button", "Clear selection"));
    expect(page.text()).toContain("Nothing selected");
    expect(downloadButton().disabled).toBe(true);
    await page.click(box("Select notes.txt"));
    await page.click(page.byText("button", OLDER_ID.slice(0, 8)));
    await page.settle();
    expect(page.text()).toContain("Nothing selected");
  });

  it("refuses a download over the API limit and says so, and points at the parent folder for many files", async () => {
    const many = Array.from({ length: 51 }, (_, i) => entry(`f${i}`, "file", `/data/f${i}`));
    fetchBrowse.mockResolvedValue(listing("/data", many));
    await open();
    await pickNewest();
    await page.click(
      document.querySelector(
        'button[aria-label="Select everything in this folder"]',
      ) as HTMLElement,
    );
    expect(page.text()).toContain("51 items selected");
    expect(downloadButton().disabled).toBe(true);
    expect(page.text()).toContain("A ZIP holds at most 50 selected items");
    expect(document.querySelector("[data-selection-note='many']")?.textContent).toContain(
      "Select the folder that holds them instead",
    );
    // Restoring takes up to 200, so it stays possible.
    const restore = page.byText("button", "Restore to the machine") as HTMLButtonElement;
    expect(restore.disabled).toBe(false);
  });

  it("restores the selection onto the machine into a new folder", async () => {
    const onShowOverview = vi.fn();
    const result: TaskResult = {
      alreadyQueued: false,
      task: {
        id: "t1",
        kind: "restore",
        status: "pending",
        params: {},
        createdAt: "2026-09-30T10:00:00.000Z",
        deliveredAt: null,
        finishedAt: null,
        errorMessage: null,
        checkIncomplete: false,
      },
    };
    createTask.mockResolvedValue(result);
    await open({}, onShowOverview);
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(box("Select docs"));
    await page.click(page.byText("button", "Restore to the machine"));
    expect(page.text()).toContain("never overwrites existing files");
    expect(page.text()).toContain("new folder");
    await page.type(
      document.getElementById("restore-target") as HTMLInputElement,
      " /srv/restore ",
    );
    await page.click(page.byText("button", "Request restore"));
    await page.settle();
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledWith(ENDPOINT_ID, {
      kind: "restore",
      // The full snapshot id, not the short one.
      snapshotId: FULL_ID,
      paths: ["/data/docs", "/data/notes.txt"],
      targetDir: "/srv/restore",
    });
    expect(document.querySelector('[data-restore="requested"]')?.textContent).toContain(
      "Restore requested",
    );
    await page.click(page.byText("button", "Show overview"));
    expect(onShowOverview).toHaveBeenCalled();
    // The selection was used up.
    expect(page.text()).toContain("Nothing selected");
  });

  it("lets the agent choose the folder when none is given", async () => {
    createTask.mockResolvedValue({ alreadyQueued: false, task: {} });
    await open();
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(page.byText("button", "Restore to the machine"));
    await page.click(page.byText("button", "Request restore"));
    await page.settle();
    expect(createTask).toHaveBeenCalledWith(ENDPOINT_ID, {
      kind: "restore",
      snapshotId: FULL_ID,
      paths: ["/data/notes.txt"],
    });
  });

  it("does not send a relative target folder", async () => {
    await open();
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(page.byText("button", "Restore to the machine"));
    await page.type(document.getElementById("restore-target") as HTMLInputElement, "restore/here");
    await page.click(page.byText("button", "Request restore"));
    await page.settle();
    expect(createTask).not.toHaveBeenCalled();
    expect(page.text()).toContain("Enter an absolute path");
  });

  it("warns that the restore waits while the machine is offline", async () => {
    await open({ connection: "offline" });
    await pickNewest();
    await page.click(box("Select notes.txt"));
    await page.click(page.byText("button", "Restore to the machine"));
    expect(document.querySelector('[data-restore="offline"]')?.textContent).toContain(
      "not connected",
    );
  });

  it("cannot restore onto a revoked machine, but still downloads", async () => {
    await open({ status: "revoked" });
    await pickNewest();
    await page.click(box("Select notes.txt"));
    expect((page.byText("button", "Restore to the machine") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(downloadButton().disabled).toBe(false);
    expect(page.text()).toContain("files cannot be restored onto it");
  });
});
