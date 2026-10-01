import type { ImportUpload, Job, JobProgress, MailImport } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  type ImportRow,
  PST_REFUSAL_MESSAGE,
  UNRECOGNISED_REFUSAL_MESSAGE,
  expectedSegmentSize,
  importLiveOf,
  isSupportedFormat,
  isUploadExpired,
  missingSegments,
  outcomeCounts,
  refusalFor,
  reportOf,
  toDetailDto,
  toSummaryDto,
  toUploadDto,
} from "./dto.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const later = new Date("2026-10-02T12:00:00.000Z");
const earlier = new Date("2026-09-29T12:00:00.000Z");

function upload(overrides: Partial<ImportUpload> = {}): ImportUpload {
  return {
    id: "u1",
    tenantId: "t1",
    createdBy: "user-1",
    fileName: "mail.mbox",
    size: 250,
    segmentSize: 100,
    segmentCount: 3,
    status: "uploading",
    detectedFormat: null,
    importId: null,
    expiresAt: later,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("refusalFor", () => {
  it("names PST and unrecognised files, and nothing else", () => {
    expect(refusalFor("pst")).toEqual({ code: "pst_not_supported", message: PST_REFUSAL_MESSAGE });
    expect(refusalFor("unknown")).toEqual({
      code: "unrecognised",
      message: UNRECOGNISED_REFUSAL_MESSAGE,
    });
    for (const format of ["eml", "msg", "mbox", "zip", null, undefined]) {
      expect(refusalFor(format)).toBeNull();
    }
  });

  it("uses the documented wording without dashes", () => {
    expect(PST_REFUSAL_MESSAGE).toBe(
      "PST and OST import is planned for a later release. Export the mailbox from Outlook as .msg or .eml files (or convert it to MBOX) and import those.",
    );
    expect(UNRECOGNISED_REFUSAL_MESSAGE).toBe(
      "The file is not a recognised mail file (EML, MSG, MBOX or ZIP).",
    );
    expect(PST_REFUSAL_MESSAGE + UNRECOGNISED_REFUSAL_MESSAGE).not.toMatch(/[–—]/);
  });
});

describe("isSupportedFormat", () => {
  it("accepts the four readable formats", () => {
    for (const format of ["eml", "msg", "mbox", "zip"]) {
      expect(isSupportedFormat(format)).toBe(true);
    }
    for (const format of ["pst", "unknown", "", null, undefined]) {
      expect(isSupportedFormat(format)).toBe(false);
    }
  });
});

describe("upload layout", () => {
  it("expects full segments and a remainder for the last one", () => {
    const layout = { size: 250, segmentSize: 100, segmentCount: 3 };
    expect([0, 1, 2].map((index) => expectedSegmentSize(layout, index))).toEqual([100, 100, 50]);
    expect(expectedSegmentSize({ size: 200, segmentSize: 100, segmentCount: 2 }, 1)).toBe(100);
    expect(expectedSegmentSize({ size: 5, segmentSize: 100, segmentCount: 1 }, 0)).toBe(5);
  });

  it("lists the missing indexes", () => {
    expect(missingSegments(5, [0, 2, 4])).toEqual([1, 3]);
    expect(missingSegments(3, [0, 1, 2, 2])).toEqual([]);
    expect(missingSegments(2, [])).toEqual([0, 1]);
  });
});

describe("toUploadDto", () => {
  it("shows which segments arrived, sorted, and no refusal while it uploads", () => {
    const dto = toUploadDto(upload(), [2, 0], NOW);
    expect(dto).toEqual({
      id: "u1",
      fileName: "mail.mbox",
      size: 250,
      segmentSize: 100,
      segmentCount: 3,
      status: "uploading",
      receivedSegments: [0, 2],
      detectedFormat: null,
      refusal: null,
      expiresAt: later.toISOString(),
    });
  });

  it("carries the refusal of a PST or an unrecognised file", () => {
    const pst = toUploadDto(upload({ status: "ready", detectedFormat: "pst" }), [0, 1, 2], NOW);
    expect(pst.detectedFormat).toBe("pst");
    expect(pst.refusal?.code).toBe("pst_not_supported");
    const unknown = toUploadDto(upload({ status: "ready", detectedFormat: "unknown" }), [], NOW);
    expect(unknown.refusal?.code).toBe("unrecognised");
    const fine = toUploadDto(upload({ status: "ready", detectedFormat: "eml" }), [], NOW);
    expect(fine.refusal).toBeNull();
  });

  it("reports an unused upload as expired once its time is up", () => {
    expect(isUploadExpired(upload({ expiresAt: earlier }), NOW)).toBe(true);
    expect(toUploadDto(upload({ expiresAt: earlier }), [], NOW).status).toBe("expired");
    expect(toUploadDto(upload({ status: "ready", expiresAt: earlier }), [], NOW).status).toBe(
      "expired",
    );
    // A consumed or cancelled upload keeps its state; the time no longer matters.
    expect(toUploadDto(upload({ status: "consumed", expiresAt: earlier }), [], NOW).status).toBe(
      "consumed",
    );
    expect(toUploadDto(upload({ status: "cancelled", expiresAt: earlier }), [], NOW).status).toBe(
      "cancelled",
    );
  });

  it("ignores a format value it does not know", () => {
    expect(toUploadDto(upload({ detectedFormat: "docx" }), [], NOW).detectedFormat).toBeNull();
  });
});

const report = {
  version: 1,
  startedAt: NOW.toISOString(),
  completedAt: NOW.toISOString(),
  snapshotId: "snap-1",
  totals: { files: 1, messages: 40, failed: 2, duplicates: 1, skipped: 0 },
  files: [],
  items: [],
  itemsOmitted: 0,
  archive: null,
  notes: [],
};

describe("reportOf", () => {
  it("returns the stored report of the understood version and nothing else", () => {
    expect(reportOf(report)?.totals.messages).toBe(40);
    expect(reportOf(null)).toBeNull();
    expect(reportOf({ version: 2, totals: {} })).toBeNull();
    expect(reportOf({ version: 1 })).toBeNull();
  });
});

describe("importLiveOf", () => {
  const live = { messages: 5, duplicates: 1, skipped: 2, failed: 3, unitsDone: 4, unitsTotal: 9 };

  it("maps the worker's counters, units become files", () => {
    expect(importLiveOf({ importLive: live })).toEqual({
      messages: 5,
      duplicates: 1,
      skipped: 2,
      failed: 3,
      filesDone: 4,
      filesTotal: 9,
    });
  });

  it("is null before the first write and for damaged documents", () => {
    expect(importLiveOf(null)).toBeNull();
    expect(importLiveOf({})).toBeNull();
    expect(importLiveOf({ importLive: { ...live, messages: "5" } })).toBeNull();
    expect(importLiveOf({ importLive: { ...live, unitsTotal: -1 } })).toBeNull();
  });
});

describe("outcomeCounts", () => {
  const live = { messages: 7, duplicates: 0, skipped: 0, failed: 1, filesDone: 1, filesTotal: 2 };

  it("prefers the report, then the live counters, then the failures of the progress row", () => {
    expect(outcomeCounts(reportOf(report), live, { failed: 9 })).toEqual({
      messages: 40,
      failed: 2,
    });
    expect(outcomeCounts(null, live, { failed: 9 })).toEqual({ messages: 7, failed: 1 });
    // The progress row counts source bytes, so it cannot tell the messages.
    expect(outcomeCounts(null, null, { failed: 9 })).toEqual({ messages: null, failed: 9 });
    expect(outcomeCounts(null, null, null)).toEqual({ messages: null, failed: null });
  });
});

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    tenantId: "t1",
    queue: "import",
    status: "queued",
    protectedObjectId: "obj-1",
    payload: {},
    cursor: null,
    pgBossJobId: null,
    errorMessage: null,
    failure: null,
    startedAt: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Job;
}

function mailImport(overrides: Partial<MailImport> = {}): MailImport {
  return {
    id: "imp-1",
    tenantId: "t1",
    sourceId: "src-1",
    protectedObjectId: "obj-1",
    jobId: "job-1",
    name: "Old mail",
    files: [
      { origin: "upload", uploadId: "u1", kind: "file", path: "a.mbox", size: 10, format: "mbox" },
      { origin: "folder", kind: "directory", path: "MailStore", size: 0, format: null },
    ],
    options: { archive: true },
    report: null,
    createdBy: "user-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as MailImport;
}

function progress(overrides: Partial<JobProgress> = {}): JobProgress {
  return {
    id: "p1",
    tenantId: "t1",
    jobId: "job-1",
    total: 1000,
    done: 250,
    failed: 1,
    bytes: 200,
    etaSeconds: 30,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    mailImport: mailImport(),
    job: job(),
    progress: null,
    actorName: "Ada Admin",
    actorEmail: "ada@example.test",
    ...overrides,
  };
}

describe("toSummaryDto", () => {
  it("summarises a queued import without numbers", () => {
    expect(toSummaryDto(row())).toEqual({
      id: "imp-1",
      name: "Old mail",
      objectId: "obj-1",
      sourceId: "src-1",
      jobId: "job-1",
      status: "queued",
      fileCount: 2,
      archive: true,
      createdAt: NOW.toISOString(),
      completedAt: null,
      messages: null,
      failed: null,
      live: null,
    });
  });

  it("shows live counters only while the import runs", () => {
    const payload = {
      importLive: {
        messages: 3,
        duplicates: 0,
        skipped: 0,
        failed: 0,
        unitsDone: 1,
        unitsTotal: 2,
      },
    };
    const running = toSummaryDto(row({ job: job({ status: "active", payload }) }));
    expect(running.live).toEqual({
      messages: 3,
      duplicates: 0,
      skipped: 0,
      failed: 0,
      filesDone: 1,
      filesTotal: 2,
    });
    expect(running.messages).toBe(3);
    const done = toSummaryDto(row({ job: job({ status: "completed", payload }) }));
    expect(done.live).toBeNull();
  });

  it("takes the numbers from the report once there is one", () => {
    const dto = toSummaryDto(
      row({
        mailImport: mailImport({ report }),
        job: job({ status: "completed", completedAt: later }),
        progress: progress(),
      }),
    );
    expect(dto).toMatchObject({
      status: "completed",
      completedAt: later.toISOString(),
      messages: 40,
      failed: 2,
    });
  });

  it("is unknown without a job", () => {
    expect(toSummaryDto(row({ job: null })).status).toBe("unknown");
  });
});

describe("toDetailDto", () => {
  it("adds files, actor, progress, phase and failures", () => {
    const payload = {
      runtime: { phase: "import", phaseSince: NOW.toISOString() },
      importLive: {
        messages: 3,
        duplicates: 0,
        skipped: 0,
        failed: 1,
        unitsDone: 1,
        unitsTotal: 2,
      },
    };
    const dto = toDetailDto(
      row({
        job: job({ status: "active", startedAt: NOW, payload }),
        progress: progress(),
      }),
      [{ itemRef: "a.mbox#3", reason: "unreadable", attempts: 1 }],
      "acme",
    );
    expect(dto.files).toEqual([
      { origin: "upload", kind: "file", path: "a.mbox", size: 10, format: "mbox" },
      { origin: "folder", kind: "directory", path: "MailStore", size: 0, format: null },
    ]);
    expect(dto.actor).toEqual({ userId: "user-1", name: "Ada Admin", email: "ada@example.test" });
    expect(dto.progress).toEqual({ total: 1000, done: 250, failed: 1, bytes: 200, etaSeconds: 30 });
    expect(dto.phase).toBe("import");
    expect(dto.startedAt).toBe(NOW.toISOString());
    expect(dto.failures).toHaveLength(1);
    expect(dto.report).toBeNull();
    expect(dto.live?.filesTotal).toBe(2);
  });

  it("drops a stale phase of a finished import but keeps the report and the last counters", () => {
    const payload = {
      runtime: { phase: "archive" },
      importLive: {
        messages: 40,
        duplicates: 0,
        skipped: 0,
        failed: 2,
        unitsDone: 2,
        unitsTotal: 2,
      },
    };
    const dto = toDetailDto(
      row({
        mailImport: mailImport({ report }),
        job: job({ status: "failed", errorMessage: "nothing readable", payload }),
      }),
      [],
      "acme",
    );
    expect(dto.phase).toBeNull();
    expect(dto.report?.snapshotId).toBe("snap-1");
    expect(dto.errorMessage).toBe("nothing readable");
    expect(dto.live?.messages).toBe(40);
  });
});

describe("server-folder paths in the detail", () => {
  it("shows them relative to the tenant's folder, whatever the stored prefix", () => {
    const dto = toDetailDto(
      row({
        mailImport: mailImport({
          files: [
            { origin: "folder", kind: "file", path: "acme/mail/a.eml", size: 10, format: "eml" },
            { origin: "folder", kind: "directory", path: "acme/MailStore", size: 0, format: null },
            { origin: "folder", kind: "directory", path: "acme/", size: 0, format: null },
            // Uploads keep their file name, even one that looks like a folder path.
            {
              origin: "upload",
              uploadId: "u1",
              kind: "file",
              path: "acme/x.mbox",
              size: 1,
              format: "mbox",
            },
            // A row from before a slug change is shown as stored, not cut at random.
            { origin: "folder", kind: "file", path: "old-slug/b.eml", size: 1, format: "eml" },
          ],
        }),
      }),
      [],
      "acme",
    );
    expect(dto.files.map((file) => file.path)).toEqual([
      "mail/a.eml",
      "MailStore",
      "",
      "acme/x.mbox",
      "old-slug/b.eml",
    ]);
  });
});
