// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ListedSnapshot, SnapshotObject } from "@/features/restore/api";
import { i18n } from "@/i18n";

import type { EndpointSummary } from "./api.js";
import { type Mounted, mount } from "./dom-harness.js";
import { FileRestorePage } from "./file-restore-page.js";
import "./i18n.js";

/**
 * File restore lists machines and mailboxes in one searchable list; a
 * mailbox's restore points sit on the same timeline as a machine's, and the
 * chosen one opens in the restore explorer.
 */

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    activeTenant: { id: "t-1", name: "Contoso" },
    user: { id: "u-1" },
  }),
}));
const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({
      to,
      search,
      children,
      ...props
    }: {
      to: string;
      search?: unknown;
      children: React.ReactNode;
    }) => (
      <a href={String(to)} data-search={JSON.stringify(search ?? {})} {...props}>
        {children}
      </a>
    ),
  };
});

const fetchEndpoints = vi.fn();
vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return { ...actual, fetchEndpoints: (...args: unknown[]) => fetchEndpoints(...args) };
});
const fetchSnapshotObjects = vi.fn();
const fetchRestorePoints = vi.fn();
vi.mock("@/features/restore/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/restore/api")>();
  return {
    ...actual,
    fetchSnapshotObjects: (...args: unknown[]) => fetchSnapshotObjects(...args),
    fetchSnapshots: (...args: unknown[]) => fetchRestorePoints(...args),
  };
});

const MAILBOX_ID = "22222222-2222-4222-8222-222222222222";
const POINT_NEW = "33333333-3333-4333-8333-333333333333";
const POINT_OLD = "44444444-4444-4444-8444-444444444444";

function machine(over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    lastBackupAt: null,
    ...over,
  } as EndpointSummary;
}

function mailbox(over: Partial<SnapshotObject> = {}): SnapshotObject {
  return {
    id: MAILBOX_ID,
    kind: "mailbox",
    externalId: "anna@contoso.example",
    displayName: "Anna Berg",
    status: "active",
    sourceKind: "m365",
    ownerEmail: "anna@contoso.example",
    own: false,
    snapshotCount: 2,
    latestSnapshotId: POINT_NEW,
    latestSnapshotAt: "2026-09-30T08:00:00.000Z",
    readiness: { state: "green" } as unknown as SnapshotObject["readiness"],
    ...over,
  };
}

function point(id: string, sequence: number, completedAt: string): ListedSnapshot {
  return {
    id,
    objectId: MAILBOX_ID,
    sequence,
    itemCount: 1200,
    byteSize: 4096,
    startedAt: completedAt,
    completedAt,
    createdAt: completedAt,
    verification: { state: "unverified", checkedAt: null, reportId: null },
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("FileRestorePage", () => {
  let page: Mounted;

  beforeEach(() => {
    navigate.mockReset();
    fetchEndpoints.mockReset().mockResolvedValue([machine()]);
    fetchSnapshotObjects
      .mockReset()
      .mockResolvedValue([
        mailbox(),
        mailbox({ id: "drive", kind: "onedrive", displayName: "Drive" }),
      ]);
    fetchRestorePoints
      .mockReset()
      .mockResolvedValue([
        point(POINT_NEW, 7, "2026-09-30T08:00:00.000Z"),
        point(POINT_OLD, 6, "2026-09-29T08:00:00.000Z"),
      ]);
  });
  afterEach(() => page?.unmount());

  async function open(props: { machineId?: string | null; mailboxId?: string | null } = {}) {
    page = mount();
    await page.render(
      <FileRestorePage machineId={props.machineId ?? null} mailboxId={props.mailboxId ?? null} />,
    );
    await page.settle();
  }

  it("lists machines and mailboxes, without OneDrive, and chooses neither of two", async () => {
    await open();
    expect(page.byText("[data-slot='machine-list'] button", "web-01")).toBeTruthy();
    expect(page.byText("[data-slot='mailbox-list'] button", "Anna Berg")).toBeTruthy();
    expect(page.text()).not.toContain("Drive");
    expect(page.text()).toContain("Choose a machine or mailbox");
    expect(fetchRestorePoints).not.toHaveBeenCalled();
  });

  it("searches both groups at once", async () => {
    await open();
    const search = page.container.querySelector<HTMLInputElement>("input[type='search']");
    if (!search) throw new Error("no search");
    await page.type(search, "anna");
    expect(page.maybeByText("[data-slot='machine-list'] button", "web-01")).toBeNull();
    expect(page.byText("[data-slot='mailbox-list'] button", "Anna Berg")).toBeTruthy();
    await page.type(search, "nothing like it");
    expect(page.text()).toContain("No machine or mailbox matches the search.");
  });

  it("puts the chosen mailbox in the URL", async () => {
    await open();
    await page.click(page.byText("[data-slot='mailbox-list'] button", "Anna Berg"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/file-restore",
      search: { mailbox: MAILBOX_ID },
      replace: true,
    });
  });

  it("shows a mailbox's restore points on the timeline and opens the chosen one in the explorer", async () => {
    await open({ mailboxId: MAILBOX_ID });
    expect(fetchRestorePoints).toHaveBeenCalledWith(MAILBOX_ID);
    const items = [...document.querySelectorAll('[data-slot="mailbox-point-list"] li')];
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain("#7");
    expect(document.querySelectorAll('[data-slot="timeline-day"]')).toHaveLength(2);

    const link = () => document.querySelector<HTMLAnchorElement>('[data-slot="open-explorer"]');
    expect(link()?.getAttribute("href")).toBe("/restore");
    expect(JSON.parse(link()?.dataset.search ?? "{}")).toEqual({
      object: MAILBOX_ID,
      snapshot: POINT_NEW,
    });

    await page.click(items[1]?.querySelector("button") as HTMLButtonElement);
    expect(JSON.parse(link()?.dataset.search ?? "{}")).toEqual({
      object: MAILBOX_ID,
      snapshot: POINT_OLD,
    });
    expect(page.text()).toContain("Restore point #6");
  });

  it("chooses the only mailbox right away when there is no machine", async () => {
    fetchEndpoints.mockResolvedValue([]);
    await open();
    expect(fetchRestorePoints).toHaveBeenCalledWith(MAILBOX_ID);
  });

  it("keeps the machines usable when the mailboxes cannot be loaded", async () => {
    fetchSnapshotObjects.mockRejectedValue(new Error("boom"));
    fetchEndpoints.mockResolvedValue([machine(), machine({ id: "m-2", hostname: "db-01" })]);
    await open();
    expect(page.byText("[data-slot='machine-list'] button", "web-01")).toBeTruthy();
    expect(page.text()).toContain("The mailboxes could not be loaded.");
  });

  it("says when a mailbox from the URL is not backed up here", async () => {
    await open({ mailboxId: "55555555-5555-4555-8555-555555555555" });
    expect(page.text()).toContain("Mailbox not found");
  });
});
