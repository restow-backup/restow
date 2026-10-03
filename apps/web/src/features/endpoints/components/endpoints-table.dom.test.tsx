// @vitest-environment happy-dom
import { act } from "react";
import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { adminSession } from "@/features/backup-jobs/testing";
import {
  type Mounted,
  enableActEnvironment,
  flush,
  installMemoryStorage,
  json,
  mount,
  newQueryClient,
  routedFetch,
} from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { queryKeys } from "@/lib/api";

import type { EndpointSummary } from "../api.js";
import "../i18n.js";
import { EndpointsTable } from "./endpoints-table.js";

// Links become plain anchors with their search, so the table renders outside a router.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      search,
      children,
      ...props
    }: { to: string; search?: Record<string, unknown>; children: React.ReactNode }) => {
      const query = search ? new URLSearchParams(search as Record<string, string>).toString() : "";
      return (
        <a href={query ? `${to}?${query}` : String(to)} {...props}>
          {children}
        </a>
      );
    },
  };
});

/**
 * The machine table's row actions (release 0.2.1): the context menu of a row with what can be
 * done with the machine, "Back up now" closed with its reason for a machine in no job, the
 * assignment to a person of the directory, and a new job from several selected machines.
 */

enableActEnvironment();

let mounted: Mounted | null = null;

beforeAll(async () => {
  installMemoryStorage();
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const ALICE = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  displayName: "Alice Example",
  email: "alice@example.com",
};
const BOB = {
  id: "aaaaaaaa-0000-4000-8000-000000000002",
  displayName: null,
  email: "bob@example.com",
};

function machine(over: Partial<EndpointSummary>): EndpointSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.2.1",
    osVersion: null,
    status: "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-09-30T09:58:00.000Z",
    lastBackupAt: "2026-09-30T09:03:00.000Z",
    lastSuccessAt: "2026-09-30T09:03:00.000Z",
    nextRunAt: null,
    readiness: {
      state: "green",
      checkedAt: "2026-09-29T09:00:00.000Z",
      overdue: false,
      basis: "restore_test",
      latestSnapshotId: "s1",
    },
    latestRun: null,
    attention: [],
    job: { id: "job-1", name: "Web servers" },
    assignedTo: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

const IN_JOB = machine({ id: "11111111-1111-4111-8111-111111111111", hostname: "web-01" });
const NO_JOB = machine({
  id: "22222222-2222-4222-8222-222222222222",
  hostname: "laptop-01",
  profile: "client",
  job: null,
  readiness: {
    state: "no_backup",
    checkedAt: null,
    overdue: false,
    basis: null,
    latestSnapshotId: null,
  },
  assignedTo: ALICE,
});

async function open(routes: Parameters<typeof routedFetch>[0] = {}, canManageJobs = true) {
  const { mock, requests } = routedFetch({
    "GET /setup/state": () =>
      json({ configured: true, demo: { enabled: false, email: null, password: null } }),
    ...routes,
  });
  vi.stubGlobal("fetch", mock);
  const queryClient = newQueryClient();
  queryClient.setQueryData(queryKeys.setupState, {
    configured: true,
    demo: { enabled: false, email: null, password: null },
  });
  mounted = mount(
    <EndpointsTable
      area="agents"
      items={[IN_JOB, NO_JOB]}
      loading={false}
      fetching={false}
      error={null}
      onRetry={() => {}}
      empty={null}
      canManageJobs={canManageJobs}
    />,
    { session: adminSession(), queryClient },
  );
  await flush(4);
  return { requests };
}

const row = (hostname: string) =>
  [...document.querySelectorAll<HTMLElement>("tbody tr")].find((candidate) =>
    candidate.textContent?.includes(hostname),
  ) as HTMLElement;
const menu = () => document.querySelector<HTMLElement>('[data-slot="row-context-menu"]');
const entry = (id: string) => menu()?.querySelector<HTMLElement>(`[data-action="${id}"]`);

async function rightClick(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 9 }),
    );
  });
  await flush(2);
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush(6);
}

describe("the actions of a machine", () => {
  it("opens the machine's actions on a right click, with the job actions where it has none", async () => {
    await open();
    await rightClick(row("web-01").querySelectorAll("td")[3] as HTMLElement);
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for web-01");
    expect(entry("open")?.getAttribute("href")).toBe(
      "/inventory/11111111-1111-4111-8111-111111111111",
    );
    expect(entry("restore")?.getAttribute("href")).toBe(
      "/file-restore?machine=11111111-1111-4111-8111-111111111111",
    );
    expect(entry("backup")?.hasAttribute("data-disabled")).toBe(false);
    expect(entry("createJob")).toBeNull();
    expect(entry("assign")).not.toBeNull();
  });

  it("closes Back up now and Restore files for a machine in no job without a backup, and says why", async () => {
    await open();
    await rightClick(row("laptop-01").querySelectorAll("td")[3] as HTMLElement);
    const backup = entry("backup");
    expect(backup?.hasAttribute("data-disabled")).toBe(true);
    expect(backup?.textContent).toContain("Add the machine to a backup job first.");
    expect(entry("restore")?.hasAttribute("data-disabled")).toBe(true);
    expect(entry("createJob")?.getAttribute("href")).toBe(
      "/jobs?type=endpoint&new=1&select=22222222-2222-4222-8222-222222222222",
    );
    expect(entry("addToJob")).not.toBeNull();
  });

  it("asks for a backup of a machine in a job", async () => {
    const { requests } = await open({
      "POST /endpoints/11111111-1111-4111-8111-111111111111/tasks": () =>
        json({ task: { id: "t1" }, alreadyQueued: false }, 202),
    });
    await rightClick(row("web-01").querySelectorAll("td")[3] as HTMLElement);
    await click(entry("backup"));
    expect(requests.find((request) => request.method === "POST")).toMatchObject({
      path: "/endpoints/11111111-1111-4111-8111-111111111111/tasks",
      body: { kind: "backup_now" },
    });
  });
});

describe("assigning a machine to a person", () => {
  it("shows the person in the table and assigns another one from the directory", async () => {
    const { requests } = await open({
      "GET /directory/people": () => json({ items: [ALICE, BOB], more: false }),
      "PATCH /endpoints/22222222-2222-4222-8222-222222222222": () =>
        json({ configVersion: 1, changed: ["assignedUserId"] }),
    });
    expect(row("laptop-01").textContent).toContain("Alice Example");
    expect(row("web-01").textContent).toContain("Nobody");

    await rightClick(row("laptop-01").querySelectorAll("td")[3] as HTMLElement);
    await click(entry("assign"));
    const dialog = document.querySelector<HTMLElement>('[data-slot="assign-dialog"]');
    expect(dialog?.textContent).toContain("Assign laptop-01 to a person");
    // The current person is marked and cannot be chosen again.
    const current = dialog?.querySelector<HTMLButtonElement>(`[data-person="${ALICE.id}"]`);
    expect(current?.disabled).toBe(true);
    expect(current?.getAttribute("aria-current")).toBe("true");
    await click(dialog?.querySelector(`[data-person="${BOB.id}"]`));
    expect(requests.find((request) => request.method === "PATCH")).toMatchObject({
      path: "/endpoints/22222222-2222-4222-8222-222222222222",
      body: { assignedUserId: BOB.id },
    });
    expect(document.querySelector('[data-slot="assign-dialog"]')).toBeNull();
  });

  it("removes the assignment", async () => {
    const { requests } = await open({
      "GET /directory/people": () => json({ items: [ALICE], more: false }),
      "PATCH /endpoints/22222222-2222-4222-8222-222222222222": () =>
        json({ configVersion: 1, changed: ["assignedUserId"] }),
    });
    await rightClick(row("laptop-01").querySelectorAll("td")[3] as HTMLElement);
    await click(entry("assign"));
    await click(document.querySelector('[data-action="unassign"]'));
    expect(requests.find((request) => request.method === "PATCH")?.body).toEqual({
      assignedUserId: null,
    });
  });
});

describe("several machines at once", () => {
  it("makes a new job from the selected machines", async () => {
    await open();
    for (const hostname of ["web-01", "laptop-01"]) {
      await click(row(hostname).querySelector('[role="checkbox"]'));
    }
    const bar = document.querySelector<HTMLElement>('[data-slot="data-table-selection"]');
    expect(bar?.textContent).toContain("2 rows selected");
    const link = bar?.querySelector('[data-action="newJobFromSelection"]');
    expect(link?.textContent).toBe("New job with 2 machines");
    expect(link?.getAttribute("href")).toBe(
      "/jobs?type=endpoint&new=1&select=11111111-1111-4111-8111-111111111111%2C22222222-2222-4222-8222-222222222222",
    );
    await rightClick(row("web-01").querySelectorAll("td")[3] as HTMLElement);
    expect(menu()?.getAttribute("aria-label")).toBe("Actions for 2 selected rows");
    expect(entry("newJobFromSelection")).not.toBeNull();
    expect(entry("addSelectionToJob")).not.toBeNull();
  });

  it("offers no selection to a viewer who may not manage jobs", async () => {
    await open({}, false);
    expect(document.querySelector('tbody [role="checkbox"]')).toBeNull();
  });
});
