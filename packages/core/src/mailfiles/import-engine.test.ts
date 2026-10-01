import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { META } from "../backup/imap/paths.js";
import { MemoryRestoreTarget } from "../backup/imap/testing/memory-restore-target.js";
import type { Dek } from "../crypto.js";
import { ChunkReader, JobAbortedError } from "../engine/chunkstore.js";
import { Keyring } from "../engine/keyring.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemoryProgressSink,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../engine/memory.js";
import { loadManifest } from "../engine/snapshot.js";
import type { JobContext, ProtectedObjectRef, RestoreRequest } from "../engine/types.js";
import type { SnapshotManifest } from "../manifest.js";
import { ImapRestoreEngine } from "../restore/imap.js";
import { MemoryStorage } from "../verify/testing.js";
import {
  ImportNothingError,
  type ImportRunInput,
  type ImportUnit,
  MailImportEngine,
  outcomeOfProblem,
} from "./import-engine.js";
import type { MailInputFile, MailWalkEvent, MessageMeta, WalkOptions } from "./types.js";

const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x5a) };
const mailbox: ProtectedObjectRef = {
  id: "po-import-1",
  tenantId: TENANT,
  sourceId: "src-import-1",
  kind: "imap",
  externalId: "import-1",
  displayName: "Legacy mailbox",
  userId: null,
};

function eml(subject: string, id: string, body = "hello"): Buffer {
  return Buffer.from(
    `From: bob@example.test\r\nTo: alice@example.test\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Tue, 05 Mar 2019 14:12:00 +0000\r\n\r\n${body}\r\n`,
  );
}

function metaOf(raw: Buffer): MessageMeta {
  const text = raw.toString("utf8");
  return {
    messageId: /^Message-ID:\s*(\S+)/im.exec(text)?.[1] ?? null,
    subject: /^Subject:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? "",
    from: "bob@example.test",
    to: ["alice@example.test"],
    toCount: 1,
    cc: [],
    ccCount: 0,
    hasAttachments: false,
    attachmentCount: 0,
    sentAt: new Date("2019-03-05T14:12:00Z"),
    protection: null,
    bodyText: "",
  };
}

type FakeItem =
  | { kind: "message"; folder: string[]; raw: Buffer; flags?: string[] }
  | { kind: "problem"; code: "unreadable" | "not_mail" | "pst_not_supported"; reason: string }
  | { kind: "folder"; path: string[] };

/** A walker over scripted items: item numbering and skipItems behave like the real one. */
function fakeWalker(script: Record<string, FakeItem[]>, hooks: { failAfter?: number } = {}) {
  let delivered = 0;
  return async function* walk(
    file: MailInputFile,
    options: WalkOptions,
  ): AsyncGenerator<MailWalkEvent> {
    const items = script[file.path] ?? [];
    let index = 0;
    for (const item of items) {
      if (item.kind === "folder") {
        yield { type: "folder", path: item.path };
        continue;
      }
      const current = index++;
      if (current < (options.skipItems ?? 0)) {
        continue;
      }
      if (hooks.failAfter !== undefined && delivered >= hooks.failAfter) {
        throw new Error("simulated crash");
      }
      delivered++;
      if (item.kind === "problem") {
        yield {
          type: "problem",
          ref: `${file.path}#${current}`,
          index: current,
          code: item.code,
          reason: item.reason,
        };
      } else {
        yield {
          type: "message",
          ref: `${file.path}#${current}`,
          index: current,
          folder: item.folder,
          sourceName: `${current}.eml`,
          format: "eml",
          raw: item.raw,
          synthesized: false,
          flags: item.flags ?? [],
          internalDate: null,
          sourceBytes: item.raw.length,
        };
      }
    }
  };
}

function fileOf(path: string, size = 1000): MailInputFile {
  return {
    path,
    size,
    open: () => Readable.from([Buffer.alloc(size, 1)]),
    read: async (offset, length) => Buffer.alloc(Math.min(length, Math.max(0, size - offset)), 1),
  };
}

function inputOf(paths: string[], size = 1000): ImportRunInput {
  const units: ImportUnit[] = paths.map((path, index) => ({
    key: `folder:${path}`,
    group: index,
    kind: "file",
    path,
    size,
  }));
  return {
    groups: paths.map((path) => ({ label: path, size, kind: "file" as const })),
    units,
    open: (unit) => fileOf(unit.path, size),
  };
}

function setup() {
  const storage = new MemoryStorage();
  const chunkIndex = new MemoryChunkIndex();
  const snapshots = new MemorySnapshotIndex(TENANT);
  const cursor = new MemoryCursorStore();
  const sink = new MemoryProgressSink();
  let counter = 0;
  const context = (signal?: AbortSignal): JobContext =>
    createMemoryJobContext({
      tenantId: TENANT,
      keys: new Keyring(TENANT, [dek]),
      storage,
      chunkIndex,
      snapshots,
      cursor,
      progressSink: sink,
      jobId: `job-${++counter}`,
      signal,
      now: () => new Date("2026-09-30T10:00:00Z"),
    });
  return { storage, chunkIndex, snapshots, cursor, sink, context };
}

async function manifestOf(
  harness: ReturnType<typeof setup>,
  snapshotId: string,
): Promise<SnapshotManifest> {
  const record = await harness.snapshots.get(snapshotId);
  if (!record?.manifestPath) {
    throw new Error("no manifest");
  }
  return loadManifest(
    { primary: harness.storage, copies: [] },
    record.manifestPath,
    new Keyring(TENANT, [dek]),
  );
}

function engine(
  walk: ReturnType<typeof fakeWalker>,
  extra: Partial<ConstructorParameters<typeof MailImportEngine>[0]> = {},
) {
  return new MailImportEngine({
    walk,
    parseMeta: async (raw) => metaOf(raw),
    detect: () => ({ format: "eml" }),
    ...extra,
  });
}

describe("MailImportEngine", () => {
  it("stores messages in the IMAP manifest format with envelope metadata and folders", async () => {
    const h = setup();
    const inbox = eml("Invoice 1", "a1", "please pay");
    const sent = eml("Re: Invoice 1", "a2", "paid");
    const walk = fakeWalker({
      "legacy.mbox": [
        { kind: "message", folder: ["Inbox"], raw: inbox, flags: ["\\Seen"] },
        { kind: "message", folder: ["Inbox", "Projects"], raw: sent },
        { kind: "folder", path: ["Empty"] },
      ],
    });
    const ctx = h.context();
    const result = await engine(walk).run(ctx, mailbox, inputOf(["legacy.mbox"]));

    expect(result.report.totals).toMatchObject({
      messages: 2,
      folders: 3,
      duplicates: 0,
      failed: 0,
      skipped: 0,
    });
    const manifest = await manifestOf(h, result.snapshotId);
    expect(manifest.source).toMatchObject({ type: "imap", kind: "imap" });
    expect(manifest.objects.map((o) => o.path).sort()).toEqual([
      "mail/Empty",
      "mail/Inbox",
      "mail/Inbox/1.eml",
      "mail/Inbox/Projects",
      "mail/Inbox/Projects/1.eml",
    ]);
    const first = manifest.objects.find((o) => o.path === "mail/Inbox/1.eml");
    expect(first).toMatchObject({
      type: "message",
      id: "imap:Inbox:1:1",
      sha256: createHash("sha256").update(inbox).digest("hex"),
    });
    expect(first?.metadata).toMatchObject({
      [META.mailbox]: "Inbox",
      [META.delimiter]: "/",
      [META.uid]: "1",
      [META.uidValidity]: "1",
      [META.flags]: "\\Seen",
      [META.messageId]: "<a1@example.test>",
      [META.subject]: "Invoice 1",
      importJob: ctx.jobId,
      importRef: "legacy.mbox#0",
    });
    const reader = new ChunkReader({ storage: ctx.storage, keys: ctx.keys, index: ctx.chunkIndex });
    expect(await reader.readObjectToBuffer(first as never)).toEqual(inbox);
    const state = manifest.state as { imap: { folders: Record<string, { uidNext: number }> } };
    expect(state.imap.folders.Inbox?.uidNext).toBe(2);
    expect(result.report.totals.sourceBytes).toBe(1000);
  });

  it("skips a repeat in the same folder, keeps it in another folder and lists the skip", async () => {
    const h = setup();
    const same = eml("Newsletter", "n1");
    const walk = fakeWalker({
      "a.mbox": [
        { kind: "message", folder: ["Inbox"], raw: same },
        { kind: "message", folder: ["Inbox"], raw: same },
        { kind: "message", folder: ["Archive"], raw: same },
        { kind: "message", folder: ["Inbox"], raw: eml("Newsletter", "n1", "edited") },
      ],
    });
    const result = await engine(walk).run(h.context(), mailbox, inputOf(["a.mbox"]));
    expect(result.report.totals).toMatchObject({ messages: 3, duplicates: 1, skipped: 1 });
    expect(result.report.items).toEqual([
      expect.objectContaining({ ref: "a.mbox#1", outcome: "skipped", code: "duplicate" }),
    ]);
    const manifest = await manifestOf(h, result.snapshotId);
    expect(manifest.objects.filter((o) => o.type === "message")).toHaveLength(3);
    // Identical bytes share their chunks.
    const bytes = manifest.objects.filter(
      (o) =>
        o.metadata?.[META.mailbox] !== undefined &&
        o.type === "message" &&
        o.sha256 === createHash("sha256").update(same).digest("hex"),
    );
    expect(bytes[0]?.chunks).toEqual(bytes[1]?.chunks);
  });

  it("lists unreadable items as failures with a reason and reports harmless files as skips", async () => {
    const h = setup();
    const walk = fakeWalker({
      "mix.zip": [
        { kind: "message", folder: ["Inbox"], raw: eml("ok", "ok1") },
        { kind: "problem", code: "unreadable", reason: "The message is truncated." },
        { kind: "problem", code: "not_mail", reason: "Not a mail file." },
      ],
    });
    const result = await engine(walk).run(h.context(), mailbox, inputOf(["mix.zip"]));
    expect(result.report.totals).toMatchObject({ messages: 1, failed: 1, skipped: 1 });
    expect(result.report.items.map((i) => [i.ref, i.outcome, i.code])).toEqual([
      ["mix.zip#1", "failed", "unreadable"],
      ["mix.zip#2", "skipped", "not_mail"],
    ]);
    expect(result.report.files[0]).toMatchObject({ path: "mix.zip", status: "partial", failed: 1 });
    expect(h.sink.failures.map((f) => f.itemRef)).toEqual(["mix.zip#1"]);
    expect(outcomeOfProblem("pst_not_supported")).toBe("failed");
  });

  it("writes at most one failure row per listed item, however many items are unreadable", async () => {
    const h = setup();
    const broken = Array.from({ length: 1200 }, (_, i) => ({
      kind: "problem" as const,
      code: "unreadable" as const,
      reason: `Entry ${i} is damaged.`,
    }));
    const walk = fakeWalker({
      "bad.zip": [{ kind: "message", folder: ["Inbox"], raw: eml("ok", "ok1") }, ...broken],
    });
    const result = await engine(walk).run(h.context(), mailbox, inputOf(["bad.zip"]));
    expect(result.report.totals.failed).toBe(1200);
    expect(result.report.items.filter((item) => item.outcome === "failed")).toHaveLength(1000);
    expect(result.report.notes).toContain("item_list_truncated");
    expect(h.sink.failures).toHaveLength(1000);
  });

  it("stores a message whose metadata could not be read and says so in the report", async () => {
    const h = setup();
    const walk = fakeWalker({
      "a.mbox": [
        { kind: "message", folder: ["Inbox"], raw: eml("fine", "f1") },
        { kind: "message", folder: ["Inbox"], raw: eml("slow", "s1") },
      ],
    });
    const result = await engine(walk, {
      parseMeta: async (raw) =>
        raw.includes("slow")
          ? {
              ...metaOf(raw),
              messageId: null,
              subject: "",
              from: null,
              to: [],
              toCount: 0,
              unavailable: true,
            }
          : metaOf(raw),
    }).run(h.context(), mailbox, inputOf(["a.mbox"]));
    expect(result.report.totals.messages).toBe(2);
    expect(result.report.notes).toContain("metadata_unavailable");
    const manifest = await manifestOf(h, result.snapshotId);
    const stored = manifest.objects.filter((o) => o.type === "message");
    expect(stored).toHaveLength(2);
    expect(stored.some((o) => o.metadata?.[META.subject] === "")).toBe(true);
  });

  it("reports no metadata note when every message was parsed", async () => {
    const h = setup();
    const walk = fakeWalker({
      "a.mbox": [{ kind: "message", folder: ["Inbox"], raw: eml("x", "x1") }],
    });
    const result = await engine(walk).run(h.context(), mailbox, inputOf(["a.mbox"]));
    expect(result.report.notes).not.toContain("metadata_unavailable");
  });

  describe("a worker that dies in the middle of a file", () => {
    /**
     * A walker that "kills the process" in `poison`: it keeps the cursor as it stands (what a dead
     * process leaves behind, the orderly clean-up of the engine never runs) and throws; the test
     * puts that cursor back before the next attempt.
     */
    function dyingWalker(
      script: Record<string, FakeItem[]>,
      poison: () => string | null,
      h: ReturnType<typeof setup>,
      left: { cursor: unknown },
    ) {
      const inner = fakeWalker(script);
      return async function* walk(
        file: MailInputFile,
        options: WalkOptions,
      ): AsyncGenerator<MailWalkEvent> {
        if (file.path === poison()) {
          left.cursor = structuredClone(h.cursor.cursor);
          throw new Error("the process died");
        }
        yield* inner(file, options);
      };
    }

    const script: Record<string, FakeItem[]> = {
      "a.eml": [{ kind: "message", folder: ["Inbox"], raw: eml("first", "a1") }],
      "poison.mbox": [
        { kind: "message", folder: ["Inbox"], raw: eml("p1", "p1") },
        { kind: "message", folder: ["Inbox"], raw: eml("p2", "p2") },
      ],
      "z.eml": [{ kind: "message", folder: ["Inbox"], raw: eml("last", "z1") }],
    };
    const units = ["a.eml", "poison.mbox", "z.eml"];

    /** One attempt that ends in a death: the cursor is what the dead process left. */
    async function attemptThatDies(
      h: ReturnType<typeof setup>,
      walk: ReturnType<typeof dyingWalker>,
      left: { cursor: unknown },
      input: ImportRunInput,
    ): Promise<void> {
      await expect(engine(walk).run(h.context(), mailbox, input)).rejects.toThrow("process died");
      h.cursor.cursor = left.cursor as never;
    }

    it("retries once, then reports the rest of the file as failed and imports the files after it", async () => {
      const h = setup();
      const left = { cursor: null as unknown };
      const poisoned: string | null = "poison.mbox";
      const walk = dyingWalker(script, () => poisoned, h, left);
      const input = inputOf(units);

      await attemptThatDies(h, walk, left, input);
      await attemptThatDies(h, walk, left, input);
      // The third attempt does not read the file a third time; the walker would die again.
      const result = await engine(walk).run(h.context(), mailbox, input);

      expect(result.report.totals).toMatchObject({ messages: 2, failed: 1 });
      const failed = result.report.items.filter((item) => item.outcome === "failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        ref: "poison.mbox",
        file: "poison.mbox",
        code: "unreadable",
      });
      expect(failed[0]?.reason).toContain("stopped unexpectedly 2 times in a row");
      expect(failed[0]?.reason).toContain("import it again");
      expect(result.report.files.map((f) => [f.path, f.status])).toEqual([
        ["a.eml", "imported"],
        ["poison.mbox", "failed"],
        ["z.eml", "imported"],
      ]);
      const manifest = await manifestOf(h, result.snapshotId);
      expect(
        manifest.objects
          .filter((o) => o.type === "message")
          .map((o) => o.metadata?.[META.subject])
          .sort(),
      ).toEqual(["first", "last"]);
    });

    it("does not blame the file for a single death", async () => {
      const h = setup();
      const left = { cursor: null as unknown };
      let poisoned: string | null = "poison.mbox";
      const walk = dyingWalker(script, () => poisoned, h, left);
      const input = inputOf(units);

      await attemptThatDies(h, walk, left, input);
      poisoned = null;
      const result = await engine(walk).run(h.context(), mailbox, input);
      expect(result.report.totals).toMatchObject({ messages: 4, failed: 0 });
    });

    it("does not count orderly failures, only deaths", async () => {
      const h = setup();
      let attempts = 0;
      const inner = fakeWalker(script);
      const walk = async function* (
        file: MailInputFile,
        options: WalkOptions,
      ): AsyncGenerator<MailWalkEvent> {
        if (file.path === "poison.mbox" && attempts++ < 3) {
          throw new Error("a storage error");
        }
        yield* inner(file, options);
      };
      const input = inputOf(units);
      for (let i = 0; i < 3; i++) {
        await expect(engine(walk).run(h.context(), mailbox, input)).rejects.toThrow(
          "storage error",
        );
      }
      const result = await engine(walk).run(h.context(), mailbox, input);
      expect(result.report.totals).toMatchObject({ messages: 4, failed: 0 });
    });

    it("does not add up deaths in different files", async () => {
      const h = setup();
      const left = { cursor: null as unknown };
      let poisoned: string | null = "poison.mbox";
      const walk = dyingWalker(script, () => poisoned, h, left);
      const input = inputOf(units);
      await attemptThatDies(h, walk, left, input);
      // The next attempt gets past poison.mbox and dies in z.eml.
      poisoned = "z.eml";
      await attemptThatDies(h, walk, left, input);
      poisoned = null;
      const result = await engine(walk).run(h.context(), mailbox, input);
      expect(result.report.totals).toMatchObject({ messages: 4, failed: 0 });
    });

    it("finds the file even when the files before it stored nothing", async () => {
      const h = setup();
      const left = { cursor: null as unknown };
      const poisoned = "poison.mbox";
      const quiet: Record<string, FakeItem[]> = {
        "x1.txt": [{ kind: "problem", code: "not_mail", reason: "Not a mail file." }],
        "x2.txt": [{ kind: "problem", code: "not_mail", reason: "Not a mail file." }],
        "poison.mbox": script["poison.mbox"] as FakeItem[],
        "z.eml": script["z.eml"] as FakeItem[],
      };
      const walk = dyingWalker(quiet, () => poisoned, h, left);
      // A big file: the position is always saved in front of it, the small files before it are
      // saved at most once a second.
      const plain = inputOf(["x1.txt", "x2.txt", "poison.mbox", "z.eml"]);
      const input: ImportRunInput = {
        ...plain,
        units: plain.units.map((unit) =>
          unit.kind === "file" && unit.path === "poison.mbox"
            ? { ...unit, size: 5 * 1024 * 1024 }
            : unit,
        ),
      };

      await attemptThatDies(h, walk, left, input);
      await attemptThatDies(h, walk, left, input);
      const result = await engine(walk).run(h.context(), mailbox, input);

      expect(result.report.totals).toMatchObject({ messages: 1, failed: 1, skipped: 2 });
      expect(result.report.files.map((f) => [f.path, f.status])).toEqual([
        ["x1.txt", "imported"],
        ["x2.txt", "imported"],
        ["poison.mbox", "failed"],
        ["z.eml", "imported"],
      ]);
    });

    it("leaves nothing behind when an import finishes", async () => {
      const h = setup();
      const walk = fakeWalker(script);
      await engine(walk).run(h.context(), mailbox, inputOf(units));
      expect(h.cursor.cursor).toBeNull();
    });
  });

  it("refuses a PST file as a failed, refused file and fails the run when nothing else was read", async () => {
    const h = setup();
    const walk = fakeWalker({
      "old.pst": [{ kind: "problem", code: "pst_not_supported", reason: "PST import is planned." }],
    });
    const failure = await engine(walk)
      .run(h.context(), mailbox, inputOf(["old.pst"]))
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImportNothingError);
    const report = (failure as ImportNothingError).report;
    expect(report.files[0]).toMatchObject({ status: "refused", failed: 1 });
    expect(report.items[0]).toMatchObject({ code: "pst_not_supported", outcome: "failed" });
    // Nothing was stored, but not because it was all there already.
    expect((failure as ImportNothingError).alreadyImported).toBeNull();
    // No snapshot was left behind.
    expect(await h.snapshots.latestCompleted(mailbox.id)).toBeNull();
  });

  it("adds to an existing mailbox and never stores a message twice across runs", async () => {
    const h = setup();
    const walk = fakeWalker({
      "one.mbox": [{ kind: "message", folder: ["Inbox"], raw: eml("first", "f1") }],
      "two.mbox": [
        { kind: "message", folder: ["Inbox"], raw: eml("first", "f1") },
        { kind: "message", folder: ["Inbox"], raw: eml("second", "f2") },
      ],
    });
    const first = await engine(walk).run(h.context(), mailbox, inputOf(["one.mbox"]));
    const second = await engine(walk).run(h.context(), mailbox, inputOf(["two.mbox"]));
    expect(second.sequence).toBe(2);
    expect(second.report.totals).toMatchObject({ messages: 1, duplicates: 1 });
    const manifest = await manifestOf(h, second.snapshotId);
    expect(manifest.objects.filter((o) => o.type === "message").map((o) => o.path)).toEqual([
      "mail/Inbox/1.eml",
      "mail/Inbox/2.eml",
    ]);
    // Re-importing the same file finds nothing new and stores no snapshot.
    const again = await engine(walk)
      .run(h.context(), mailbox, inputOf(["two.mbox"]))
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(ImportNothingError);
    // Every message was a duplicate and none unreadable: the run says how many were already there.
    expect((again as ImportNothingError).alreadyImported).toBe(2);
    expect((again as ImportNothingError).report.totals).toMatchObject({
      messages: 0,
      duplicates: 2,
      failed: 0,
    });
    expect((await h.snapshots.latestCompleted(mailbox.id))?.id).toBe(second.snapshotId);
    expect(first.snapshotId).not.toBe(second.snapshotId);
  });

  it("resumes after a crash without reading a message twice", async () => {
    const h = setup();
    const many: FakeItem[] = Array.from({ length: 12 }, (_, i) => ({
      kind: "message" as const,
      folder: ["Inbox"],
      raw: eml(`m${i}`, `id${i}`),
    }));
    const script = {
      "big.mbox": many,
      "tail.mbox": [{ kind: "message" as const, folder: ["Tail"], raw: eml("t", "t1") }],
    };
    const input = inputOf(["big.mbox", "tail.mbox"]);
    const crashing = engine(fakeWalker(script, { failAfter: 7 }), { checkpointEveryMessages: 3 });
    await expect(crashing.run(h.context(), mailbox, input)).rejects.toThrow("simulated crash");
    const saved = await h.cursor.load();
    expect(saved?.snapshot).toBeDefined();
    expect(saved?.import).toMatchObject({ unitsDone: 0 });

    const seen: string[] = [];
    const inner = fakeWalker(script);
    const recording = engine(
      async function* (file, options) {
        for await (const event of inner(file, options)) {
          if (event.type === "message") {
            seen.push(event.ref);
          }
          yield event;
        }
      },
      { checkpointEveryMessages: 3 },
    );
    const result = await recording.run(h.context(), mailbox, input);
    expect(result.report.totals.messages).toBe(13);
    expect(new Set(seen).size).toBe(seen.length);
    // The resumed run started after the last checkpoint, not at the beginning.
    expect(seen.length).toBeLessThan(13);
    const manifest = await manifestOf(h, result.snapshotId);
    const paths = manifest.objects.filter((o) => o.type === "message").map((o) => o.path);
    expect(new Set(paths).size).toBe(13);
    expect(paths).toContain("mail/Tail/1.eml");
    expect(await h.cursor.load()).toBeNull();
  });

  it("starts over when the input list changed since the checkpoint", async () => {
    const h = setup();
    const script = {
      "a.mbox": Array.from({ length: 6 }, (_, i) => ({
        kind: "message" as const,
        folder: ["Inbox"],
        raw: eml(`m${i}`, `id${i}`),
      })),
      "b.mbox": [{ kind: "message" as const, folder: ["Inbox"], raw: eml("b", "b1") }],
    };
    const crashing = engine(fakeWalker(script, { failAfter: 4 }), { checkpointEveryMessages: 2 });
    await expect(crashing.run(h.context(), mailbox, inputOf(["a.mbox"]))).rejects.toThrow();
    const result = await engine(fakeWalker(script)).run(
      h.context(),
      mailbox,
      inputOf(["a.mbox", "b.mbox"]),
    );
    expect(result.report.totals.messages).toBe(7);
  });

  it("stops at an item boundary when the job is cancelled and keeps a checkpoint", async () => {
    const h = setup();
    const controller = new AbortController();
    const items: FakeItem[] = Array.from({ length: 5 }, (_, i) => ({
      kind: "message" as const,
      folder: ["Inbox"],
      raw: eml(`m${i}`, `c${i}`),
    }));
    const inner = fakeWalker({ "c.mbox": items });
    const walk = async function* (file: MailInputFile, options: WalkOptions) {
      let count = 0;
      for await (const event of inner(file, options)) {
        yield event;
        if (++count === 2) {
          controller.abort();
        }
      }
    };
    await expect(
      engine(walk, { checkpointEveryMessages: 1 }).run(
        h.context(controller.signal),
        mailbox,
        inputOf(["c.mbox"]),
      ),
    ).rejects.toBeInstanceOf(JobAbortedError);
    expect((await h.cursor.load())?.import).toMatchObject({ unitsDone: 0, itemsDone: 2 });
  });

  it("produces a mailbox the IMAP restore engine can restore byte for byte", async () => {
    const h = setup();
    const a = eml("Quarterly", "q1", "numbers");
    const b = eml("Lunch", "q2", "12:30");
    const walk = fakeWalker({
      "x.mbox": [
        { kind: "message", folder: ["Inbox"], raw: a, flags: ["\\Seen"] },
        { kind: "message", folder: ["Team", "Food"], raw: b },
      ],
    });
    const ctx = h.context();
    const result = await engine(walk).run(ctx, mailbox, inputOf(["x.mbox"]));
    const target = new MemoryRestoreTarget("/");
    const restore = new ImapRestoreEngine({ imap: async () => target });
    const request: RestoreRequest = {
      restoreJobId: "restore-1",
      snapshotId: result.snapshotId,
      protectedObject: mailbox,
      selection: { all: true },
      target: { type: "other", ref: "someone@example.test" },
      mode: "rename",
      actor: { userId: null, impersonated: false, reason: null },
    };
    const report = await restore.run(h.context(), request);
    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    const restored = target
      .mailboxNames()
      .flatMap((name) => target.mailbox(name).map((message) => message.content));
    expect(restored).toContainEqual(a);
    expect(restored).toContainEqual(b);
  });
});
