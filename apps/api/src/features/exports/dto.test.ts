import type { Job, JobProgress, MailExport, ProtectedObject } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  type ExportRow,
  exportAvailability,
  fallbackContentType,
  hasEverySegment,
  reportFromJson,
  selectionCounts,
  toExportDto,
  toFormatDtos,
} from "./dto.js";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:00:00.000Z");
const COMPLETED = new Date(NOW.getTime() - 2 * HOUR);

function exportRow(overrides: Partial<MailExport> = {}): MailExport {
  return {
    id: "e1000000-0000-4000-8000-000000000001",
    tenantId: "70000000-0000-4000-8000-000000000001",
    jobId: "b0000000-0000-4000-8000-000000000001",
    origin: "snapshot",
    format: "eml_zip",
    snapshotId: "50000000-0000-4000-8000-000000000001",
    protectedObjectId: "a0000000-0000-4000-8000-000000000001",
    selection: { folderPaths: ["mail/Inbox"], paths: ["mail/Sent/1.eml"] },
    fileName: null,
    contentType: null,
    fileSize: null,
    segmentSize: null,
    sha256: null,
    report: null,
    expiresAt: null,
    purgedAt: null,
    actorUserId: "u1",
    impersonated: false,
    reason: null,
    createdAt: new Date("2026-09-30T09:00:00.000Z"),
    updatedAt: new Date("2026-09-30T09:00:00.000Z"),
    ...overrides,
  } as MailExport;
}

function jobRow(overrides: Partial<Job> = {}): Job {
  return {
    id: "b0000000-0000-4000-8000-000000000001",
    status: "queued",
    payload: null,
    errorMessage: null,
    completedAt: null,
    ...overrides,
  } as Job;
}

function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    export: exportRow(),
    job: jobRow(),
    progress: null,
    object: {
      id: "a0000000-0000-4000-8000-000000000001",
      kind: "mailbox",
      externalId: "anna@contoso.example",
      displayName: "Anna",
    } as ProtectedObject,
    ownerEmail: "anna@contoso.example",
    actorName: "Anna",
    actorEmail: "anna@contoso.example",
    ...overrides,
  };
}

describe("exportAvailability", () => {
  const base = { status: "completed" as const, completedAt: COMPLETED, purgedAt: null };

  it("is available until the worker's expiry", () => {
    const expiresAt = new Date(NOW.getTime() + HOUR);
    expect(exportAvailability({ ...base, expiresAt }, NOW, 24)).toEqual({
      available: true,
      expired: false,
      expiresAt,
    });
  });

  it("expires exactly at expires_at", () => {
    expect(exportAvailability({ ...base, expiresAt: NOW }, NOW, 24)).toMatchObject({
      available: false,
      expired: true,
    });
  });

  it("falls back to completion plus the configured lifetime when the worker set no expiry", () => {
    const result = exportAvailability({ ...base, expiresAt: null }, NOW, 24);
    expect(result.expiresAt?.toISOString()).toBe(
      new Date(COMPLETED.getTime() + 24 * HOUR).toISOString(),
    );
    expect(result.available).toBe(true);
    expect(exportAvailability({ ...base, expiresAt: null }, NOW, 1).available).toBe(false);
  });

  it("treats a purged file as expired whatever its date says", () => {
    const expiresAt = new Date(NOW.getTime() + HOUR);
    expect(exportAvailability({ ...base, expiresAt, purgedAt: NOW }, NOW, 24)).toMatchObject({
      available: false,
      expired: true,
    });
  });

  it("is never available or expired before the export completed", () => {
    for (const status of ["queued", "active", "failed", "cancelled", "unknown"] as const) {
      expect(
        exportAvailability({ ...base, status, expiresAt: null, purgedAt: null }, NOW, 24),
      ).toMatchObject({ available: false, expired: false });
    }
  });
});

describe("selectionCounts", () => {
  it("counts snapshot paths, item ids and folders, and reports a full selection as unknown", () => {
    expect(
      selectionCounts("snapshot", {
        folderPaths: ["mail/Inbox", "mail/Sent"],
        paths: ["mail/Drafts/1.eml"],
        objectIds: ["msg-1", "msg-2"],
      }),
    ).toEqual({ items: 3, folders: 2 });
    expect(selectionCounts("snapshot", { all: true })).toEqual({ items: null, folders: null });
    expect(selectionCounts("snapshot", null)).toEqual({ items: null, folders: null });
  });

  it("counts archive item ids and uses the matches stored for a filter", () => {
    expect(selectionCounts("archive", { itemIds: ["a", "b", "c"] })).toEqual({
      items: 3,
      folders: null,
    });
    expect(selectionCounts("archive", { filter: { q: "x" }, matched: 42 })).toEqual({
      items: 42,
      folders: null,
    });
    expect(selectionCounts("archive", { filter: {} })).toEqual({ items: null, folders: null });
    expect(selectionCounts("archive", { filter: {}, matched: 100000, capped: true })).toEqual({
      items: 100000,
      folders: null,
      capped: true,
    });
  });
});

describe("reportFromJson", () => {
  it("reads the worker's report and drops malformed parts", () => {
    expect(
      reportFromJson({
        messages: 12,
        folders: 3,
        bytes: 2048,
        failed: 1,
        skipped: { calendar: 2, contacts: 1 },
        items: [{ ref: "mail/a.eml", reason: "data missing" }, { ref: 1 }, "junk", {}],
      }),
    ).toEqual({
      messages: 12,
      folders: 3,
      bytes: 2048,
      failed: 1,
      skipped: { calendar: 2, contacts: 1, other: 0 },
      items: [{ ref: "mail/a.eml", reason: "data missing" }],
    });
  });

  it("is null without a report and zero-filled for an empty one", () => {
    expect(reportFromJson(null)).toBeNull();
    expect(reportFromJson([])).toBeNull();
    expect(reportFromJson({})).toEqual({
      messages: 0,
      folders: 0,
      bytes: 0,
      failed: 0,
      skipped: { calendar: 0, contacts: 0, other: 0 },
      items: [],
    });
  });
});

describe("toExportDto", () => {
  it("maps a queued export without a file", () => {
    const dto = toExportDto(row(), NOW, 24);
    expect(dto).toMatchObject({
      origin: "snapshot",
      format: "eml_zip",
      status: "queued",
      selection: { items: 1, folders: 1 },
      fileName: null,
      fileSize: null,
      sha256: null,
      completedAt: null,
      expiresAt: null,
      available: false,
      progress: null,
      phase: null,
      impersonated: false,
      object: { kind: "mailbox", externalId: "anna@contoso.example", displayName: "Anna" },
      actor: { userId: "u1", name: "Anna", email: "anna@contoso.example" },
    });
  });

  it("maps a completed export with its file, expiry and availability", () => {
    const expiresAt = new Date(NOW.getTime() + 22 * HOUR);
    const dto = toExportDto(
      row({
        export: exportRow({
          fileName: "Anna.zip",
          fileSize: 1234,
          sha256: "ab".repeat(32),
          expiresAt,
        }),
        job: jobRow({ status: "completed", completedAt: COMPLETED }),
      }),
      NOW,
      24,
    );
    expect(dto).toMatchObject({
      status: "completed",
      fileName: "Anna.zip",
      fileSize: 1234,
      sha256: "ab".repeat(32),
      completedAt: COMPLETED.toISOString(),
      expiresAt: expiresAt.toISOString(),
      available: true,
    });
  });

  it("shows progress and the phase only while the export runs", () => {
    const progress = { total: 10, done: 4, failed: 1, bytes: 99, etaSeconds: 30 } as JobProgress;
    const running = toExportDto(
      row({
        job: jobRow({ status: "active", payload: { runtime: { phase: "writing" } } }),
        progress,
      }),
      NOW,
      24,
    );
    expect(running.phase).toBe("writing");
    expect(running.progress).toEqual({ total: 10, done: 4, failed: 1, bytes: 99, etaSeconds: 30 });

    const cancelled = toExportDto(
      row({
        job: jobRow({ status: "cancelled", payload: { runtime: { phase: "writing" } } }),
        progress,
      }),
      NOW,
      24,
    );
    expect(cancelled.phase).toBeNull();
  });

  it("reports an unknown status and no object for a row whose neighbours are gone", () => {
    const dto = toExportDto(
      row({
        export: exportRow({ origin: "archive", selection: { itemIds: ["a"] } }),
        job: null,
        object: null,
        actorName: null,
        actorEmail: null,
      }),
      NOW,
      24,
    );
    expect(dto).toMatchObject({
      status: "unknown",
      object: null,
      selection: { items: 1, folders: null },
      actor: { name: null, email: null },
    });
  });
});

describe("formats and content types", () => {
  it("lists formats without empty optional keys", () => {
    expect(
      toFormatDtos([
        { id: "eml_zip", available: true },
        { id: "pst", available: false, planned: true, reason: "planned for a later release" },
      ]),
    ).toEqual([
      { id: "eml_zip", available: true },
      { id: "pst", available: false, planned: true, reason: "planned for a later release" },
    ]);
  });

  it("falls back to a content type per format", () => {
    expect(fallbackContentType("eml_zip")).toBe("application/zip");
    expect(fallbackContentType("msg_zip")).toBe("application/zip");
    expect(fallbackContentType("mbox")).toBe("application/mbox");
  });
});

describe("hasEverySegment", () => {
  it("needs every index from zero to the expected count", () => {
    expect(hasEverySegment([0, 1, 2], 3)).toBe(true);
    expect(hasEverySegment([2, 0, 1, 3], 3)).toBe(true);
    expect(hasEverySegment([0, 2], 3)).toBe(false);
    expect(hasEverySegment([], 1)).toBe(false);
    expect(hasEverySegment([], 0)).toBe(true);
  });
});
