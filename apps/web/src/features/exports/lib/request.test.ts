import { describe, expect, it } from "vitest";

import { formatChoices } from "@/features/exports/lib/formats";
import {
  type ExportFormContext,
  type ExportFormState,
  type ExportSource,
  archiveScopeSize,
  buildExportRequest,
  cleanFilter,
  exportErrorOf,
  fileNameProblem,
  hasErrors,
  initialFormState,
  normalizeFileName,
  suggestedFileName,
  validateExportForm,
} from "@/features/exports/lib/request";
import { EMPTY_SELECTION, selectionOf } from "@/features/restore/lib/selection";
import { ApiError } from "@/lib/api";

const choices = formatChoices([
  { id: "eml_zip", available: true },
  { id: "mbox", available: true },
  { id: "msg_zip", available: false },
  { id: "pst", available: false, planned: true },
]);

const context: ExportFormContext = { reasonRequired: false, choices };
const state: ExportFormState = { format: "eml_zip", fileName: "", reason: "" };

const folder = { path: "Inbox", kind: "folder" as const, itemId: null, subject: null, size: 0 };
const mail = { path: "Inbox/a", kind: "mail" as const, itemId: "it-1", subject: "Hi", size: 10 };

const snapshotSource: ExportSource = {
  origin: "snapshot",
  snapshotId: "snap-1",
  scope: { kind: "selection", selection: selectionOf(folder, mail) },
};

describe("file names", () => {
  it("drops a typed extension the server adds itself", () => {
    expect(normalizeFileName("  Anna Berger.zip ")).toBe("Anna Berger");
    expect(normalizeFileName("archive.MBOX")).toBe("archive");
    expect(normalizeFileName("report.v2")).toBe("report.v2");
    expect(normalizeFileName("   ")).toBe("");
  });

  it("accepts empty and ordinary names and refuses paths and special characters", () => {
    expect(fileNameProblem("")).toBeNull();
    expect(fileNameProblem("Mails 2026-09")).toBeNull();
    expect(fileNameProblem("../etc/passwd")).toBe("forbidden");
    expect(fileNameProblem("a\\b")).toBe("forbidden");
    expect(fileNameProblem('what?"')).toBe("forbidden");
    expect(fileNameProblem(".hidden")).toBe("forbidden");
    expect(fileNameProblem("bad\u0007name")).toBe("forbidden");
    expect(fileNameProblem("x".repeat(121))).toBe("tooLong");
    expect(fileNameProblem("x".repeat(120))).toBeNull();
  });

  it("suggests a portable name from the mailbox and the time", () => {
    const now = new Date(2026, 8, 23, 14, 30);
    expect(suggestedFileName("Anna Müller", "Mail export", now)).toBe(
      "anna-muller-2026-09-23-1430",
    );
    expect(suggestedFileName("", "Archive export", now)).toBe("archive-export-2026-09-23-1430");
    expect(suggestedFileName("日本語", "", now)).toBe("export-2026-09-23-1430");
  });
});

describe("initialFormState", () => {
  it("starts on the first format that can be chosen", () => {
    expect(initialFormState(choices)).toEqual({ format: "eml_zip", fileName: "", reason: "" });
    expect(initialFormState([]).format).toBeNull();
  });
});

describe("validateExportForm", () => {
  it("accepts a plain export of one's own data", () => {
    expect(validateExportForm(state, context, snapshotSource)).toEqual({});
  });

  it("refuses PST, formats that are not offered, and no format at all", () => {
    for (const format of ["pst", "msg_zip", null] as const) {
      const errors = validateExportForm({ ...state, format }, context, snapshotSource);
      expect(errors.format).toBe("exports:dialog.errors.formatUnavailable");
    }
  });

  it("requires a reason of at least three characters for somebody else's data", () => {
    const elsewhere = { ...context, reasonRequired: true };
    expect(validateExportForm(state, elsewhere, snapshotSource).reason).toBe(
      "exports:dialog.errors.reasonRequired",
    );
    expect(
      validateExportForm({ ...state, reason: "  ab " }, elsewhere, snapshotSource).reason,
    ).toBeDefined();
    expect(validateExportForm({ ...state, reason: "INC-1" }, elsewhere, snapshotSource)).toEqual(
      {},
    );
  });

  it("does not ask for a reason on archive exports", () => {
    const source: ExportSource = { origin: "archive", scope: { kind: "items", itemIds: ["a"] } };
    expect(validateExportForm(state, { ...context, reasonRequired: true }, source)).toEqual({});
  });

  it("reports an invalid file name and an empty archive scope", () => {
    const errors = validateExportForm({ ...state, fileName: "a/b" }, context, {
      origin: "archive",
      scope: { kind: "items", itemIds: [] },
    });
    expect(errors.fileName).toBe("exports:dialog.errors.fileName.forbidden");
    expect(errors.scope).toBe("exports:dialog.errors.emptyScope");
    expect(hasErrors(errors)).toBe(true);
    expect(hasErrors({})).toBe(false);
  });

  it("treats a search with zero results as nothing to export, an unknown count as fine", () => {
    expect(archiveScopeSize({ kind: "filter", filter: {}, total: 0 })).toBe(0);
    expect(archiveScopeSize({ kind: "filter", filter: {}, total: null })).toBeNull();
    expect(
      validateExportForm(state, context, {
        origin: "archive",
        scope: { kind: "filter", filter: {}, total: null },
      }),
    ).toEqual({});
  });
});

describe("buildExportRequest for a snapshot", () => {
  it("sends the selected folders and items by path", () => {
    expect(
      buildExportRequest({ source: snapshotSource, state, context: { reasonRequired: false } }),
    ).toEqual({
      origin: "snapshot",
      snapshotId: "snap-1",
      selection: [
        { path: "Inbox", kind: "folder" },
        { path: "Inbox/a", kind: "item" },
      ],
      format: "eml_zip",
    });
  });

  it("exports the whole restore point as the root folder", () => {
    const request = buildExportRequest({
      source: { origin: "snapshot", snapshotId: "snap-1", scope: { kind: "everything" } },
      state: { ...state, format: "mbox" },
      context: { reasonRequired: false },
    });
    expect(request).toMatchObject({
      origin: "snapshot",
      format: "mbox",
      selection: [{ path: "", kind: "folder" }],
    });
  });

  it("includes the trimmed reason only when one is required, and the file name without extension", () => {
    const filled = { ...state, reason: "  INC-42 restore for legal  ", fileName: "legal.zip" };
    expect(
      buildExportRequest({
        source: snapshotSource,
        state: filled,
        context: { reasonRequired: true },
      }),
    ).toMatchObject({ reason: "INC-42 restore for legal", fileName: "legal" });
    const own = buildExportRequest({
      source: snapshotSource,
      state: filled,
      context: { reasonRequired: false },
    });
    expect(own).not.toHaveProperty("reason");
  });

  it("omits the file name when none was typed", () => {
    expect(
      buildExportRequest({ source: snapshotSource, state, context: { reasonRequired: false } }),
    ).not.toHaveProperty("fileName");
    expect(
      buildExportRequest({
        source: {
          origin: "snapshot",
          snapshotId: "s",
          scope: { kind: "selection", selection: EMPTY_SELECTION },
        },
        state,
        context: { reasonRequired: false },
      }),
    ).toMatchObject({ selection: [] });
  });
});

describe("buildExportRequest for the archive", () => {
  it("sends ticked items by id", () => {
    expect(
      buildExportRequest({
        source: { origin: "archive", scope: { kind: "items", itemIds: ["a1", "a2"] } },
        state: { ...state, format: "mbox", fileName: "Q3" },
        context: { reasonRequired: false },
      }),
    ).toEqual({
      origin: "archive",
      selection: { itemIds: ["a1", "a2"] },
      format: "mbox",
      fileName: "Q3",
    });
  });

  it("sends the current search as a filter without empty values", () => {
    expect(
      buildExportRequest({
        source: {
          origin: "archive",
          scope: {
            kind: "filter",
            filter: { q: " invoice ", hasAttachment: true, mailbox: "", from: undefined },
            total: 120,
          },
        },
        state,
        context: { reasonRequired: true },
      }),
    ).toEqual({
      origin: "archive",
      selection: { filter: { q: "invoice", hasAttachment: true } },
      format: "eml_zip",
    });
  });

  it("keeps only what narrows the search", () => {
    expect(cleanFilter({ q: "", hasAttachment: false, dateFrom: "2026-01-01" })).toEqual({
      dateFrom: "2026-01-01",
    });
    expect(cleanFilter({})).toEqual({});
  });
});

describe("exportErrorOf", () => {
  const problem = (type: string, status = 422) =>
    new ApiError(status, { type, title: "x", status }, "failed");

  it("explains the documented problems in the user's language", () => {
    expect(exportErrorOf(problem("urn:restow:problem:export-not-mail"), "snapshot")).toEqual({
      field: null,
      key: "exports:dialog.errors.notMail",
    });
    expect(
      exportErrorOf(problem("urn:restow:problem:export-format-unavailable"), "archive"),
    ).toEqual({ field: "format", key: "exports:dialog.errors.formatUnavailable" });
    expect(
      exportErrorOf(problem("urn:restow:problem:export-reason-required"), "snapshot").field,
    ).toBe("reason");
    expect(
      exportErrorOf(problem("urn:restow:problem:queue-unavailable", 503), "snapshot").key,
    ).toBe("exports:dialog.errors.queueUnavailable");
    expect(
      exportErrorOf(problem("urn:restow:problem:export-quota-exceeded", 422), "snapshot"),
    ).toEqual({ field: null, key: "exports:dialog.errors.quotaExceeded" });
  });

  it("says what is gone for a 404, depending on where the export came from", () => {
    expect(exportErrorOf(new ApiError(404, null, "gone"), "snapshot").key).toBe(
      "exports:dialog.errors.snapshotGone",
    );
    expect(exportErrorOf(new ApiError(404, null, "gone"), "archive").key).toBe(
      "exports:dialog.errors.archiveGone",
    );
  });

  it("falls back to the common error text", () => {
    expect(exportErrorOf(new ApiError(500, null, "boom"), "snapshot").key).toBe(
      "common:errors.server",
    );
    expect(exportErrorOf(new Error("?"), "snapshot").key).toBe("common:errors.generic");
  });
});
