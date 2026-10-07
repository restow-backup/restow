import { describe, expect, it } from "vitest";
import type { EndpointAttention, EndpointSummaryDto } from "../endpoints/dto.js";
import { summarizeEndpoints } from "./endpoints.js";

function machine(
  id: string,
  values: {
    profile?: "server" | "client";
    status?: "active" | "revoked";
    state?: EndpointSummaryDto["readiness"]["state"];
    attention?: EndpointAttention[];
    lastSuccessAt?: string | null;
  } = {},
): EndpointSummaryDto {
  return {
    id,
    hostname: id,
    displayName: null,
    os: "linux",
    arch: "amd64",
    profile: values.profile ?? "server",
    agentVersion: "0.1.0",
    osVersion: null,
    status: values.status ?? "active",
    connection: "online",
    agentState: "idle",
    lastSeenAt: "2026-09-30T10:00:00.000Z",
    lastBackupAt: values.lastSuccessAt ?? null,
    lastSuccessAt: values.lastSuccessAt ?? null,
    nextRunAt: null,
    readiness: {
      state: values.state ?? "green",
      checkedAt: null,
      overdue: false,
      basis: null,
      latestSnapshotId: null,
    },
    latestRun: null,
    attention: values.attention ?? [],
    job: null,
    assignedTo: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    revokedAt: values.status === "revoked" ? "2026-09-20T00:00:00.000Z" : null,
  };
}

describe("summarizeEndpoints", () => {
  it("reports zeros for a tenant without endpoints, which the page answers with no card", () => {
    expect(summarizeEndpoints([])).toEqual({
      protected: 0,
      machines: 0,
      withoutJob: 0,
      servers: 0,
      clients: 0,
      readiness: { green: 0, yellow: 0, red: 0, unverified: 0, noBackup: 0 },
      notReady: 0,
      failedLastBackup: 0,
      needingAttention: 0,
      otherAttention: 0,
      lastSuccessAt: null,
    });
  });

  it("counts servers and clients that are not revoked as protected", () => {
    const widget = summarizeEndpoints([
      machine("web", { profile: "server" }),
      machine("db", { profile: "server" }),
      machine("laptop", { profile: "client" }),
      machine("retired", { profile: "server", status: "revoked" }),
    ]);
    expect(widget).toMatchObject({ protected: 3, machines: 3, servers: 2, clients: 1 });
  });

  it("does not count a machine in no backup job as protected", () => {
    const widget = summarizeEndpoints([
      machine("web"),
      machine("orphan", { attention: ["no_job"] }),
      machine("old", { state: "green", attention: ["no_job"] }),
    ]);
    expect(widget).toMatchObject({ protected: 1, machines: 3, withoutJob: 2 });
    expect(widget.needingAttention).toBe(2);
    expect(widget.otherAttention).toBe(0);
  });

  it("rates the machines as the verify page does and sums what is not proven restorable", () => {
    const widget = summarizeEndpoints([
      machine("a", { state: "green" }),
      machine("b", { state: "green" }),
      machine("c", { state: "yellow" }),
      machine("d", { state: "red" }),
      machine("e", { state: "unverified" }),
      machine("f", { state: "unverified" }),
      // A machine still inside its first-backup grace is reported like the verify page does.
      machine("g", { state: "no_backup" }),
    ]);
    expect(widget.readiness).toEqual({ green: 2, yellow: 1, red: 1, unverified: 2, noBackup: 1 });
    // Red, unverified and without a backup: a yellow backup was proven restorable.
    expect(widget.notReady).toBe(4);
    expect(widget.protected).toBe(7);
  });

  it("leaves revoked machines out of every count, whatever they were rated", () => {
    const widget = summarizeEndpoints([
      machine("web", { state: "green", lastSuccessAt: "2026-09-29T10:00:00.000Z" }),
      machine("retired", {
        status: "revoked",
        state: "red",
        attention: ["last_backup_failed"],
        lastSuccessAt: "2026-09-30T09:00:00.000Z",
      }),
    ]);
    expect(widget.readiness).toEqual({ green: 1, yellow: 0, red: 0, unverified: 0, noBackup: 0 });
    expect(widget.notReady).toBe(0);
    expect(widget.failedLastBackup).toBe(0);
    expect(widget.needingAttention).toBe(0);
    expect(widget.lastSuccessAt).toBe("2026-09-29T10:00:00.000Z");
  });

  it("counts a failed last backup apart from the other reasons to look at a machine", () => {
    const widget = summarizeEndpoints([
      machine("failed", { attention: ["last_backup_failed"] }),
      machine("both", { attention: ["silent", "last_backup_failed"] }),
      machine("silent", { attention: ["silent"] }),
      machine("damaged", { state: "red", attention: ["repository_damaged"] }),
      machine("fine"),
    ]);
    expect(widget.failedLastBackup).toBe(2);
    expect(widget.needingAttention).toBe(4);
  });

  it("reports the newest good backup of the protected machines, or none", () => {
    expect(
      summarizeEndpoints([
        machine("old", { lastSuccessAt: "2026-09-01T00:00:00.000Z" }),
        machine("new", { lastSuccessAt: "2026-09-28T12:00:00.000Z" }),
        machine("never", { lastSuccessAt: null }),
      ]).lastSuccessAt,
    ).toBe("2026-09-28T12:00:00.000Z");
    expect(summarizeEndpoints([machine("never")]).lastSuccessAt).toBeNull();
  });
});
