import { describe, expect, it } from "vitest";
import {
  MAX_ARCHIVE_EXPORT_ITEM_IDS,
  archiveExportFilterSchema,
  createExportSchema,
  exportIdParamSchema,
  listExportsQuerySchema,
  toStoredArchiveFilter,
} from "./schemas.js";

const SNAPSHOT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const ITEM = "9f4c9001-6772-43c6-8670-233e0d7c536d";

describe("createExportSchema", () => {
  it("parses a snapshot export with the restore selection entries", () => {
    const parsed = createExportSchema.parse({
      origin: "snapshot",
      snapshotId: SNAPSHOT,
      selection: [{ path: "mail/Inbox", kind: "folder" }, { itemId: "msg-1" }],
      format: "eml_zip",
      reason: "  Ticket 4711  ",
      fileName: "Inbox 2019",
    });
    expect(parsed).toMatchObject({
      origin: "snapshot",
      reason: "Ticket 4711",
      fileName: "Inbox 2019",
    });
  });

  it("parses an archive export by item ids or by filter, never both", () => {
    expect(
      createExportSchema.parse({
        origin: "archive",
        selection: { itemIds: [ITEM] },
        format: "mbox",
      }).origin,
    ).toBe("archive");
    expect(
      createExportSchema.parse({
        origin: "archive",
        selection: { filter: { q: "invoice", hasAttachment: true } },
        format: "eml_zip",
      }).origin,
    ).toBe("archive");
    expect(
      createExportSchema.safeParse({
        origin: "archive",
        selection: { itemIds: [ITEM], filter: { q: "x" } },
        format: "eml_zip",
      }).success,
    ).toBe(false);
  });

  it("caps the item ids of an archive export and rejects empty and malformed ones", () => {
    const ids = (count: number) =>
      Array.from(
        { length: count },
        (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
    const request = (itemIds: string[]) => ({
      origin: "archive",
      selection: { itemIds },
      format: "eml_zip",
    });
    expect(createExportSchema.safeParse(request(ids(MAX_ARCHIVE_EXPORT_ITEM_IDS))).success).toBe(
      true,
    );
    expect(
      createExportSchema.safeParse(request(ids(MAX_ARCHIVE_EXPORT_ITEM_IDS + 1))).success,
    ).toBe(false);
    expect(createExportSchema.safeParse(request([])).success).toBe(false);
    expect(createExportSchema.safeParse(request(["not-a-uuid"])).success).toBe(false);
  });

  it("knows pst as a format so the service can refuse it precisely, but no other id", () => {
    const base = { origin: "archive", selection: { itemIds: [ITEM] } };
    expect(createExportSchema.safeParse({ ...base, format: "pst" }).success).toBe(true);
    expect(createExportSchema.safeParse({ ...base, format: "docx" }).success).toBe(false);
  });

  it("rejects a snapshot export without a selection and unknown origins", () => {
    expect(
      createExportSchema.safeParse({
        origin: "snapshot",
        snapshotId: SNAPSHOT,
        selection: [],
        format: "eml_zip",
      }).success,
    ).toBe(false);
    expect(createExportSchema.safeParse({ origin: "elsewhere", format: "eml_zip" }).success).toBe(
      false,
    );
  });

  it("keeps the file name harmless and the reason meaningful", () => {
    const base = {
      origin: "snapshot",
      snapshotId: SNAPSHOT,
      selection: [{ path: "" }],
      format: "mbox",
    };
    expect(createExportSchema.safeParse({ ...base, fileName: "../etc/passwd" }).success).toBe(
      false,
    );
    expect(createExportSchema.safeParse({ ...base, fileName: "a\u0000b" }).success).toBe(false);
    expect(createExportSchema.safeParse({ ...base, fileName: "x".repeat(121) }).success).toBe(
      false,
    );
    expect(createExportSchema.safeParse({ ...base, reason: "no" }).success).toBe(false);
  });
});

describe("archiveExportFilterSchema", () => {
  it("reads dates from ISO strings and treats null and empty as not given", () => {
    const filter = archiveExportFilterSchema.parse({
      dateFrom: "2019-01-01T00:00:00.000Z",
      dateTo: null,
      q: "",
    });
    expect(filter.dateFrom?.toISOString()).toBe("2019-01-01T00:00:00.000Z");
    expect(filter.dateTo).toBeUndefined();
    expect(archiveExportFilterSchema.parse({ dateFrom: "" }).dateFrom).toBeUndefined();
  });

  it("refuses an inverted date range, unknown keys and bad mailbox ids", () => {
    expect(
      archiveExportFilterSchema.safeParse({
        dateFrom: "2020-01-01T00:00:00Z",
        dateTo: "2019-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(archiveExportFilterSchema.safeParse({ subject: "x" }).success).toBe(false);
    expect(archiveExportFilterSchema.safeParse({ mailbox: "abc" }).success).toBe(false);
  });
});

describe("toStoredArchiveFilter", () => {
  it("keeps only what was given and stores dates as ISO strings", () => {
    const filter = archiveExportFilterSchema.parse({
      q: "invoice",
      from: "",
      mailbox: ITEM,
      dateFrom: "2019-05-01T10:00:00+02:00",
      hasAttachment: false,
    });
    expect(toStoredArchiveFilter(filter)).toEqual({
      q: "invoice",
      mailbox: ITEM,
      dateFrom: "2019-05-01T08:00:00.000Z",
      hasAttachment: false,
    });
    expect(toStoredArchiveFilter({})).toEqual({});
  });
});

describe("path and query schemas", () => {
  it("requires a UUID id and bounds the list limit", () => {
    expect(exportIdParamSchema.safeParse({ id: "nope" }).success).toBe(false);
    expect(exportIdParamSchema.parse({ id: SNAPSHOT }).id).toBe(SNAPSHOT);
    expect(listExportsQuerySchema.parse({}).limit).toBe(50);
    expect(listExportsQuerySchema.parse({ limit: "10" }).limit).toBe(10);
    expect(listExportsQuerySchema.safeParse({ limit: "51" }).success).toBe(false);
    expect(listExportsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("pages with an offset that starts at the newest export", () => {
    expect(listExportsQuerySchema.parse({}).offset).toBe(0);
    expect(listExportsQuerySchema.parse({ offset: "50" }).offset).toBe(50);
    expect(listExportsQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});
