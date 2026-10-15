// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PveGuest, PveOverview } from "@/features/pve/api";
import { i18n } from "@/i18n";

import type { EndpointSummary } from "./api.js";
import { type Mounted, mount } from "./dom-harness.js";
import { FileRestorePage } from "./file-restore-page.js";
import "./i18n.js";

/**
 * File restore lists the machines (servers and clients) and the Proxmox VE
 * containers with a restore point (#62). Mailboxes, OneDrives and IMAP
 * accounts never appear here: they are restored in the restore explorer, and
 * the page does not even ask for them.
 */

const session = vi.hoisted(() => ({ role: "tenant_admin" as string | null }));
vi.mock("@/lib/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/session")>();
  return {
    ...actual,
    useSession: () => ({
      status: "authenticated",
      activeTenant: { id: "t-1", name: "Contoso" },
      user: { id: "u-1" },
      role: session.role,
    }),
    useHasRole: (allowed: readonly string[]) => actual.canAccess(session.role, allowed),
  };
});
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
vi.mock("@/features/restore/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/restore/api")>();
  return {
    ...actual,
    fetchSnapshotObjects: (...args: unknown[]) => fetchSnapshotObjects(...args),
  };
});

const fetchOverview = vi.fn();
const fetchGuest = vi.fn();
const fetchContainerFiles = vi.fn();
vi.mock("@/features/pve/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/pve/api")>();
  return {
    ...actual,
    fetchOverview: (...args: unknown[]) => fetchOverview(...args),
    fetchGuest: (...args: unknown[]) => fetchGuest(...args),
    fetchContainerFiles: (...args: unknown[]) => fetchContainerFiles(...args),
  };
});

function guest(over: Partial<PveGuest> = {}): PveGuest {
  return {
    id: "g-ct",
    clusterId: "c-1",
    vmid: 300,
    kind: "ct",
    name: "paperless",
    node: "pve1",
    lastSuccessAt: "2026-10-14T22:05:00.000Z",
    backups: {
      first: null,
      last: { at: "2026-10-14T22:05:00.000Z", contains: 1, added: 1, unreadable: 0 },
    },
    ...over,
  } as PveGuest;
}

function overview(guests: PveGuest[]): PveOverview {
  return { clusters: [], guests, jobs: [], restorePool: "restow-restore" };
}

function machine(over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    lastBackupAt: null,
    ...over,
  } as EndpointSummary;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("FileRestorePage", () => {
  let page: Mounted;

  beforeEach(() => {
    navigate.mockReset();
    session.role = "tenant_admin";
    fetchOverview.mockReset().mockResolvedValue(overview([]));
    fetchGuest.mockReset();
    fetchContainerFiles.mockReset();
    fetchSnapshotObjects.mockReset().mockResolvedValue([]);
    fetchEndpoints
      .mockReset()
      .mockResolvedValue([machine(), machine({ id: "m-2", hostname: "db-01" })]);
  });
  afterEach(() => page?.unmount());

  async function open(machineId: string | null = null, containerId: string | null = null) {
    page = mount();
    await page.render(<FileRestorePage machineId={machineId} containerId={containerId} />);
    await page.settle();
  }

  it("lists the machines only and never asks for mailboxes", async () => {
    await open();
    expect(page.byText("[data-slot='machine-list'] button", "web-01")).toBeTruthy();
    expect(page.byText("[data-slot='machine-list'] button", "db-01")).toBeTruthy();
    expect(document.querySelector("[data-slot='mailbox-list']")).toBeNull();
    expect(fetchSnapshotObjects).not.toHaveBeenCalled();
    expect(page.text()).toContain("Choose a machine");
  });

  it("searches the machines", async () => {
    await open();
    const search = page.container.querySelector<HTMLInputElement>("input[type='search']");
    if (!search) throw new Error("no search");
    await page.type(search, "db");
    expect(page.maybeByText("[data-slot='machine-list'] button", "web-01")).toBeNull();
    expect(page.byText("[data-slot='machine-list'] button", "db-01")).toBeTruthy();
    await page.type(search, "nothing like it");
    expect(page.text()).toContain("No machine matches the search.");
  });

  it("puts the chosen machine in the URL", async () => {
    await open();
    await page.click(page.byText("[data-slot='machine-list'] button", "db-01"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/file-restore",
      search: { machine: "m-2" },
      replace: true,
    });
  });

  it("lists revoked machines apart, and only while they have a backup (#65)", async () => {
    fetchEndpoints.mockResolvedValue([
      machine(),
      machine({
        id: "m-3",
        hostname: "paperless",
        status: "revoked",
        lastBackupAt: "2026-09-30T09:03:00.000Z",
      }),
      machine({ id: "m-4", hostname: "old-laptop", status: "revoked", lastBackupAt: null }),
    ]);
    await open();
    expect(page.maybeByText("[data-slot='machine-list'] button", "paperless")).toBeNull();
    const revoked = page.byText("[data-slot='revoked-machine-list'] button", "paperless");
    expect(revoked.textContent).toContain("Revoked");
    expect(page.text()).toContain("Revoked machines");
    expect(page.text()).not.toContain("old-laptop");
  });

  it("points to the inventory when the tenant has no machine", async () => {
    fetchEndpoints.mockResolvedValue([]);
    await open();
    expect(page.text()).toContain("Nothing backed up yet");
    expect(document.querySelector("[data-slot='machine-picker']")).toBeNull();
  });

  it("lists the containers with a restore point in their own group, by schedule or by hand (#62)", async () => {
    fetchOverview.mockResolvedValue(
      overview([
        guest(),
        // Backed up by hand, in no job: listed all the same.
        guest({ id: "g-ct2", vmid: 301, name: null, jobId: null }),
        // Never backed up: nothing to restore.
        guest({
          id: "g-ct3",
          vmid: 302,
          name: "new",
          lastSuccessAt: null,
          backups: { first: null, last: null },
        }),
        guest({ id: "g-vm", vmid: 100, kind: "vm", name: "web" }),
      ]),
    );
    await open();
    expect(page.text()).toContain("Machines, VMs and containers");
    expect(page.text()).toContain("Proxmox VE containers");
    const row = page.byText("[data-slot='container-list'] button", "paperless");
    expect(row.textContent).toContain("CT 300 on pve1");
    expect(page.byText("[data-slot='container-list'] button", "CT 301")).toBeTruthy();
    expect(page.maybeByText("[data-slot='container-list'] button", "new")).toBeNull();
    expect(page.maybeByText("[data-slot='container-list'] button", "web")).toBeNull();
    // VMs have a group of their own: their disks' files are browsed the same way.
    const vm = page.byText("[data-slot='vm-list'] button", "web");
    expect(vm.textContent).toContain("VM 100 on pve1");
    // Reading files from VM disks is new, and the group says so.
    const preview = page.container.querySelector("[data-slot='vm-preview']");
    expect(preview?.textContent).toBe("Preview");
    expect(preview?.closest("h3")?.textContent).toContain("Proxmox VE VMs");
    // With containers there, the one machine is not chosen on its own.
    expect(page.text()).toContain("Choose a machine, VM or container");

    await page.click(row);
    expect(navigate).toHaveBeenCalledWith({
      to: "/file-restore",
      search: { container: "g-ct" },
      replace: true,
    });
  });

  it("searches the containers by name and VMID", async () => {
    fetchOverview.mockResolvedValue(
      overview([guest(), guest({ id: "g-2", vmid: 410, name: "dns" })]),
    );
    await open();
    const search = page.container.querySelector<HTMLInputElement>("input[type='search']");
    if (!search) throw new Error("no search");
    expect(search.placeholder).toBe("Search machines, VMs and containers");
    await page.type(search, "410");
    expect(page.maybeByText("[data-slot='container-list'] button", "paperless")).toBeNull();
    expect(page.byText("[data-slot='container-list'] button", "dns")).toBeTruthy();
    await page.type(search, "nothing like it");
    expect(page.text()).toContain("No machine, VM or container matches the search.");
  });

  it("shows a container's restore points, what they contain, and offers the ZIP only", async () => {
    fetchOverview.mockResolvedValue(overview([guest()]));
    fetchGuest.mockResolvedValue({
      guest: guest(),
      cluster: null,
      runs: [],
      snapshots: [
        {
          id: "p-1",
          sequence: 1,
          kind: "ct",
          archiveName: "ct/300/2026-10-14T22:00:00Z",
          origin: "pve",
          backupAt: "2026-10-14T22:00:00.000Z",
          byteSize: 2_000_000,
          added: 1000,
          contents: ["/", "/mnt/data"],
          browsable: true,
          disks: [],
          verify: null,
        },
      ],
    });
    fetchContainerFiles.mockResolvedValue({
      snapshotId: "p-1",
      path: "/",
      entries: [{ name: "opt", path: "/opt", type: "dir", size: null, mtime: null }],
      nextCursor: null,
    });
    await open(null, "g-ct");
    expect(fetchGuest).toHaveBeenCalledWith("g-ct");
    const point = document.querySelector("[data-slot='snapshot-list'] li button");
    if (!point) throw new Error("no restore point");
    await page.click(point);
    expect(fetchContainerFiles).toHaveBeenCalledWith("p-1", "/", null);
    const contents = document.querySelector("[data-slot='restore-point-contents']");
    expect(contents?.textContent).toContain("This restore point contains:");
    expect(contents?.textContent).toContain("/ (the whole container)");
    expect(contents?.textContent).toContain("/mnt/data");
    // The whole root file system is backed up: no hint about a job's folders.
    expect(document.querySelector("[data-slot='restore-point-contents-hint']")).toBeNull();
    const bar = document.querySelector("[data-slot='selection-bar']");
    expect(bar?.textContent).toContain("Download as ZIP");
    expect(bar?.textContent).not.toContain("Restore to the machine");
    expect(page.text()).toContain("Files of a container are downloaded as a ZIP.");
    // A path in the list opens that folder.
    const mount = page.byText("[data-slot='restore-point-contents'] button", "/mnt/data");
    await page.click(mount);
    expect(fetchContainerFiles).toHaveBeenCalledWith("p-1", "/mnt/data", null);
  });

  it("lets a restore operator browse and download a container's files, without the guest's page", async () => {
    session.role = "tenant_restore";
    fetchOverview.mockResolvedValue(
      overview([guest(), guest({ id: "g-vm", vmid: 100, kind: "vm", name: "web" })]),
    );
    fetchGuest.mockResolvedValue({
      guest: guest(),
      cluster: null,
      runs: [],
      snapshots: [
        {
          id: "p-1",
          sequence: 1,
          kind: "ct",
          archiveName: "ct/300/2026-10-14T22:00:00Z",
          origin: "pve",
          backupAt: "2026-10-14T22:00:00.000Z",
          byteSize: 2_000_000,
          added: 1000,
          contents: ["/"],
          browsable: true,
          disks: [],
          verify: null,
        },
      ],
    });
    fetchContainerFiles.mockResolvedValue({
      snapshotId: "p-1",
      path: "/",
      entries: [{ name: "opt", path: "/opt", type: "dir", size: null, mtime: null }],
      nextCursor: null,
    });
    await open(null, "g-ct");
    expect(fetchOverview).toHaveBeenCalled();
    expect(page.byText("[data-slot='container-list'] button", "paperless")).toBeTruthy();
    expect(page.byText("[data-slot='vm-list'] button", "web")).toBeTruthy();
    const point = document.querySelector("[data-slot='snapshot-list'] li button");
    if (!point) throw new Error("no restore point");
    await page.click(point);
    expect(fetchContainerFiles).toHaveBeenCalledWith("p-1", "/", null);
    expect(document.querySelector("[data-slot='selection-bar']")?.textContent).toContain(
      "Download as ZIP",
    );
    expect(page.text()).toContain(
      "Files of a container are downloaded as a ZIP. Putting the whole container back is up to an administrator.",
    );
    expect(page.text()).not.toContain("Open the container");
    expect(document.querySelector("a[href^='/virtualization']")).toBeNull();
  });

  it("does not send a restore operator to the inventory when nothing is backed up", async () => {
    session.role = "tenant_restore";
    fetchEndpoints.mockResolvedValue([]);
    await open();
    expect(page.text()).toContain("Nothing backed up yet");
    expect(page.text()).toContain("you can restore its files here");
    expect(page.text()).not.toContain("Open inventory");
  });

  it("asks nothing of Proxmox VE for a role that may not open it", async () => {
    session.role = "tenant_user";
    await open();
    expect(fetchOverview).not.toHaveBeenCalled();
    expect(page.text()).toContain("Choose a machine");
    expect(page.text()).not.toContain("Proxmox VE containers");
  });
});
