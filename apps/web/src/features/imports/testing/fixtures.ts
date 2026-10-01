import type {
  ImportConfig,
  ImportDetail,
  ImportReport,
  ImportReportItem,
  ImportSummary,
} from "../types";

export const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
export const OBJECT_ID = "33333333-3333-4333-8333-333333333333";
export const SNAPSHOT_ID = "44444444-4444-4444-8444-444444444444";

export const config: ImportConfig = {
  uploadEnabled: true,
  maxFileBytes: 10 * 1024 * 1024 * 1024,
  segmentSize: 8 * 1024 * 1024,
  uploadExpiresHours: 48,
  folder: { enabled: true, path: "/var/lib/restow/import" },
  supportedFormats: ["eml", "msg", "mbox", "zip"],
  refusedFormats: ["pst"],
};

export const failedItem: ImportReportItem = {
  ref: "Inbox.mbox#17",
  file: "mail/Inbox.mbox",
  outcome: "failed",
  code: "unreadable",
  reason: "Could not parse the message: header block is truncated",
};

export const notMailItem: ImportReportItem = {
  ref: "export.zip!Contacts/anna.msg",
  file: "export.zip",
  outcome: "skipped",
  code: "not_mail",
  reason: "Outlook item class IPM.Contact is not a mail message",
};

export const duplicateItem: ImportReportItem = {
  ref: "Inbox.mbox#3",
  file: "mail/Inbox.mbox",
  outcome: "skipped",
  code: "duplicate",
  reason: "Already in the mailbox (Message-ID <a@example.test>)",
};

export function report(overrides: Partial<ImportReport> = {}): ImportReport {
  return {
    version: 1,
    startedAt: "2026-09-30T10:00:00.000Z",
    completedAt: "2026-09-30T10:12:00.000Z",
    snapshotId: SNAPSHOT_ID,
    totals: {
      files: 2,
      messages: 1204,
      folders: 9,
      attachments: 311,
      duplicates: 12,
      skipped: 1,
      failed: 1,
      messageBytes: 812_345_678,
      sourceBytes: 1_234_567_890,
      synthesizedMessages: 40,
    },
    files: [
      {
        path: "mail/Inbox.mbox",
        size: 900_000_000,
        format: "mbox",
        sha256: "a".repeat(64),
        status: "partial",
        messages: 1100,
        folders: 1,
        attachments: 300,
        duplicates: 12,
        skipped: 0,
        failed: 1,
      },
      {
        path: "export.zip",
        size: 334_567_890,
        format: "zip",
        sha256: "b".repeat(64),
        status: "imported",
        messages: 104,
        folders: 8,
        attachments: 11,
        duplicates: 0,
        skipped: 1,
        failed: 0,
      },
    ],
    items: [notMailItem, duplicateItem, failedItem],
    itemsOmitted: 0,
    archive: null,
    notes: ["calendar_contacts_not_imported", "msg_reconstructed"],
    ...overrides,
  };
}

export function summary(overrides: Partial<ImportSummary> = {}): ImportSummary {
  return {
    id: IMPORT_ID,
    name: "Mail archive 2019",
    objectId: OBJECT_ID,
    sourceId: "55555555-5555-4555-8555-555555555555",
    jobId: "66666666-6666-4666-8666-666666666666",
    status: "completed",
    fileCount: 2,
    archive: false,
    createdAt: "2026-09-30T09:59:00.000Z",
    completedAt: "2026-09-30T10:12:00.000Z",
    messages: 1204,
    failed: 1,
    ...overrides,
  };
}

export function detail(overrides: Partial<ImportDetail> = {}): ImportDetail {
  return {
    ...summary(),
    files: [
      {
        origin: "upload",
        kind: "file",
        path: "mail/Inbox.mbox",
        size: 900_000_000,
        format: "mbox",
      },
      { origin: "folder", kind: "file", path: "export.zip", size: 334_567_890, format: "zip" },
    ],
    startedAt: "2026-09-30T10:00:00.000Z",
    errorMessage: null,
    actor: { userId: "u1", name: "Lena Schneider", email: "lena@acme.example" },
    progress: null,
    phase: null,
    report: report(),
    failures: [],
    live: null,
    ...overrides,
  };
}
