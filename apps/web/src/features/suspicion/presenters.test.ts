import { describe, expect, it } from "vitest";

import type { Suspicion } from "./api";
import {
  findingMessage,
  judgementsById,
  lastCleanOf,
  mayMarkFalseAlarm,
  mayReadSuspicions,
} from "./presenters";

function judged(restorePointId: string, active: boolean): Suspicion {
  return {
    id: `j-${restorePointId}`,
    objectKind: "endpoint",
    objectId: "o",
    runId: "r",
    restorePointId,
    restorePointAt: "2026-01-01T00:00:00Z",
    verdict: active ? "suspicious" : "none",
    active,
    findings: [],
    signals: {},
    signaturesVersion: "v",
    alerted: active,
    falseAlarm: null,
    judgedAt: "2026-01-01T00:00:00Z",
  };
}

const points = [
  { id: "d", time: "2026-01-04T00:00:00Z" },
  { id: "a", time: "2026-01-01T00:00:00Z" },
  { id: "c", time: "2026-01-03T00:00:00Z" },
  { id: "b", time: "2026-01-02T00:00:00Z" },
];

describe("the last clean restore point", () => {
  it("is nothing to point at while the newest restore point is clean or not judged", () => {
    expect(lastCleanOf(points, judgementsById([judged("c", true)]))).toBeNull();
    expect(lastCleanOf(points, new Map())).toBeNull();
  });

  it("is the newest one without findings below a run of suspicious ones", () => {
    const found = lastCleanOf(
      points,
      judgementsById([judged("d", true), judged("c", true), judged("b", false)]),
    );
    expect(found?.since.id).toBe("c");
    expect(found?.clean?.id).toBe("b");
  });

  it("counts a restore point made before the detection as without findings", () => {
    expect(lastCleanOf(points, judgementsById([judged("d", true)]))?.clean?.id).toBe("c");
  });

  it("is missing when every restore point is suspicious", () => {
    const all = judgementsById(points.map((point) => judged(point.id, true)));
    expect(lastCleanOf(points, all)).toEqual({ since: points[1], clean: null });
  });
});

describe("a finding in words", () => {
  it("formats files, bytes and shares in the reader's language", () => {
    expect(
      findingMessage({ code: "mass_deletions", value: 3000, threshold: 1000, share: 0.6 }, "en"),
    ).toEqual({
      key: "findings.mass_deletions",
      values: { value: "3,000", baseline: "0", threshold: "1,000", share: "60%", examples: "" },
    });
    const bytes = findingMessage(
      { code: "change_rate_bytes", value: 30 * 1024 ** 3, threshold: 1024 ** 3, baseline: 0 },
      "en",
    );
    expect(bytes.values.value).toMatch(/30 GB/);
    expect(findingMessage({ code: "something_new", value: 1, threshold: 1 }, "en").key).toBe(
      "findings.unknown",
    );
  });
});

describe("who may", () => {
  const base = { providerRole: null, providerAllTenants: false } as const;
  it("read: tenant administrators and provider admins", () => {
    expect(mayReadSuspicions({ ...base, role: "tenant_admin", isProviderAdmin: false })).toBe(true);
    expect(mayReadSuspicions({ ...base, role: "tenant_user", isProviderAdmin: false })).toBe(false);
  });

  it("mark a false alarm: tenant administrators and technicians and up", () => {
    expect(mayMarkFalseAlarm({ ...base, role: "tenant_admin", isProviderAdmin: false })).toBe(true);
    expect(
      mayMarkFalseAlarm({
        role: "provider_admin",
        isProviderAdmin: true,
        providerRole: "read_only",
        providerAllTenants: true,
      }),
    ).toBe(false);
    expect(
      mayMarkFalseAlarm({
        role: "provider_admin",
        isProviderAdmin: true,
        providerRole: "technician",
        providerAllTenants: true,
      }),
    ).toBe(true);
  });
});
