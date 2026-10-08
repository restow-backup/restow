import { describe, expect, it } from "vitest";

import type { StorageTargetDto, StorageTargetList } from "@/features/storage/types";

import type { ChainVerification } from "./api.js";
import {
  ARCHIVE_PAGE_SIZE,
  NO_FILTERS,
  archiveProtectionOf,
  chainVerdictOf,
  dayBoundary,
  invertedRange,
  isFiltered,
  pageRange,
  searchParamsOf,
} from "./presenters.js";

function target(patch: Partial<StorageTargetDto>): StorageTargetDto {
  return {
    id: "t1",
    name: "Primary",
    kind: "s3",
    role: "primary",
    location: "s3://bucket",
    local: null,
    s3: null,
    configValid: true,
    status: "ok",
    errorMessage: null,
    checkedAt: null,
    lastProbe: null,
    objectLock: null,
    canManage: true,
    migration: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}

function list(items: StorageTargetDto[], defaultKind: "local" | "s3" | null = null) {
  return {
    items,
    installationDefault: {
      inUse: defaultKind !== null,
      kind: defaultKind,
      location: null,
      hasCopy: false,
      copyLocation: null,
      misconfigured: false,
    },
    tenantHasData: true,
    canManageLocal: true,
  } satisfies StorageTargetList;
}

describe("archive search filters", () => {
  it("turns a day into the start or the end of that day in the viewer's zone", () => {
    const start = dayBoundary("2026-03-01", false);
    const end = dayBoundary("2026-03-01", true);
    expect(new Date(start as string).getHours()).toBe(0);
    expect(new Date(end as string).getHours()).toBe(23);
    expect(new Date(end as string).getMinutes()).toBe(59);
    expect(dayBoundary("", false)).toBeNull();
    expect(dayBoundary("01.03.2026", false)).toBeNull();
  });

  it("leaves empty filters out and asks for one page at the offset", () => {
    expect(searchParamsOf(NO_FILTERS, 0)).toEqual({
      q: undefined,
      from: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      mailbox: undefined,
      hasAttachment: undefined,
      limit: ARCHIVE_PAGE_SIZE,
      offset: 0,
    });
    const params = searchParamsOf(
      {
        q: "  invoice ",
        from: " cfo@contoso.test ",
        dateFrom: "2026-01-01",
        dateTo: "2026-01-31",
        mailbox: "m-1",
        hasAttachment: true,
      },
      100,
    );
    expect(params).toMatchObject({
      q: "invoice",
      from: "cfo@contoso.test",
      mailbox: "m-1",
      hasAttachment: true,
      offset: 100,
    });
    expect(params.dateFrom).toBe(dayBoundary("2026-01-01", false));
    expect(params.dateTo).toBe(dayBoundary("2026-01-31", true));
  });

  it("knows when the filters narrow the search and when the range is upside down", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, from: "x" })).toBe(true);
    expect(isFiltered({ ...NO_FILTERS, dateTo: "2026-01-01" })).toBe(true);
    expect(invertedRange({ dateFrom: "2026-02-01", dateTo: "2026-01-01" })).toBe(true);
    expect(invertedRange({ dateFrom: "2026-01-01", dateTo: "2026-01-01" })).toBe(false);
    expect(invertedRange({ dateFrom: "", dateTo: "2026-01-01" })).toBe(false);
  });

  it("names the rows shown out of the total", () => {
    expect(pageRange(0, 50, 1234)).toEqual({ first: 1, last: 50, total: 1234 });
    expect(pageRange(1200, 34, 1234)).toEqual({ first: 1201, last: 1234, total: 1234 });
    expect(pageRange(0, 0, 0)).toEqual({ first: 0, last: 0, total: 0 });
  });
});

describe("archiveProtectionOf", () => {
  it("is application-only on a filesystem, the tenant's own or the installation default", () => {
    expect(archiveProtectionOf(list([target({ kind: "local" })]))).toBe("filesystem");
    expect(archiveProtectionOf(list([], "local"))).toBe("filesystem");
  });

  it("separates S3 with Object Lock, without it and not yet checked", () => {
    expect(
      archiveProtectionOf(
        list([target({ objectLock: { status: "enabled" } as StorageTargetDto["objectLock"] })]),
      ),
    ).toBe("s3_locked");
    expect(
      archiveProtectionOf(
        list([target({ objectLock: { status: "disabled" } as StorageTargetDto["objectLock"] })]),
      ),
    ).toBe("s3_unlocked");
    expect(archiveProtectionOf(list([target({ objectLock: null })]))).toBe("s3_unknown");
    // The installation default carries no detection of its own.
    expect(archiveProtectionOf(list([], "s3"))).toBe("s3_unknown");
  });

  it("goes by the primary, not a copy, and admits when nothing is known", () => {
    expect(
      archiveProtectionOf(
        list([
          target({ role: "copy", objectLock: { status: "enabled" } as never }),
          target({ id: "t2", kind: "local" }),
        ]),
      ),
    ).toBe("filesystem");
    expect(archiveProtectionOf(undefined)).toBe("unknown");
    expect(archiveProtectionOf(list([]))).toBe("unknown");
  });
});

describe("chainVerdictOf", () => {
  const passed: ChainVerification = {
    ok: true,
    checkedAt: "2026-10-07T10:00:00.000Z",
    checked: 3,
    brokenAt: null,
    anchors: { checked: 1, latestDate: "2026-10-06", unsealed: 0, failed: null },
    content: { requested: 0, checked: 0, notRecorded: 0, failures: [] },
  };

  it("names the first part that failed", () => {
    expect(chainVerdictOf(passed)).toBe("ok");
    expect(chainVerdictOf({ ...passed, checked: 0 })).toBe("empty");
    expect(
      chainVerdictOf({
        ...passed,
        anchors: { ...passed.anchors, failed: { date: "2026-10-06", count: 3, reason: "missing" } },
      }),
    ).toBe("anchor");
    expect(
      chainVerdictOf({
        ...passed,
        content: {
          requested: 3,
          checked: 3,
          notRecorded: 0,
          failures: [
            { itemId: "i", subject: null, receivedAt: passed.checkedAt, problem: "mismatch" },
          ],
        },
      }),
    ).toBe("content");
    expect(
      chainVerdictOf({
        ...passed,
        brokenAt: {
          index: 1,
          position: 2,
          itemId: "i",
          subject: "S",
          receivedAt: passed.checkedAt,
          expectedChainHash: "a",
          actualChainHash: "b",
        },
      }),
    ).toBe("broken");
  });
});
