import { describe, expect, it } from "vitest";
import { MissingChunkError } from "../engine/chunkstore.js";
import { MemoryProgressSink } from "../engine/memory.js";
import { ProgressTracker } from "../engine/progress.js";
import { GraphError } from "../graph/errors.js";
import type { ManifestObject } from "../manifest.js";
import {
  RestoreIntegrityError,
  RestoreLedger,
  describeRestoreError,
  failureCodeOf,
} from "./results.js";

function object(path: string, extra: Partial<ManifestObject> = {}): ManifestObject {
  return { path, size: 10, mtime: 0, chunks: [], ...extra };
}

function ledger(): { ledger: RestoreLedger; progress: ProgressTracker } {
  const progress = new ProgressTracker({
    sink: new MemoryProgressSink(),
    flushEveryItems: 1,
    flushIntervalMs: 0,
  });
  return { ledger: new RestoreLedger(progress), progress };
}

describe("RestoreLedger", () => {
  it("counts items, keeps folders apart and reports every outcome", () => {
    const { ledger: book, progress } = ledger();
    book.restored(object("a.txt", { id: "A" }), { targetRef: "t1", verified: true });
    book.restored(object("b.txt", { id: "B" }), { verified: false, note: "size differs" });
    book.restored(object("Docs", { type: "folder" }), { bytes: 0, verified: true });
    book.skipped(object("c.txt", { id: "C" }), "exists", "already there", "t3");
    book.failed(object("d.txt", { id: "D" }), new MissingChunkError("ab"));

    const report = book.report();
    expect(report).toMatchObject({ restored: 2, skipped: 1, folders: 1, unverified: 1, bytes: 20 });
    expect(report.failures).toEqual([
      {
        itemRef: "D",
        reason: "chunk ab is not in the chunk index",
        cause: expect.objectContaining({ code: "verify.chunk_missing", transient: false }),
      },
    ]);
    // The item keeps the cause too, so the job page can explain it.
    expect(report.items.find((item) => item.path === "d.txt")?.cause?.code).toBe(
      "verify.chunk_missing",
    );
    expect(report.items.map((item) => [item.path, item.status, item.code])).toEqual([
      ["a.txt", "restored", "restored"],
      ["b.txt", "restored", "unverified"],
      ["Docs", "restored", "restored"],
      ["c.txt", "skipped", "exists"],
      ["d.txt", "failed", "data_missing"],
    ]);
    expect(report.items[1]?.reason).toBe("size differs");
    expect(progress.snapshot()).toMatchObject({ done: 4, failed: 1, bytes: 20 });
  });

  it("keeps a mail's subject and sender so reports can name it instead of 1.eml", () => {
    const { ledger: book } = ledger();
    book.restored(
      object("mail/INBOX/1.eml", {
        type: "mail",
        metadata: { subject: "Invoice 4711", from: "Anna Muster <anna@example.com>" },
      }),
    );
    book.restored(object("Documents/a.docx", { metadata: { subject: "  " } }));
    const [mail, file] = book.report().items;
    expect(mail).toMatchObject({ subject: "Invoice 4711", from: "Anna Muster <anna@example.com>" });
    expect(file?.subject).toBeUndefined();
    expect(file?.from).toBeUndefined();
  });

  it("fails whatever no engine step reported", () => {
    const { ledger: book } = ledger();
    const done = object("a.txt");
    book.restored(done);
    book.settle([done, object("forgotten.txt", { id: "F" })]);
    expect(book.report().failures).toEqual([
      {
        itemRef: "F",
        reason: "the item was not processed by the restore",
        cause: expect.objectContaining({ code: "unknown" }),
      },
    ]);
  });
});

describe("failure codes", () => {
  it("derives the code from the error", () => {
    expect(failureCodeOf(new MissingChunkError("x"))).toBe("data_missing");
    expect(failureCodeOf(new RestoreIntegrityError("bad"))).toBe("integrity");
    expect(failureCodeOf(new Error("object a: content hash mismatch"))).toBe("integrity");
    expect(failureCodeOf(new GraphError({ status: 403, method: "POST", url: "/x" }))).toBe(
      "target_rejected",
    );
    expect(failureCodeOf(new Error("something else"))).toBe("error");
  });

  it("keeps reasons short", () => {
    expect(describeRestoreError(new Error("x".repeat(600)))).toHaveLength(501);
    expect(describeRestoreError("plain")).toBe("plain");
  });
});
