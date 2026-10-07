// @vitest-environment happy-dom
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import { button, click, jsonResponse, mount, text, until } from "../testing/dom";
import {
  IMPORT_ID,
  OBJECT_ID,
  SNAPSHOT_ID,
  detail,
  duplicateItem,
  failedItem,
  notMailItem,
  report,
  summary,
} from "../testing/fixtures";
import type { ImportDetail, ImportSummary } from "../types";
import { ImportJobPage } from "./import-job-page";
import { ImportsPage } from "./imports-page";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      children,
      className,
      to,
      search,
      ...rest
    }: {
      children: ReactNode;
      className?: string;
      to: string;
      search?: Record<string, string>;
    }) => (
      <a
        className={className}
        href={`${String(to)}${search ? `?${new URLSearchParams(search).toString()}` : ""}`}
        {...(rest as Record<string, unknown>)}
      >
        {children}
      </a>
    ),
  };
});

vi.mock("@/features/jobs/use-format", () => ({
  useJobFormat: () => ({ duration: (seconds: number) => `${Math.round(seconds / 60)} min` }),
}));

let current: ImportDetail;
let cancelled: string[];
let detailCalls: number;

function stubApi(overrides: { detailStatus?: number; list?: ImportSummary[] } = {}) {
  cancelled = [];
  detailCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(String(input), "http://localhost").pathname.replace(/^\/api\/v1/, "");
      const method = (init.method ?? "GET").toUpperCase();
      if (path === `/imports/${IMPORT_ID}` && method === "GET") {
        detailCalls += 1;
        if (overrides.detailStatus) {
          return jsonResponse(
            { type: "about:blank", title: "x", status: overrides.detailStatus },
            overrides.detailStatus,
          );
        }
        return jsonResponse(current);
      }
      if (path === `/imports/${IMPORT_ID}/cancel` && method === "POST") {
        cancelled.push(path);
        current = { ...current, status: "cancelled" };
        return jsonResponse(current);
      }
      if (path === "/imports" && method === "GET") {
        return jsonResponse({ items: overrides.list ?? [] });
      }
      return jsonResponse({ type: "about:blank", title: "not found", status: 404 }, 404);
    }),
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  current = detail();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const open = async () => {
  const view = mount(<ImportJobPage importId={IMPORT_ID} />);
  await until(() => expect(text(view.container)).toContain("Mail archive 2019"));
  return view;
};

describe("a finished import with a report", () => {
  it("shows the numbers as cards", async () => {
    stubApi();
    const view = await open();
    const cards = view.container.querySelector('[data-testid="report-cards"]')?.textContent ?? "";
    for (const expected of [
      "Messages1,204",
      "Folders9",
      "Attachments311",
      "Duplicates skipped12",
      "Unreadable items1",
      "Skipped items1",
      "Message data775 MB",
      "Rebuilt from MSG40",
    ]) {
      expect(cards).toContain(expected);
    }
    // A completed import with a failed item is not called a plain success.
    expect(text(view.container)).toContain("Completed with problems");
    view.unmount();
  });

  it("lists the unreadable item first, with its reason in plain words and the reader's own text", async () => {
    stubApi();
    const view = await open();
    const content = text(view.container);
    expect(content).toContain(failedItem.ref);
    expect(content).toContain("The item is damaged or could not be parsed.");
    expect(content).toContain(failedItem.reason);

    const rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    const itemRows = rows.filter((row) => row.includes("Failed") || row.includes("Skipped"));
    expect(itemRows[0]).toContain(failedItem.ref);
    // The list opens on the failures; skipped items are one tab away.
    expect(rows.some((row) => row.includes(notMailItem.ref))).toBe(false);
    view.unmount();
  });

  it("filters the item list by outcome", async () => {
    stubApi();
    const view = await open();
    const tab = (name: RegExp) =>
      [...view.container.querySelectorAll('[role="tab"]')].find((element) =>
        name.test(element.textContent ?? ""),
      ) as HTMLElement;
    expect(tab(/Failed/).textContent).toContain("1");
    expect(tab(/Skipped/).textContent).toContain("2");
    expect(tab(/All/).textContent).toContain("3");

    await act(async () => {
      tab(/Skipped/).dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      tab(/Skipped/).focus();
      tab(/Skipped/).click();
    });
    await until(() => expect(text(view.container)).toContain(notMailItem.ref));
    expect(text(view.container)).toContain(duplicateItem.ref);
    expect(text(view.container)).toContain("This is not a mail message");
    expect(text(view.container)).toContain("The message is already in the mailbox.");
    expect(text(view.container)).not.toContain(failedItem.reason);
    view.unmount();
  });

  it("writes the honest notes as sentences", async () => {
    stubApi();
    const view = await open();
    const notes = view.container.querySelector('[data-testid="report-notes"]')?.textContent ?? "";
    expect(notes).toContain("Calendar entries and contacts are not imported, only mail.");
    expect(notes).toContain("rebuilt as EML from the stored properties");
    view.unmount();
  });

  it("translates the notes about a capped list and a recovered report", async () => {
    current = detail({
      report: report({ notes: ["item_list_truncated", "report_recovered"] }),
    });
    stubApi();
    const view = await open();
    const notes = view.container.querySelector('[data-testid="report-notes"]')?.textContent ?? "";
    expect(notes).toContain("The list of items is capped");
    expect(notes).toContain("rebuilt from the records of the run");
    expect(notes).not.toContain("item_list_truncated");
    expect(notes).not.toContain("report_recovered");
    view.unmount();
  });

  it("renders a note this version does not know as a generic sentence with its code", async () => {
    current = detail({ report: report({ notes: ["something_new_from_the_worker"] }) });
    stubApi();
    const view = await open();
    const notes = view.container.querySelector('[data-testid="report-notes"]')?.textContent ?? "";
    expect(notes).toContain("a note this version of Restow does not know");
    expect(notes).toContain("something_new_from_the_worker");
    view.unmount();
  });

  it("tabulates every file with its counts and a short SHA-256", async () => {
    stubApi();
    const view = await open();
    const rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    const inbox = rows.find(
      (row) => row.includes("mail/Inbox.mbox") && row.includes("aaaaaaaaaaaa"),
    );
    expect(inbox).toBeDefined();
    expect(inbox).toContain("Imported with warnings");
    expect(inbox).toContain("MBOX");
    const zip = rows.find((row) => row.includes("export.zip") && row.includes("bbbbbbbbbbbb"));
    expect(zip).toContain("Imported");
    view.unmount();
  });

  it("links to the restore explorer at the snapshot this import wrote", async () => {
    stubApi();
    const view = await open();
    const link = [...view.container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("Open in restore explorer"),
    );
    expect(link?.getAttribute("href")).toBe(`/restore?object=${OBJECT_ID}&snapshot=${SNAPSHOT_ID}`);
    view.unmount();
  });

  it("offers the report as a JSON download and no cancel button", async () => {
    stubApi();
    const view = await open();
    expect(() => button(view.container, "Download report as JSON")).not.toThrow();
    expect(() => button(view.container, "Cancel import")).toThrow();
    expect(() => button(view.container, "Copy list")).not.toThrow();
    view.unmount();
  });

  it("says how many items are not listed", async () => {
    current = detail({ report: report({ itemsOmitted: 250 }) });
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain("250 more items are not listed");
    view.unmount();
  });

  it("shows the archive result when the archive was requested", async () => {
    current = detail({
      archive: true,
      report: report({
        archive: { requested: true, ingested: 1100, alreadyArchived: 90, failed: 2 },
      }),
    });
    stubApi();
    const view = await open();
    const content = text(view.container);
    expect(content).toContain("Ingested1,100");
    expect(content).toContain("Already archived90");
    expect(content).toContain("Failed2");
    view.unmount();
  });

  it("says every message was already imported, as a success, when the same files are imported again", async () => {
    current = detail({
      status: "completed",
      messages: 0,
      failed: 0,
      errorMessage: null,
      report: report({
        snapshotId: null,
        totals: { ...report().totals, messages: 0, duplicates: 37, skipped: 37, failed: 0 },
        items: [duplicateItem],
        notes: [],
      }),
    });
    stubApi();
    const view = await open();
    const content = text(view.container);
    expect(content).toContain("All 37 messages in the files were already imported");
    expect(content).toContain("Nothing new was stored");
    expect(content).toContain("Completed");
    expect(content).not.toContain("The import failed");
    expect(content).not.toContain("Nothing was stored because none of the files could be read");
    view.unmount();
  });

  it("keeps the general sentence when nothing new was stored for another reason", async () => {
    current = detail({
      status: "completed",
      failed: 0,
      report: report({
        snapshotId: null,
        totals: { ...report().totals, messages: 0, duplicates: 0, skipped: 2, failed: 0 },
        items: [notMailItem],
      }),
    });
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain("Nothing new was stored, for example because");
    expect(text(view.container)).not.toContain("were already imported");
    view.unmount();
  });

  it("has nothing to list when every item was imported", async () => {
    current = detail({
      status: "completed",
      failed: 0,
      report: report({ items: [], totals: { ...report().totals, failed: 0, skipped: 0 } }),
    });
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain("Every item was imported");
    expect(text(view.container)).toContain("Completed");
    expect(text(view.container)).not.toContain("Completed with problems");
    view.unmount();
  });
});

describe("a running import", () => {
  const running = () =>
    detail({
      status: "active",
      completedAt: null,
      messages: null,
      failed: null,
      phase: "import",
      report: null,
      progress: {
        total: 1_000_000_000,
        done: 350_000_000,
        failed: 2,
        bytes: 120_000_000,
        etaSeconds: 480,
      },
      live: { messages: 412, duplicates: 5, skipped: 1, failed: 2, filesDone: 0, filesTotal: 2 },
      failures: [{ itemRef: "Inbox.mbox#9", reason: "Truncated header block", attempts: 1 }],
    });

  it("shows phase, progress, counts, ETA and the failures so far", async () => {
    current = running();
    stubApi();
    const view = await open();
    const content = text(view.container);
    expect(content).toContain("Running");
    expect(content).toContain("Phase: Importing messages");
    expect(content).toContain("read (35%)");
    expect(content).toContain("412 messages imported so far");
    expect(content).toContain("File 1 of 2");
    expect(content).toContain("2 items failed");
    expect(content).toContain("about 8 min left");
    expect(content).toContain("Inbox.mbox#9");
    expect(content).toContain("Truncated header block");
    const bar = view.container.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute("aria-valuenow")).toBe("35");
    view.unmount();
  });

  it("shows how far the archive hand-over is", async () => {
    current = {
      ...running(),
      phase: "archive",
      live: {
        messages: 48_000,
        duplicates: 0,
        skipped: 0,
        failed: 0,
        filesDone: 2,
        filesTotal: 2,
        archiveDone: 12_000,
        archiveTotal: 48_000,
      },
    };
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain("Phase: Ingesting into the archive");
    expect(text(view.container)).toContain("12,000 of 48,000 messages handed to the archive");
    view.unmount();
  });

  it("can be cancelled after a confirmation", async () => {
    current = running();
    stubApi();
    const view = await open();
    await click(button(view.container, "Cancel import"));
    expect(document.body.textContent).toContain("Cancel this import?");
    const confirm = [...document.body.querySelectorAll("button")].filter((element) =>
      element.textContent?.includes("Cancel import"),
    );
    await click(confirm[confirm.length - 1] as Element);
    await until(() => expect(cancelled).toHaveLength(1));
    await until(() => expect(text(view.container)).toContain("The import was cancelled"));
    expect(() => button(view.container, "Cancel import")).toThrow();
    view.unmount();
  });

  it("asks again while it runs, and stops once it is finished", async () => {
    current = running();
    stubApi();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const view = mount(<ImportJobPage importId={IMPORT_ID} />);
    await until(() => expect(text(view.container)).toContain("Phase: Importing messages"));
    const first = detailCalls;

    current = detail();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });
    await until(() => expect(text(view.container)).toContain("Completed with problems"));
    expect(detailCalls).toBeGreaterThan(first);

    const settled = detailCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(detailCalls).toBe(settled);
    view.unmount();
  });

  it("waits quietly while queued", async () => {
    current = detail({
      status: "queued",
      report: null,
      progress: null,
      phase: null,
      live: null,
      startedAt: null,
      completedAt: null,
    });
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain("Waiting for a worker to pick it up.");
    expect(text(view.container)).toContain("Waiting");
    view.unmount();
  });
});

describe("a failed or cancelled import", () => {
  it("shows the error banner with the reason, and the report when there is one", async () => {
    current = detail({
      status: "failed",
      failed: 3,
      errorMessage: "None of the 3 files could be read",
      report: report({ snapshotId: null, items: [failedItem] }),
    });
    stubApi();
    const view = await open();
    const content = text(view.container);
    expect(content).toContain("The import failed");
    expect(content).toContain("None of the 3 files could be read");
    expect(content).toContain("Nothing was stored because none of the files could be read");
    expect(content).toContain(failedItem.ref);
    // Nothing was stored, so there is nothing to open in the explorer.
    expect(content).not.toContain("Open in restore explorer");
    expect(() => button(view.container, "Download report as JSON")).not.toThrow();
    view.unmount();
  });

  it("says what a cancelled import left behind", async () => {
    current = detail({ status: "cancelled", report: null, completedAt: null });
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain("The import was cancelled");
    expect(text(view.container)).toContain("earlier imports into the mailbox are not affected");
    // Nothing was going to the archive: no word about it.
    expect(text(view.container)).not.toContain("stay there until their retention ends");
    view.unmount();
  });

  it("says that messages already in the archive stay there after a cancellation", async () => {
    current = detail({ status: "cancelled", archive: true, report: null, completedAt: null });
    stubApi();
    const view = await open();
    expect(text(view.container)).toContain(
      "Messages ingested into the archive before the cancellation stay there until their retention ends.",
    );
    view.unmount();
  });

  it("warns before cancelling that archived messages stay in the archive", async () => {
    current = detail({ status: "active", archive: true, report: null, completedAt: null });
    stubApi();
    const view = await open();
    await click(button(view.container, "Cancel import"));
    expect(document.body.textContent).toContain(
      "Messages already ingested into the archive stay there until their retention ends.",
    );
    view.unmount();
  });

  it("says when the import does not exist", async () => {
    stubApi({ detailStatus: 404 });
    const view = mount(<ImportJobPage importId={IMPORT_ID} />);
    await until(() => expect(text(view.container)).toContain("Import not found"));
    view.unmount();
  });
});

describe("the imports list", () => {
  it("shows every import with status, files, messages and failures", async () => {
    stubApi({
      list: [
        summary({
          id: "a",
          name: "Running one",
          status: "active",
          messages: null,
          failed: null,
          live: { messages: 55, duplicates: 0, skipped: 0, failed: 4, filesDone: 0, filesTotal: 1 },
        }),
        summary({
          id: "b",
          name: "Done with problems",
          status: "completed",
          messages: 1204,
          failed: 7,
          fileCount: 3,
        }),
        summary({ id: "c", name: "Broken", status: "failed", messages: 0, failed: 9 }),
      ],
    });
    const view = mount(<ImportsPage />);
    await until(() => expect(text(view.container)).toContain("Done with problems"));
    const rows = [...view.container.querySelectorAll("tbody tr")].map(
      (row) => row.textContent ?? "",
    );
    expect(rows[0]).toContain("Running one");
    expect(rows[0]).toContain("Running");
    expect(rows[0]).toContain("55");
    expect(rows[1]).toContain("Completed with problems");
    expect(rows[1]).toContain("1,204");
    expect(rows[1]).toContain("7");
    expect(rows[2]).toContain("Failed");
    const link = view.container.querySelector('a[href="/imports/b"]');
    expect(link).not.toBeNull();
    expect(text(view.container)).toContain("Import mail files");
    view.unmount();
  });

  it("says how many imports are shown and loads older ones on request", async () => {
    stubApi({
      list: Array.from({ length: 50 }, (_, index) =>
        summary({ id: `i${index}`, name: `Import ${index}`, status: "completed" }),
      ),
    });
    const view = mount(<ImportsPage />);
    await until(() => expect(text(view.container)).toContain("The newest 50 imports are shown."));
    const requests = () =>
      (vi.mocked(fetch).mock.calls as [RequestInfo | URL][]).map(([input]) => String(input));
    expect(requests().some((url) => url.includes("offset=50"))).toBe(false);
    await click(button(view.container, "Show older"));
    await until(() => expect(requests().some((url) => url.includes("offset=50"))).toBe(true));
    view.unmount();
  });

  it("offers no older imports when the first page is not full", async () => {
    stubApi({ list: [summary({ id: "a", name: "Only one", status: "completed" })] });
    const view = mount(<ImportsPage />);
    await until(() => expect(text(view.container)).toContain("The newest import is shown."));
    expect(() => button(view.container, "Show older")).toThrow();
    view.unmount();
  });

  it("explains the empty history and offers the wizard", async () => {
    stubApi({ list: [] });
    const view = mount(<ImportsPage />);
    await until(() => expect(text(view.container)).toContain("No imports yet"));
    expect(view.container.querySelector('a[href="/sources/import"]')).not.toBeNull();
    view.unmount();
  });
});
