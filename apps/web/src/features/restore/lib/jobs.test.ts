import { describe, expect, it } from "vitest";

import type { RestoreItem, RestoreResult } from "@/features/restore/api";

import {
  countByFilter,
  etaMinutes,
  initialFilter,
  isCancellable,
  isLive,
  itemKind,
  matchesFilter,
  progressRatio,
  statusKey,
  statusTone,
} from "./jobs";

const result = (partial: Partial<RestoreResult> = {}): RestoreResult => ({
  restored: 3,
  skipped: 0,
  failures: 0,
  unverified: 0,
  folders: 0,
  bytes: 10,
  downloadKey: null,
  throttleWaits: 0,
  throttleWaitMs: 0,
  ...partial,
});

function item(partial: Partial<RestoreItem> & Pick<RestoreItem, "status">): RestoreItem {
  return {
    path: "mail/Inbox/a.eml",
    itemId: null,
    type: "mail",
    code: partial.status === "restored" ? "restored" : "error",
    targetRef: null,
    bytes: 0,
    verified: false,
    reason: null,
    ...partial,
  };
}

describe("status", () => {
  it("knows which jobs are still running", () => {
    expect(isLive({ status: "queued" })).toBe(true);
    expect(isLive({ status: "active" })).toBe(true);
    expect(isLive({ status: "completed" })).toBe(false);
    expect(isCancellable({ status: "failed" })).toBe(false);
  });

  it("never shows a restore with failed or unconfirmed items as a plain success", () => {
    expect(statusTone({ status: "completed", result: result() })).toBe("success");
    expect(statusTone({ status: "completed", result: result({ failures: 1 }) })).toBe("warning");
    expect(statusTone({ status: "completed", result: result({ unverified: 2 }) })).toBe("warning");
    expect(statusKey({ status: "completed", result: result({ failures: 1 }) })).toBe(
      "jobs.status.completedWithIssues",
    );
    expect(statusKey({ status: "failed", result: null })).toBe("jobs.status.failed");
    expect(statusTone({ status: "unknown", result: null })).toBe("muted");
  });
});

describe("progress", () => {
  it("is unknown until a total exists and never exceeds one", () => {
    expect(progressRatio(null)).toBeNull();
    expect(progressRatio({ total: 0, done: 0, failed: 0, bytes: 0, etaSeconds: null })).toBeNull();
    expect(progressRatio({ total: 10, done: 4, failed: 1, bytes: 0, etaSeconds: null })).toBe(0.5);
    expect(progressRatio({ total: 2, done: 3, failed: 0, bytes: 0, etaSeconds: null })).toBe(1);
  });

  it("rounds the estimate to whole minutes, at least one", () => {
    expect(etaMinutes({ total: 1, done: 0, failed: 0, bytes: 0, etaSeconds: 20 })).toBe(1);
    expect(etaMinutes({ total: 1, done: 0, failed: 0, bytes: 0, etaSeconds: 150 })).toBe(3);
    expect(etaMinutes({ total: 1, done: 0, failed: 0, bytes: 0, etaSeconds: null })).toBeNull();
  });
});

describe("item filters", () => {
  const items = [
    item({ status: "restored", verified: true }),
    item({ status: "restored", code: "unverified" }),
    item({ status: "skipped", code: "exists" }),
    item({ status: "failed", code: "target_rejected" }),
  ];

  it("groups outcomes, with anything not plainly restored needing attention", () => {
    expect(countByFilter(items)).toEqual({
      all: 4,
      attention: 3,
      failed: 1,
      skipped: 1,
      unverified: 1,
      restored: 1,
    });
    expect(items.filter((candidate) => matchesFilter(candidate, "restored"))).toHaveLength(1);
  });

  it("opens with the problems when there are any", () => {
    expect(initialFilter(items)).toBe("attention");
    expect(initialFilter([item({ status: "restored" })])).toBe("all");
  });

  it("maps engine item types onto explorer kinds", () => {
    expect(itemKind("message")).toBe("mail");
    expect(itemKind("event")).toBe("event");
    expect(itemKind("attachment")).toBe("file");
    expect(itemKind("folder")).toBe("folder");
  });
});
