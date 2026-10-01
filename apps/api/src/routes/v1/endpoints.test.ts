import { describe, expect, it } from "vitest";
import type { EndpointSummaryDto } from "../../features/endpoints/dto.js";
import { countEndpoints, endpointSchema, endpointsPageSchema, toEndpointDto } from "./endpoints.js";

const summary = (overrides: Partial<EndpointSummaryDto> = {}): EndpointSummaryDto => ({
  id: "6b1c4d2e-0000-4000-8000-000000000001",
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
  lastSeenAt: "2026-09-30T11:55:00.000Z",
  lastBackupAt: "2026-09-30T02:00:00.000Z",
  lastSuccessAt: "2026-09-30T02:00:00.000Z",
  nextRunAt: null,
  readiness: {
    state: "green",
    checkedAt: "2026-09-30T02:10:00.000Z",
    overdue: false,
    basis: "restore_test",
    latestSnapshotId: "a".repeat(64),
  },
  latestRun: null,
  attention: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  revokedAt: null,
  ...overrides,
});

describe("endpoints in the integration API", () => {
  it("maps a summary to the documented shape and keeps internal fields out", () => {
    const dto = toEndpointDto(summary());
    expect(endpointSchema.parse(dto)).toEqual(dto);
    expect(Object.keys(dto)).not.toContain("osVersion");
    expect(Object.keys(dto)).not.toContain("latestRun");
    expect(Object.keys(dto.readiness)).toEqual(["state", "checkedAt", "overdue"]);
  });

  it("lists a page with a total", () => {
    const page = { items: [toEndpointDto(summary())], total: 1 };
    expect(endpointsPageSchema.parse(page)).toEqual(page);
  });

  it("counts servers, clients, revoked ones and those needing attention", () => {
    const counts = countEndpoints([
      summary(),
      summary({
        profile: "client",
        attention: ["backup_overdue"],
        lastSuccessAt: "2026-09-29T00:00:00.000Z",
      }),
      summary({ status: "revoked", attention: ["silent"] }),
      summary({ attention: ["last_backup_failed"], lastSuccessAt: null }),
    ]);
    expect(counts).toEqual({
      total: 3,
      servers: 2,
      clients: 1,
      revoked: 1,
      needingAttention: 2,
      lastSuccessAt: "2026-09-30T02:00:00.000Z",
    });
    expect(countEndpoints([]).lastSuccessAt).toBeNull();
  });
});
