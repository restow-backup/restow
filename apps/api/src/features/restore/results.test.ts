import { describe, expect, it } from "vitest";
import {
  DOWNLOAD_TTL_MS,
  downloadAvailability,
  downloadPrefix,
  itemsFromPayload,
  resultFromPayload,
} from "./results.js";

describe("downloadAvailability", () => {
  const completed = new Date("2026-03-01T10:00:00Z");

  it("is available for 24 hours after a completed download restore", () => {
    const soon = new Date(completed.getTime() + 60_000);
    expect(downloadAvailability("download", "completed", completed, soon)).toEqual({
      available: true,
      expiresAt: new Date(completed.getTime() + DOWNLOAD_TTL_MS).toISOString(),
    });
    const late = new Date(completed.getTime() + DOWNLOAD_TTL_MS + 1);
    expect(downloadAvailability("download", "completed", completed, late).available).toBe(false);
  });

  it("is never available for other targets or unfinished jobs", () => {
    expect(downloadAvailability("original", "completed", completed, completed)).toEqual({
      available: false,
      expiresAt: null,
    });
    expect(downloadAvailability("download", "active", null, completed).available).toBe(false);
    expect(downloadAvailability("download", "failed", completed, completed).available).toBe(false);
  });
});

describe("resultFromPayload", () => {
  it("reads the worker's counts and tolerates missing or broken fields", () => {
    expect(resultFromPayload(null)).toBeNull();
    expect(resultFromPayload({ jobId: "x" })).toBeNull();
    expect(resultFromPayload({ result: [1, 2] })).toBeNull();
    expect(
      resultFromPayload({
        result: {
          restored: 3,
          skipped: 1,
          bytes: 42,
          unverified: -2,
          folders: 2,
          downloadKey: "tenants/t/downloads/r/a.zip",
          throttleWaits: 2,
          throttleWaitMs: "35000",
        },
      }),
    ).toEqual({
      restored: 3,
      skipped: 1,
      failures: 0,
      unverified: 0,
      folders: 2,
      bytes: 42,
      downloadKey: "tenants/t/downloads/r/a.zip",
      throttleWaits: 2,
      throttleWaitMs: 0,
    });
  });
});

describe("itemsFromPayload", () => {
  it("is null until the worker stored per-item outcomes", () => {
    expect(itemsFromPayload(null)).toBeNull();
    expect(itemsFromPayload({ result: { restored: 1 } })).toBeNull();
  });

  it("explains a failed item with its stored cause, dated at the restore", () => {
    const items = itemsFromPayload({
      result: {
        completedAt: "2026-09-29T10:00:00.000Z",
        itemCount: 1,
        items: [
          {
            path: "mail/Inbox/a.eml",
            status: "failed",
            code: "target_rejected",
            reason: "Graph 403 ErrorAccessDenied: Access is denied.",
            cause: {
              code: "graph.access_denied",
              transient: false,
              params: { permission: "Mail.ReadWrite" },
              technical: { httpStatus: 403 },
            },
          },
        ],
      },
    });
    expect(items?.items[0]?.failure).toMatchObject({
      code: "graph.access_denied",
      params: { permission: "Mail.ReadWrite" },
      occurredAt: "2026-09-29T10:00:00.000Z",
    });
  });

  it("keeps valid items, drops malformed ones and reports truncation", () => {
    const items = itemsFromPayload({
      result: {
        itemCount: 5,
        items: [
          {
            path: "mail/Inbox/a.eml",
            itemId: "AAMk",
            type: "mail",
            status: "failed",
            code: "target_rejected",
            reason: "mailbox not found",
            bytes: 0,
            verified: false,
            subject: "Invoice 4711",
            from: "Anna Muster <anna@example.com>",
          },
          {
            path: "Documents/a.docx",
            status: "restored",
            code: "from-the-future",
            verified: true,
            bytes: 10,
          },
          { path: "Documents/b.docx", status: "exploded" },
          { status: "skipped" },
          "nonsense",
        ],
      },
    });
    expect(items).toEqual({
      items: [
        {
          path: "mail/Inbox/a.eml",
          itemId: "AAMk",
          type: "mail",
          status: "failed",
          code: "target_rejected",
          targetRef: null,
          bytes: 0,
          verified: false,
          reason: "mailbox not found",
          subject: "Invoice 4711",
          from: "Anna Muster <anna@example.com>",
          failure: null,
        },
        {
          path: "Documents/a.docx",
          itemId: null,
          type: "file",
          status: "restored",
          code: null,
          targetRef: null,
          bytes: 10,
          verified: true,
          reason: null,
          subject: null,
          from: null,
          failure: null,
        },
      ],
      total: 5,
      truncated: true,
    });
  });

  it("never reports fewer items in total than it returns", () => {
    const items = itemsFromPayload({
      result: { items: [{ path: "a", status: "skipped", reason: "exists" }] },
    });
    expect(items?.total).toBe(1);
    expect(items?.truncated).toBe(false);
  });
});

describe("downloadPrefix", () => {
  it("matches the storage layout of download restores", () => {
    expect(downloadPrefix("tid", "rid")).toBe("tenants/tid/downloads/rid/");
  });
});
