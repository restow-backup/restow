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
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className} {...props}>
        {children}
      </a>
    ),
  };
});

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
    <EndpointsTable
      area="servers"
      items={items}
      loading={false}
      fetching={false}
      error={null}
      onRetry={() => {}}
      empty={<p data-testid="empty">Nothing here</p>}
      {...props}
    />,
  );
}

describe("EndpointsTable", () => {
  it("lists a machine with its name, host name, system and links to its page", () => {
    const html = table([
      endpoint({ displayName: "Web front", hostname: "web-01", os: "darwin", arch: "arm64" }),
    ]);
    expect(html).toContain("Web front");
    expect(html).toContain("web-01");
    expect(html).toContain("macOS");
    expect(html).toContain("arm64");
    expect(html).toContain('href="/inventory/11111111-1111-4111-8111-111111111111"');
  });

  it("uses the host name when the machine has no label", () => {
    const html = table([endpoint()]);
    expect(html).toContain("web-01");
    expect(count(html, ">web-01<")).toBeGreaterThanOrEqual(1);
  });

  it("shows the connection, the last backup and the readiness", () => {
    const html = table([endpoint()]);
    expect(html).toContain("Online");
    expect(html).toContain("<time");
    expect(html).toContain("Ready");
    expect(html).toContain("Servers");
  });

  it("marks a failed or partial last backup", () => {
    expect(
      table([
        endpoint({ latestRun: run({ status: "failed" }), attention: ["last_backup_failed"] }),
      ]),
    ).toContain("Failed");
    expect(table([endpoint({ latestRun: run({ status: "partial" }) })])).toContain("Partial");
  });

  it("shows a run that was only interrupted as such, not as a failure", () => {
    const html = table([
      endpoint({
        latestRun: run({ status: "failed", errorCount: 1, interruptedOnly: true }),
        attention: [],
      }),
    ]);
    expect(html).toContain("Interrupted");
    expect(html).not.toContain(">Failed<");
  });

  it("says when a backup is running now", () => {
    const html = table([endpoint({ latestRun: run({ status: "running", finishedAt: null }) })]);
    expect(html).toContain("Backup running");
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
    expect(html).toContain("Not verified");
  });

  it("hints when the restore test is overdue", () => {
    const html = table([
      endpoint({
        readiness: {
          state: "yellow",
          checkedAt: null,
          overdue: true,
          basis: "restore_test",
          latestSnapshotId: "s",
        },
      }),
    ]);
    expect(html).toContain("Overdue");
    expect(html).toContain("Attention");
  });

  it("lists what needs attention", () => {
    const html = table([
      endpoint({ attention: ["silent", "last_backup_failed", "backup_overdue", "never_seen"] }),
    ]);
    expect(html).toContain('data-attention="last_backup_failed"');
    expect(html).toContain('data-attention="silent"');
    expect(html).toContain("Last backup failed");
    // Two are shown, the rest is counted.
    expect(html).toContain("+2 more");
  });

  it("greys a revoked machine out and says it is revoked", () => {
    const html = table([
      endpoint({ status: "revoked", revokedAt: "2026-09-29T00:00:00.000Z", connection: "online" }),
    ]);
    expect(html).toContain("Revoked");
    expect(html).toContain("opacity-60");
    expect(html).not.toContain(">Online<");
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
    expect(agents).toContain('href="/inventory/11111111-1111-4111-8111-111111111111"');
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
      expect(html).toContain("Bereit");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
