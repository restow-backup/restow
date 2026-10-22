import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { count, render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { EndpointSummary, RunSummary } from "../api.js";
import "../i18n.js";
import { EndpointsTable } from "./endpoints-table.js";

// The name links become plain anchors, so the table renders outside a <RouterProvider>.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
      ...props
    }: {
      to: string;
      className?: string;
      children: React.ReactNode;
    }) => (
      <a href={String(to)} className={className} {...props}>
        {children}
      </a>
    ),
  };
});

// The job actions read who may change jobs from the session; here the viewer may.
vi.mock("@/features/backup-jobs/components/access-note", () => ({
  useJobsAccess: () => ({ block: null, closed: false, noteId: "note", reason: undefined }),
  closedProps: () => ({}),
}));

// So may the assignment; "Back up now" needs no query client to be rendered.
vi.mock("@/features/tenant-page/access", () => ({ useTenantWriteBlock: () => null }));
// "Back up now" for a selection runs through the jobs' actions: no session or query client here.
vi.mock("@/features/backup-jobs/components/job-actions", () => ({
  useJobActions: () => ({ runNow: () => {}, running: false }),
}));
vi.mock("../hooks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hooks.js")>()),
  useBackupNow: () => ({ request: () => {}, pending: false }),
  useRefreshEndpoint: () => () => Promise.resolve([]),
}));

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "r1",
    kind: "backup",
    status: "succeeded",
    startedAt: "2026-09-30T09:00:00.000Z",
    finishedAt: "2026-09-30T09:03:00.000Z",
    snapshotId: "s1",
    errorCount: 0,
    interruptedOnly: false,
    checkIncomplete: false,
    failure: null,
    filesNew: 10,
    dataAdded: 1000,
    totalBytesProcessed: 5000,
    progress: null,
    ...over,
  };
}

function endpoint(over: Partial<EndpointSummary> = {}): EndpointSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: "server",
    agentVersion: "0.1.0",
    osVersion: "Debian 12",
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
    latestRun: run(),
    attention: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

function table(
  items: readonly EndpointSummary[] | undefined,
  props: Partial<React.ComponentProps<typeof EndpointsTable>> = {},
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <EndpointsTable
        area="servers"
        items={items}
        loading={false}
        fetching={false}
        error={null}
        onRetry={() => {}}
        empty={<p data-testid="empty">Nothing here</p>}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("EndpointsTable", () => {
  it("lists a machine with its name and system, the name leading to its page", () => {
    const html = table([
      endpoint({ displayName: "Web front", hostname: "web-01", os: "darwin", arch: "arm64" }),
    ]);
    expect(html).toContain("Web front");
    expect(html).toContain("macOS");
    expect(html).toContain("arm64");
    expect(html).toContain('href="/inventory/11111111-1111-4111-8111-111111111111"');
  });

  it("makes the name the button that opens the details when the page has a panel", () => {
    const html = table([endpoint()], { onOpen: () => {} });
    expect(html).toContain('data-machine-name="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-label="Show details of web-01"');
  });

  it("uses the host name when the machine has no label", () => {
    const html = table([endpoint()]);
    expect(count(html, ">web-01<")).toBeGreaterThanOrEqual(1);
  });

  it("shows one state per machine: a passed restore check of a machine in a job", () => {
    const html = table([endpoint({ job: { id: "job-1", name: "Web servers" } })]);
    expect(count(html, 'data-slot="machine-status"')).toBe(1);
    expect(html).toContain('data-status="verified"');
    expect(html).toContain("Restore check passed");
    expect(html).toContain("<time");
    expect(html).toContain("Servers");
  });

  it("marks a failed or partial last backup, and counts what else is wrong", () => {
    const failed = table([
      endpoint({
        latestRun: run({ status: "failed" }),
        attention: ["last_backup_failed", "silent"],
      }),
    ]);
    expect(failed).toContain('data-status="failed"');
    expect(failed).toContain("Backup failed");
    expect(failed).toContain('data-slot="machine-more-states"');
    expect(table([endpoint({ latestRun: run({ status: "partial" }) })])).toContain(
      'data-status="partial"',
    );
  });

  it("shows a run that was only interrupted as such, not as a failure", () => {
    const html = table([
      endpoint({
        latestRun: run({ status: "failed", errorCount: 1, interruptedOnly: true }),
        attention: [],
      }),
    ]);
    expect(html).toContain('data-status="interrupted"');
    expect(html).not.toContain('data-status="failed"');
  });

  it("says when a backup is running now, with its progress and a Stop button", () => {
    const html = table(
      [
        endpoint({
          latestRun: run({
            status: "running",
            finishedAt: null,
            progress: { filesDone: 5, bytesDone: 50, totalBytes: 200, updatedAt: "x" },
          }),
        }),
      ],
      { canManageJobs: true },
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain('aria-valuenow="25"');
    expect(html).toContain('data-action="stop"');
    expect(html).toContain("Stop backup");
  });

  it("says Stopping once a stop was asked for", () => {
    const html = table([
      endpoint({
        latestRun: run({
          status: "running",
          finishedAt: null,
          cancelRequestedAt: "2026-09-30T09:01:00.000Z",
        }),
      }),
    ]);
    expect(html).toContain('data-status="cancelling"');
    expect(html).toContain('data-action="stopping"');
  });

  it("rates a machine that never had a backup, and one that is unverified", () => {
    const html = table([
      endpoint({
        id: "a",
        hostname: "new-box",
        lastBackupAt: null,
        latestRun: null,
        readiness: {
          state: "no_backup",
          checkedAt: null,
          overdue: true,
          basis: null,
          latestSnapshotId: null,
        },
      }),
      endpoint({
        id: "b",
        hostname: "old-box",
        readiness: {
          state: "unverified",
          checkedAt: null,
          overdue: false,
          basis: null,
          latestSnapshotId: "s",
        },
      }),
    ]);
    expect(html).toContain("No backup yet");
    expect(html).toContain('data-status="unverified"');
  });

  it("names the job of a machine, links it, and says when one is in no job", () => {
    const html = table([
      endpoint({ id: "a", hostname: "in-job", job: { id: "job-1", name: "Web servers" } }),
      endpoint({ id: "b", hostname: "no-job", job: null, attention: ["no_job"] }),
    ]);
    expect(html).toContain("Backup job");
    expect(html).toContain("Web servers");
    expect(html).toContain('href="/jobs/definitions/job-1"');
    expect(html).toContain('data-status="no_job"');
  });

  it("gives every machine one action button and its menu, closed for those who may only look", () => {
    const items = [
      endpoint({ id: "a", hostname: "in-job", job: { id: "job-1", name: "Web servers" } }),
      endpoint({ id: "b", hostname: "no-job", job: null }),
    ];
    const plain = table(items);
    expect(count(plain, 'aria-label="Actions for')).toBe(2);
    expect(count(plain, 'data-slot="machine-action"')).toBe(2);
    expect(plain).not.toContain('role="checkbox"');
    // A viewer who may not manage jobs sees the button closed, with the reason.
    const buttons = plain.match(/<button[^>]*data-action="backup"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.includes('disabled=""'))).toBe(true);
    const html = table(items, { canManageJobs: true });
    expect(html).toContain('aria-label="Select no-job"');
    expect(html).toContain('aria-label="Select all rows on this page"');
    expect(html).toContain('aria-label="Back up now: in-job"');
  });

  it("says whom a machine is assigned to, and nobody when it is not", () => {
    const html = table([
      endpoint({
        id: "a",
        hostname: "laptop-01",
        assignedTo: { id: "u1", displayName: "Alice Example", email: "alice@example.com" },
      }),
      endpoint({
        id: "b",
        hostname: "laptop-02",
        assignedTo: { id: "u2", displayName: null, email: "bob@example.com" },
      }),
      endpoint({ id: "c", hostname: "laptop-03", assignedTo: null }),
    ]);
    expect(html).toContain("Assigned to");
    expect(html).toContain("Alice Example");
    expect(html).toContain("bob@example.com");
    expect(html).toContain(">Nobody<");
    // A filter by person (and nobody) beside the search.
    expect(html).toMatch(/border-dashed[^>]*>.*?Assigned to<\/button>/);
  });

  it("hides a revoked machine until revoked machines are shown (#65)", () => {
    const html = table([
      endpoint({ status: "revoked", revokedAt: "2026-09-29T00:00:00.000Z", connection: "online" }),
    ]);
    expect(html).toContain("Show revoked machines (1)");
    expect(html).toContain("Only revoked machines");
    expect(html).not.toContain("opacity-60");
  });

  it("does not grey out a machine that is in use", () => {
    expect(table([endpoint()])).not.toContain("opacity-60");
  });

  it("shows the type and the agent version only in the agents list", () => {
    const servers = table([endpoint()], { area: "servers" });
    expect(servers).not.toContain("Agent version");
    expect(servers).not.toContain("0.1.0");
    const agents = table(
      [endpoint(), endpoint({ id: "c", hostname: "laptop", profile: "client" })],
      { area: "agents" },
    );
    expect(agents).toContain("Agent version");
    expect(agents).toContain("0.1.0");
    expect(agents).toContain("Type");
  });

  it("shows the empty state passed by the page", () => {
    const html = table([]);
    expect(html).toContain('data-testid="empty"');
    expect(html).not.toContain("/inventory/");
  });

  it("shows skeleton rows while loading and the cause when loading failed", () => {
    expect(table(undefined, { loading: true })).toContain('data-slot="skeleton"');
    const failed = table(undefined, { error: new Error("boom") });
    expect(failed).toContain("The machines could not be loaded");
    expect(failed).toContain("Retry");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    try {
      const html = table([endpoint({ attention: ["silent"] })]);
      expect(html).toContain("Letzte Sicherung");
      expect(html).toContain("Meldet sich nicht");
      expect(html).toContain("Zustand");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
