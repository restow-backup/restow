import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dek } from "../../crypto.js";
import { ChunkReader, JobAbortedError } from "../../engine/chunkstore.js";
import { Keyring } from "../../engine/keyring.js";
import { createLogger, type LogRecord } from "../../engine/logger.js";
import {
  createMemoryJobContext,
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
} from "../../engine/memory.js";
import { loadManifest, SnapshotWriter } from "../../engine/snapshot.js";
import type { JobContext, ProtectedObjectRef, RestoreRequest } from "../../engine/types.js";
import { classifyFailure } from "../../failures/classify.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { ImapRestoreEngine } from "../../restore/imap.js";
import { LocalStorageBackend } from "../../storage/local.js";
import { ImapBackupEngine, type ImapBackupEngineOptions } from "./engine.js";
import { decodeFlags, META } from "./paths.js";
import { FakeImapServer } from "./testing/fake-imap.js";
import { MemoryRestoreTarget } from "./testing/memory-restore-target.js";
import {
  type ImapAccountConfig,
  ImapAuthError,
  ImapConfigError,
  type ImapConnector,
} from "./types.js";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000002";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x11) };
const account: ImapAccountConfig = {
  host: "imap.example.test",
  port: 993,
  security: "tls",
  username: "alice@example.test",
  authKind: "password",
  secretId: "secret-alice",
};
const protectedObject: ProtectedObjectRef = {
  id: "po-imap-1",
  tenantId: TENANT,
  sourceId: "src-imap-1",
  kind: "imap",
  externalId: "alice@example.test",
  displayName: "Alice (IMAP)",
  userId: null,
};

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("expected a value");
  }
  return value;
}

function eml(subject: string, body = "hello"): string {
  return `From: bob@example.test\r\nTo: alice@example.test\r\nSubject: ${subject}\r\n\r\n${body}\r\n`;
}

describe("ImapBackupEngine", () => {
  let root: string;
  let server: FakeImapServer;
  let chunkIndex: MemoryChunkIndex;
  let snapshots: MemorySnapshotIndex;
  let cursor: MemoryCursorStore;
  let jobCounter: number;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-imap-"));
    server = new FakeImapServer();
    chunkIndex = new MemoryChunkIndex();
    snapshots = new MemorySnapshotIndex(TENANT);
    cursor = new MemoryCursorStore();
    jobCounter = 0;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function context(
    overrides: {
      signal?: AbortSignal;
      secrets?: Record<string, string>;
      logs?: LogRecord[];
      now?: () => Date;
    } = {},
  ) {
    const logs = overrides.logs;
    return createMemoryJobContext({
      tenantId: TENANT,
      keys: new Keyring(TENANT, [dek]),
      storage: new LocalStorageBackend(root),
      chunkIndex,
      snapshots,
      cursor,
      jobId: `job-${++jobCounter}`,
      secrets: overrides.secrets ?? { "secret-alice": "test-password-not-real" },
      signal: overrides.signal,
      now: overrides.now ?? (() => new Date("2026-09-22T10:00:00Z")),
      ...(logs ? { logger: createLogger({ sink: (record) => logs.push(record) }) } : {}),
    });
  }

  function logLine(logs: readonly LogRecord[], message: string, folder?: string): LogRecord {
    const line = logs.find(
      (record) => record.message === message && (folder === undefined || record.folder === folder),
    );
    if (!line) {
      throw new Error(`no "${message}" log line${folder ? ` for ${folder}` : ""}`);
    }
    return line;
  }

  function engine(options: Partial<ImapBackupEngineOptions> = {}): ImapBackupEngine {
    return new ImapBackupEngine({
      resolveAccount: async () => account,
      connector: server,
      limits: {
        checkpointEveryMessages: 3,
        checkpointMinIntervalMs: 0,
        fetchBatchMessages: 4,
        metaBatchMessages: 5,
      },
      ...options,
    });
  }

  async function manifestOf(snapshotId: string): Promise<SnapshotManifest> {
    const record = await snapshots.get(snapshotId);
    if (!record?.manifestPath) {
      throw new Error(`snapshot ${snapshotId} has no manifest`);
    }
    return loadManifest(
      { primary: new LocalStorageBackend(root), copies: [] },
      record.manifestPath,
      new Keyring(TENANT, [dek]),
    );
  }

  async function readBack(ctx: JobContext, object: ManifestObject): Promise<Buffer> {
    const reader = new ChunkReader({ storage: ctx.storage, keys: ctx.keys, index: ctx.chunkIndex });
    return reader.readObjectToBuffer(object);
  }

  function messages(manifest: SnapshotManifest): ManifestObject[] {
    return manifest.objects.filter((object) => object.type === "message");
  }

  function seedMailbox(): void {
    const inbox = server.addFolder("INBOX");
    inbox.add(eml("one"), { flags: ["\\Seen"] });
    inbox.add(eml("two"));
    inbox.add(eml("three", "a".repeat(5000)), { flags: ["\\Flagged"] });
    const sent = server.addFolder("Sent", { specialUse: "\\Sent" });
    sent.add(eml("sent one"));
    server.addFolder("Projects", { selectable: false });
    server.addFolder("Projects/Restow").add(eml("project mail"));
    server.addFolder("Empty");
  }

  it("stores every message byte-exact with flags, dates, folders and per-folder state", async () => {
    seedMailbox();
    const ctx = context();
    const result = await engine().run(ctx, protectedObject, {});

    expect(result.sequence).toBe(1);
    expect(result.objectsWritten).toBe(5);
    expect(result.failures).toEqual([]);
    expect(result.bytes).toBeGreaterThan(0);

    const manifest = await manifestOf(result.snapshotId);
    expect(manifest.source).toMatchObject({ type: "imap", id: "alice@example.test", kind: "imap" });
    const paths = manifest.objects.map((object) => object.path).sort();
    expect(paths).toEqual([
      "mail/Empty",
      "mail/INBOX",
      "mail/INBOX/1.eml",
      "mail/INBOX/2.eml",
      "mail/INBOX/3.eml",
      "mail/Projects/Restow",
      "mail/Projects/Restow/1.eml",
      "mail/Sent",
      "mail/Sent/1.eml",
    ]);

    for (const object of messages(manifest)) {
      const folder = server.folder(object.metadata?.[META.mailbox] as string);
      const original = folder.messages.get(Number(object.metadata?.[META.uid]));
      expect(original).toBeDefined();
      expect(await readBack(ctx, object)).toEqual(original?.source);
      expect(object.size).toBe(original?.source.length);
      expect(decodeFlags(object.metadata?.[META.flags])).toEqual(
        [...(original?.flags ?? [])].sort(),
      );
      expect(object.metadata?.[META.internalDate]).toBe(original?.internalDate.toISOString());
      expect(object.mtime).toBe(original?.internalDate.getTime());
      expect(object.metadata?.[META.messageId]).toBe(original?.messageId);
      expect(object.metadata?.[META.uidValidity]).toBe(String(folder.uidValidity));
    }

    const sentMail = manifest.objects.find((object) => object.path === "mail/Sent/1.eml");
    expect(sentMail?.metadata?.[META.specialUse]).toBe("\\Sent");
    expect(sentMail?.id).toBe("imap:Sent:1000:1");

    const state = manifest.state as { imap: { folders: Record<string, unknown> } };
    expect(Object.keys(state.imap.folders).sort()).toEqual([
      "Empty",
      "INBOX",
      "Projects/Restow",
      "Sent",
    ]);
    expect(state.imap.folders.INBOX).toEqual({
      uidValidity: "1000",
      uidNext: 4,
      delimiter: "/",
      specialUse: "\\Inbox",
      messages: 3,
    });
    expect(cursor.cursor).toBeNull();
    expect(server.stats.open).toBe(0);
  });

  it("downloads only new messages on an incremental run, drops deleted ones and refreshes flags", async () => {
    seedMailbox();
    const first = await engine().run(context(), protectedObject, {});
    const firstManifest = await manifestOf(first.snapshotId);
    server.stats.sourcesDelivered.length = 0;

    const inbox = server.folder("INBOX");
    inbox.delete(2);
    inbox.setFlags(1, ["\\Seen", "\\Answered"]);
    const added = inbox.add(eml("four"));
    server.folder("Sent").add(eml("sent two"));

    const second = await engine().run(context(), protectedObject, {});
    expect(second.sequence).toBe(2);
    expect(second.objectsWritten).toBe(2);
    expect(server.stats.sourcesDelivered.sort()).toEqual([`INBOX:${added.uid}`, "Sent:2"]);

    const manifest = await manifestOf(second.snapshotId);
    const paths = messages(manifest)
      .map((object) => object.path)
      .sort();
    expect(paths).toEqual([
      "mail/INBOX/1.eml",
      "mail/INBOX/3.eml",
      "mail/INBOX/4.eml",
      "mail/Projects/Restow/1.eml",
      "mail/Sent/1.eml",
      "mail/Sent/2.eml",
    ]);

    const carried = manifest.objects.find((object) => object.path === "mail/INBOX/1.eml");
    const before = firstManifest.objects.find((object) => object.path === "mail/INBOX/1.eml");
    expect(carried?.chunks).toEqual(before?.chunks);
    expect(carried?.sha256).toBe(before?.sha256);
    expect(decodeFlags(carried?.metadata?.[META.flags])).toEqual(["\\Answered", "\\Seen"]);

    const untouched = manifest.objects.find((object) => object.path === "mail/INBOX/3.eml");
    expect(untouched).toEqual(firstManifest.objects.find((o) => o.path === "mail/INBOX/3.eml"));
    expect(await snapshots.latestCompleted(protectedObject.id)).toMatchObject({
      id: second.snapshotId,
    });
  });

  it("re-reads a folder whose UIDVALIDITY changed without storing its bytes twice", async () => {
    seedMailbox();
    await engine().run(context(), protectedObject, {});
    server.stats.sourcesDelivered.length = 0;

    const inbox = server.folder("INBOX");
    inbox.delete(1);
    inbox.resetUidValidity(2000); // remaining messages become UID 1 and 2
    const ctx = context();
    const chunkLookups = vi.spyOn(chunkIndex, "existing");
    const result = await engine().run(ctx, protectedObject, {});

    expect(result.objectsWritten).toBe(2);
    expect(result.bytes).toBe(0);
    expect(server.stats.sourcesDelivered.sort()).toEqual(["INBOX:1", "INBOX:2"]);
    // Message-ID plus hash matched the stored copies: nothing went through the chunk writer.
    expect(chunkLookups).not.toHaveBeenCalled();

    const manifest = await manifestOf(result.snapshotId);
    const inboxObjects = messages(manifest).filter(
      (object) => object.metadata?.[META.mailbox] === "INBOX",
    );
    expect(inboxObjects.map((object) => object.path).sort()).toEqual([
      "mail/INBOX/1.eml",
      "mail/INBOX/2.eml",
    ]);
    for (const object of inboxObjects) {
      expect(object.metadata?.[META.uidValidity]).toBe("2000");
      expect(object.id).toBe(`imap:INBOX:2000:${object.metadata?.[META.uid]}`);
      const original = inbox.messages.get(Number(object.metadata?.[META.uid]));
      expect(await readBack(ctx, object)).toEqual(original?.source);
    }
    const state = manifest.state as { imap: { folders: Record<string, { uidValidity: string }> } };
    expect(state.imap.folders.INBOX.uidValidity).toBe("2000");
    // The other folders were still incremental.
    expect(messages(manifest).filter((o) => o.metadata?.[META.mailbox] === "Sent")).toHaveLength(1);
  });

  it("stores changed bytes under a known Message-ID anew and dedupes messages without one at chunk level", async () => {
    const inbox = server.addFolder("INBOX");
    inbox.add(eml("stable"), { messageId: "<stable@test>" });
    inbox.add(eml("rewritten"), { messageId: "<rewritten@test>" });
    inbox.add(eml("anonymous", "no id"), { messageId: null });
    await engine().run(context(), protectedObject, {});

    // A server migration: new UIDVALIDITY, and one message's headers were rewritten on the way.
    const rebuilt = server.addFolder("INBOX", { uidValidity: 7 });
    rebuilt.add(eml("stable"), { messageId: "<stable@test>" });
    rebuilt.add(`X-Migrated: yes\r\n${eml("rewritten")}`, { messageId: "<rewritten@test>" });
    rebuilt.add(eml("anonymous", "no id"), { messageId: null });

    const logs: LogRecord[] = [];
    const ctx = context({ logs });
    const result = await engine().run(ctx, protectedObject, {});
    expect(result.objectsWritten).toBe(3);
    expect(result.failures).toEqual([]);
    expect(logLine(logs, "imap folder planned", "INBOX")).toMatchObject({
      mode: "full",
      reason: "uidvalidity_changed",
      toFetch: 3,
    });
    // Only the stable message matched by Message-ID and hash; the anonymous one deduped by chunk.
    expect(logLine(logs, "imap backup finished")).toMatchObject({ objectsDeduplicated: 1 });
    // The rewritten message is the only one holding new bytes (it is a single small chunk).
    expect(result.bytes).toBe(rebuilt.messages.get(2)?.source.length);

    const manifest = await manifestOf(result.snapshotId);
    for (const object of messages(manifest)) {
      const original = rebuilt.messages.get(Number(object.metadata?.[META.uid]));
      expect(object.metadata?.[META.uidValidity]).toBe("7");
      expect(await readBack(ctx, object)).toEqual(original?.source);
    }
  });

  it("reuses the stored chunks of a message moved into another folder", async () => {
    const inbox = server.addFolder("INBOX");
    inbox.add(eml("keep me", "k".repeat(3000)), { messageId: "<moved@test>" });
    server.addFolder("Archive");
    const first = await engine().run(context(), protectedObject, {});
    const before = (await manifestOf(first.snapshotId)).objects.find(
      (object) => object.path === "mail/INBOX/1.eml",
    );

    const moved = inbox.messages.get(1);
    inbox.delete(1);
    server.folder("Archive").add(moved?.source as Buffer, { messageId: "<moved@test>" });
    const logs: LogRecord[] = [];
    const chunkLookups = vi.spyOn(chunkIndex, "existing");
    const result = await engine().run(context({ logs }), protectedObject, {});

    expect(result.objectsWritten).toBe(1);
    expect(result.bytes).toBe(0);
    expect(chunkLookups).not.toHaveBeenCalled();
    expect(logLine(logs, "imap folder planned", "INBOX")).toMatchObject({ deleted: 1 });
    expect(logLine(logs, "imap folder planned", "Archive")).toMatchObject({
      mode: "incremental",
      arrived: 1,
      retried: 0,
    });
    expect(logLine(logs, "imap backup finished")).toMatchObject({ objectsDeduplicated: 1 });
    const manifest = await manifestOf(result.snapshotId);
    const archived = manifest.objects.find((object) => object.path === "mail/Archive/1.eml");
    expect(archived?.chunks).toEqual(before?.chunks);
    expect(archived?.sha256).toBe(before?.sha256);
    expect(archived?.metadata?.[META.mailbox]).toBe("Archive");
    expect(manifest.objects.some((object) => object.path === "mail/INBOX/1.eml")).toBe(false);
  });

  it("re-reads everything when a full run is requested", async () => {
    seedMailbox();
    await engine().run(context(), protectedObject, {});
    server.stats.sourcesDelivered.length = 0;

    const result = await engine().run(context(), protectedObject, { full: true });
    expect(result.objectsWritten).toBe(5);
    expect(result.bytes).toBe(0);
    expect(server.stats.sourcesDelivered).toHaveLength(5);
  });

  describe("a full read that fails mid-folder (download cap after four messages, twice)", () => {
    function capAfterFour(): void {
      server.faults.refuseSource.add("INBOX:5");
      server.faults.refuseSourceCode = "OVERQUOTA";
    }

    function inboxOf(manifest: SnapshotManifest) {
      return messages(manifest)
        .filter((o) => o.metadata?.[META.mailbox] === "INBOX")
        .map((o) => [Number(o.metadata?.[META.uid]), o.metadata?.[META.uidValidity]])
        .sort((a, b) => Number(a[0]) - Number(b[0]));
    }

    it("keeps every previous message of a folder in a requested full run", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 6; i++) {
        inbox.add(eml(`m${i}`));
      }
      const first = await engine().run(context(), protectedObject, {});
      inbox.setFlags(6, ["Seen"]);
      capAfterFour();

      const result = await engine().run(context(), protectedObject, { full: true });
      expect(result.failures.map((f) => [f.itemRef, f.cause?.code])).toEqual([
        ["INBOX", "imap.server_limit"],
      ]);
      const manifest = await manifestOf(result.snapshotId);
      expect(inboxOf(manifest)).toEqual(inboxOf(await manifestOf(first.snapshotId)));
      // Carried with the flags the folder has now.
      const six = messages(manifest).find((o) => o.path === "mail/INBOX/6.eml");
      expect(decodeFlags(six?.metadata?.[META.flags] ?? "")).toEqual(["Seen"]);
      expect(manifest.objects.some((o) => o.type === "folder" && o.path === "mail/INBOX")).toBe(
        true,
      );
    });

    it("keeps what it read under a new UIDVALIDITY and the older copies of the rest, and goes on next run", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 6; i++) {
        inbox.add(eml(`m${i}`));
      }
      await engine().run(context(), protectedObject, {});
      inbox.resetUidValidity(2000);
      capAfterFour();

      const failed = await engine().run(context(), protectedObject, {});
      expect(failed.failures.map((f) => f.itemRef)).toEqual(["INBOX"]);
      const manifest = await manifestOf(failed.snapshotId);
      // Messages 1-4 under the new UIDs, 5 and 6 as their older copies: all six, once each.
      expect(inboxOf(manifest)).toEqual([
        [1, "2000"],
        [2, "2000"],
        [3, "2000"],
        [4, "2000"],
        [5, "1000"],
        [6, "1000"],
      ]);
      expect(
        messages(manifest)
          .filter((o) => o.metadata?.[META.uidValidity] === "1000")
          .map((o) => o.path)
          .sort(),
      ).toEqual(["mail/INBOX/5.v1000.eml", "mail/INBOX/6.v1000.eml"]);
      const state = manifest.state as {
        imap: { folders: Record<string, { uidValidity: string }> };
      };
      expect(state.imap.folders.INBOX.uidValidity).toBe("2000");

      server.faults.refuseSource.clear();
      server.stats.sourcesDelivered.length = 0;
      const logs: LogRecord[] = [];
      const next = await engine().run(context({ logs }), protectedObject, {});
      expect(next.failures).toEqual([]);
      expect(logLine(logs, "imap folder planned", "INBOX")).toMatchObject({
        mode: "incremental",
        toFetch: 2,
      });
      expect(server.stats.sourcesDelivered).toEqual(["INBOX:5", "INBOX:6"]);
      const healed = inboxOf(await manifestOf(next.snapshotId));
      expect(healed).toHaveLength(6);
      expect(healed.every(([, validity]) => validity === "2000")).toBe(true);
    });

    it("converges under a download cap that recurs every run after a UIDVALIDITY change", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 12; i++) {
        inbox.add(eml(`m${i}`));
      }
      await engine().run(context(), protectedObject, {});
      inbox.resetUidValidity(2000);

      const newCopies: number[] = [];
      for (let run = 1; run <= 3; run++) {
        server.faults.downloadCap = 4;
        const result = await engine().run(context(), protectedObject, {});
        const inboxNow = inboxOf(await manifestOf(result.snapshotId));
        // Never a message lost or doubled while the folder is read again.
        expect(inboxNow).toHaveLength(12);
        newCopies.push(inboxNow.filter(([, validity]) => validity === "2000").length);
        if (run < 3) {
          expect(result.failures.map((f) => [f.itemRef, f.cause?.code])).toEqual([
            ["INBOX", "imap.server_limit"],
          ]);
        } else {
          expect(result.failures).toEqual([]);
        }
      }
      expect(newCopies).toEqual([4, 8, 12]);
    });
  });

  describe("servers that leave out the delimiter, UIDNEXT or UIDVALIDITY", () => {
    it("reads a folder with a NIL delimiter and no UIDNEXT incrementally on the next run", async () => {
      const inbox = server.addFolder("INBOX", { delimiter: null, noUidNext: true });
      inbox.add(eml("one"));
      inbox.add(eml("two"));
      const first = await engine().run(context(), protectedObject, {});
      const state = (await manifestOf(first.snapshotId)).state as {
        imap: { folders: Record<string, Record<string, unknown>> };
      };
      expect(state.imap.folders.INBOX).toMatchObject({ uidValidity: "1000", delimiter: "" });
      expect(state.imap.folders.INBOX?.uidNext).toBeUndefined();
      inbox.add(eml("three"));

      const logs: LogRecord[] = [];
      server.stats.sourcesDelivered.length = 0;
      const second = await engine().run(context({ logs }), protectedObject, {});
      expect(logLine(logs, "imap folder planned", "INBOX")).toMatchObject({
        mode: "incremental",
        toFetch: 1,
      });
      expect(server.stats.sourcesDelivered).toEqual(["INBOX:3"]);
      expect(messages(await manifestOf(second.snapshotId))).toHaveLength(3);
    });

    it("fails only the folder that comes without UIDVALIDITY and commits the others", async () => {
      server.addFolder("INBOX").add(eml("inbox"));
      server.addFolder("Odd", { noUidValidity: true }).add(eml("odd"));
      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures.map((f) => f.itemRef)).toEqual(["Odd"]);
      expect(messages(await manifestOf(result.snapshotId)).map((o) => o.path)).toEqual([
        "mail/INBOX/1.eml",
      ]);
    });
  });

  describe("checkpoints (each one rewrites the whole object list)", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("writes none for folders an incremental run left unchanged", async () => {
      for (let f = 1; f <= 20; f++) {
        const folder = server.addFolder(`Folder ${String(f).padStart(2, "0")}`);
        folder.add(eml(`a${f}`));
        folder.add(eml(`b${f}`));
      }
      await engine().run(context(), protectedObject, {});
      const checkpoints = vi.spyOn(SnapshotWriter.prototype, "checkpoint");

      const result = await engine().run(context(), protectedObject, {});
      expect(result.objectsWritten).toBe(0);
      expect(checkpoints.mock.calls.length).toBeLessThanOrEqual(1);
      expect(messages(await manifestOf(result.snapshotId))).toHaveLength(40);
    });

    it("bounds interval checkpoints of a long first backup by time", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 2000; i++) {
        inbox.add(eml(`m${i}`));
      }
      // 100 ms per message: the whole folder takes 200 s.
      let clock = Date.parse("2026-09-22T10:00:00Z");
      server.onDelivered = () => {
        clock += 100;
      };
      const checkpoints = vi.spyOn(SnapshotWriter.prototype, "checkpoint");
      const result = await engine({
        limits: {
          checkpointEveryMessages: 50,
          checkpointMinIntervalMs: 60_000,
          fetchBatchMessages: 100,
          metaBatchMessages: 1000,
        },
      }).run(context({ now: () => new Date(clock) }), protectedObject, {});
      server.onDelivered = null;
      expect(messages(await manifestOf(result.snapshotId))).toHaveLength(2000);
      // At most one per minute plus the one after the folder (before: one per 50 messages).
      expect(checkpoints.mock.calls.length).toBeLessThanOrEqual(4);
      expect(checkpoints.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("checkpoints a first backup of many small folders by time, not once per folder", async () => {
      for (let f = 1; f <= 200; f++) {
        const folder = server.addFolder(`Archiv ${String(f).padStart(3, "0")}`);
        folder.add(eml(`a${f}`));
        folder.add(eml(`b${f}`));
      }
      // 50 ms per message: 200 folders of 2 messages take 20 s, less than one interval.
      let clock = Date.parse("2026-09-22T10:00:00Z");
      server.onDelivered = () => {
        clock += 50;
      };
      const checkpoints = vi.spyOn(SnapshotWriter.prototype, "checkpoint");
      const result = await engine({
        limits: { checkpointEveryMessages: 250, checkpointMinIntervalMs: 60_000 },
      }).run(context({ now: () => new Date(clock) }), protectedObject, {});
      server.onDelivered = null;
      expect(result.failures).toEqual([]);
      expect(messages(await manifestOf(result.snapshotId))).toHaveLength(400);
      expect(checkpoints.mock.calls.length).toBe(0);
    });

    it("still checkpoints after a folder once a minute has passed", async () => {
      for (let f = 1; f <= 30; f++) {
        const folder = server.addFolder(`Archiv ${String(f).padStart(3, "0")}`);
        folder.add(eml(`a${f}`));
        folder.add(eml(`b${f}`));
      }
      // 10 s per message: 20 s per folder, so every third folder may checkpoint.
      let clock = Date.parse("2026-09-22T10:00:00Z");
      server.onDelivered = () => {
        clock += 10_000;
      };
      const checkpoints = vi.spyOn(SnapshotWriter.prototype, "checkpoint");
      await engine({
        maxConnections: 1,
        limits: { checkpointEveryMessages: 250, checkpointMinIntervalMs: 60_000 },
      }).run(context({ now: () => new Date(clock) }), protectedObject, {});
      server.onDelivered = null;
      expect(checkpoints.mock.calls.length).toBe(10);
    });

    it("resumes correctly after a crash that followed skipped checkpoints", async () => {
      for (const name of ["A", "B", "C"]) {
        const folder = server.addFolder(name);
        folder.add(eml(`${name} 1`));
        folder.add(eml(`${name} 2`));
      }
      await engine({ maxConnections: 1 }).run(context(), protectedObject, {});
      const c = server.folder("C");
      for (let i = 3; i <= 7; i++) {
        c.add(eml(`C ${i}`));
      }
      const controller = new AbortController();
      server.onDelivered = (folder, uid) => {
        if (folder === "C" && uid === 5) {
          controller.abort();
        }
      };
      await expect(
        engine({ maxConnections: 1 }).run(
          context({ signal: controller.signal }),
          protectedObject,
          {},
        ),
      ).rejects.toBeInstanceOf(JobAbortedError);
      server.onDelivered = null;
      const saved = cursor.cursor?.imap as { completed: string[] };
      expect(saved.completed).toEqual(["A", "B"]);

      server.stats.sourcesDelivered.length = 0;
      const result = await engine({ maxConnections: 1 }).run(context(), protectedObject, {});
      const manifest = await manifestOf(result.snapshotId);
      const paths = messages(manifest).map((o) => o.path);
      expect(paths).toHaveLength(2 + 2 + 7);
      expect(new Set(paths).size).toBe(paths.length);
      // A and B were not downloaded again; C continues after what the crash had stored.
      expect(server.stats.sourcesDelivered.every((key) => key.startsWith("C:"))).toBe(true);
    });
  });

  it("uses at most two connections per account, and both of them", async () => {
    for (let i = 0; i < 6; i++) {
      const folder = server.addFolder(`Folder${i}`);
      for (let j = 0; j < 3; j++) {
        folder.add(eml(`f${i}-m${j}`));
      }
    }
    const result = await engine().run(context(), protectedObject, {});
    expect(result.objectsWritten).toBe(18);
    expect(server.stats.maxConcurrent).toBe(2);
    expect(server.stats.connects).toBe(2);
    expect(server.stats.open).toBe(0);
  });

  it("honours a lower connection budget", async () => {
    seedMailbox();
    await engine({ maxConnections: 1 }).run(context(), protectedObject, {});
    expect(server.stats.maxConcurrent).toBe(1);
  });

  it("records a folder that cannot be opened and carries its previous contents forward", async () => {
    seedMailbox();
    const first = await engine().run(context(), protectedObject, {});
    const firstManifest = await manifestOf(first.snapshotId);
    server.faults.openFailures.add("Sent");
    server.folder("INBOX").add(eml("after failure"));

    const result = await engine().run(context(), protectedObject, {});
    expect(result.objectsWritten).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ itemRef: "Sent" });
    expect(result.failures[0].reason).toContain("could not be read");
    // The folder failure is explained, not just worded: the server refused the command.
    expect(result.failures[0].cause).toMatchObject({
      code: "imap.command_failed",
      transient: false,
    });

    const manifest = await manifestOf(result.snapshotId);
    const sentBefore = firstManifest.objects.filter((o) => o.metadata?.[META.mailbox] === "Sent");
    const sentAfter = manifest.objects.filter((o) => o.metadata?.[META.mailbox] === "Sent");
    expect(sentAfter).toEqual(sentBefore);
    expect(manifest.objects.some((o) => o.path === "mail/INBOX/4.eml")).toBe(true);
    const state = manifest.state as { imap: { folders: Record<string, { uidValidity: string }> } };
    expect(state.imap.folders.Sent.uidValidity).toBe("1000");
  });

  it("fails the folder once on a download cap instead of one failure per message", async () => {
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 6; i++) {
      inbox.add(eml(`m${i}`));
    }
    server.faults.refuseSource.add("INBOX:2");
    server.faults.refuseSourceCode = "OVERQUOTA";
    const result = await engine().run(context(), protectedObject, {});
    expect(result.failures).toEqual([
      expect.objectContaining({
        itemRef: "INBOX",
        cause: expect.objectContaining({ code: "imap.server_limit", transient: true }),
      }),
    ]);
  });

  describe("a message the server cannot read (Dovecot/Gmail NO for the whole FETCH)", () => {
    it("backs up the rest of the folder and records that one message on a first backup", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 50; i++) {
        inbox.add(eml(`m${i}`));
      }
      server.faults.unreadable.add("INBOX:23");
      const logs: LogRecord[] = [];
      const result = await engine({
        limits: { checkpointEveryMessages: 3, fetchBatchMessages: 4, metaBatchMessages: 20 },
      }).run(context({ logs }), protectedObject, {});

      expect(result.failures).toEqual([
        expect.objectContaining({
          itemRef: "mail/INBOX/23.eml",
          reason: expect.stringContaining("Some messages could not be FETCHed"),
          cause: expect.objectContaining({ code: "imap.command_failed" }),
        }),
      ]);
      const manifest = await manifestOf(result.snapshotId);
      const stored = messages(manifest).map((o) => Number(o.metadata?.[META.uid]));
      expect(stored).toHaveLength(49);
      expect(stored).not.toContain(23);
      // Envelope metadata of the other messages was fetched despite the refused slice.
      expect(messages(manifest).every((o) => o.metadata?.[META.messageId] !== undefined)).toBe(
        true,
      );
      expect(
        logLine(logs, "imap messages whose metadata the server refuses, isolated"),
      ).toMatchObject({ uids: [23], count: 1 });
    });

    it("still backs up new mail of the folder on the next run", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 8; i++) {
        inbox.add(eml(`m${i}`));
      }
      server.faults.unreadable.add("INBOX:3");
      await engine().run(context(), protectedObject, {});
      inbox.add(eml("new 1"));
      inbox.add(eml("new 2"));

      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures.map((f) => f.itemRef)).toEqual(["mail/INBOX/3.eml"]);
      expect(result.objectsWritten).toBe(2);
      const stored = messages(await manifestOf(result.snapshotId)).map((o) =>
        Number(o.metadata?.[META.uid]),
      );
      expect(stored.sort((a, b) => a - b)).toEqual([1, 2, 4, 5, 6, 7, 8, 9, 10]);

      // Readable again (the admin repaired the mail file): the next run takes it.
      server.faults.unreadable.clear();
      const healed = await engine().run(context(), protectedObject, {});
      expect(healed.failures).toEqual([]);
      expect(healed.objectsWritten).toBe(1);
    });

    it("backs up a folder with 60 unreadable messages in a row although the bisection budget runs out", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 300; i++) {
        inbox.add(eml(`m${i}`));
      }
      for (let uid = 101; uid <= 160; uid++) {
        server.faults.unreadable.add(`INBOX:${uid}`);
      }
      const result = await engine({
        limits: {
          checkpointEveryMessages: 50,
          fetchBatchMessages: 20,
          metaBatchMessages: 300,
          metaIsolationCommands: 100,
        },
      }).run(context(), protectedObject, {});

      expect(result.failures.map((failure) => failure.itemRef).sort()).toEqual(
        Array.from({ length: 60 }, (_, i) => `mail/INBOX/${101 + i}.eml`).sort(),
      );
      const stored = messages(await manifestOf(result.snapshotId));
      expect(stored).toHaveLength(240);
    });

    it("does not bisect a metadata FETCH refused for the account's command or bandwidth cap", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 30; i++) {
        inbox.add(eml(`m${i}`));
      }
      server.faults.limitMeta.add("INBOX");
      const result = await engine({ limits: { metaBatchMessages: 30 } }).run(
        context(),
        protectedObject,
        {},
      );
      expect(result.failures).toEqual([
        expect.objectContaining({
          itemRef: "INBOX",
          cause: expect.objectContaining({ code: "imap.server_limit", transient: true }),
        }),
      ]);
      // One FETCH per attempt of the folder (it is tried twice), no bisection.
      expect(server.stats.metaFetches).toBe(2);
    });

    it("fails the folder as before when the server refuses every metadata FETCH", async () => {
      const inbox = server.addFolder("INBOX");
      for (let i = 1; i <= 30; i++) {
        inbox.add(eml(`m${i}`));
      }
      server.faults.refuseMeta.add("INBOX");
      const result = await engine({
        limits: { metaBatchMessages: 30, metaIsolationCommands: 8 },
      }).run(context(), protectedObject, {});
      expect(result.failures.map((f) => f.itemRef)).toEqual(["INBOX"]);
    });
  });

  it("does not count a message deleted during the run as a failure", async () => {
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 6; i++) {
      inbox.add(eml(`m${i}`));
    }
    // The user deletes message 3 while the first batch (1-4) is being fetched.
    server.onDelivered = (_folder, uid) => {
      if (uid === 1) {
        inbox.delete(3);
      }
    };
    const result = await engine().run(context(), protectedObject, {});
    server.onDelivered = null;
    expect(result.objectsWritten).toBe(5);
    expect(result.failures).toEqual([]);
  });

  it("classifies giving up after too many dropped connections as a lost connection", async () => {
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 6; i++) {
      inbox.add(eml(`m${i}`));
      server.faults.dropOnDeliver.add(`INBOX:${i}`);
    }
    const failure = await engine({ limits: { maxReconnects: 2, fetchBatchMessages: 4 } })
      .run(context(), protectedObject, {})
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(classifyFailure(failure)).toMatchObject({
      code: "imap.connection_lost",
      transient: true,
    });
  });

  it("re-opens a dropped connection, fetches the rest one by one and records omitted messages", async () => {
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 6; i++) {
      inbox.add(eml(`m${i}`));
    }
    server.faults.dropOnDeliver.add("INBOX:3");
    server.faults.omit.add("INBOX:5");

    const ctx = context();
    const result = await engine().run(ctx, protectedObject, {});
    expect(result.objectsWritten).toBe(5);
    expect(result.failures).toEqual([
      {
        itemRef: "mail/INBOX/5.eml",
        reason: "message not returned by the server",
        // Classified, so the operator reads why instead of "cause not identified".
        cause: expect.objectContaining({ code: "imap.message_missing", transient: true }),
      },
    ]);
    expect(server.stats.connects).toBe(2);

    const manifest = await manifestOf(result.snapshotId);
    expect(
      messages(manifest)
        .map((o) => o.path)
        .sort(),
    ).toEqual([
      "mail/INBOX/1.eml",
      "mail/INBOX/2.eml",
      "mail/INBOX/3.eml",
      "mail/INBOX/4.eml",
      "mail/INBOX/6.eml",
    ]);
    for (const object of messages(manifest)) {
      const original = inbox.messages.get(Number(object.metadata?.[META.uid]));
      expect(await readBack(ctx, object)).toEqual(original?.source);
    }
    expect(ctx.progressSink).toBeDefined();

    // The omitted message is picked up as soon as the server returns it.
    server.faults.omit.clear();
    server.stats.sourcesDelivered.length = 0;
    const logs: LogRecord[] = [];
    const next = await engine().run(context({ logs }), protectedObject, {});
    expect(next.objectsWritten).toBe(1);
    expect(server.stats.sourcesDelivered).toEqual(["INBOX:5"]);
    expect(next.failures).toEqual([]);
    // Below the previous UIDNEXT, so it is reported as a retry rather than new mail.
    expect(logLine(logs, "imap folder planned", "INBOX")).toMatchObject({
      mode: "incremental",
      arrived: 0,
      retried: 1,
      carried: 5,
    });
  });

  it("checkpoints on cancellation and resumes without downloading what it already stored", async () => {
    const inbox = server.addFolder("INBOX");
    for (let i = 1; i <= 8; i++) {
      inbox.add(eml(`m${i}`, "x".repeat(100 * i)));
    }
    server.addFolder("Archive").add(eml("archived"));

    const controller = new AbortController();
    let delivered = 0;
    server.onDelivered = () => {
      delivered++;
      if (delivered === 5) {
        controller.abort();
      }
    };
    const firstAttempt = context({ signal: controller.signal });
    await expect(
      engine({ maxConnections: 1 }).run(firstAttempt, protectedObject, {}),
    ).rejects.toBeInstanceOf(JobAbortedError);

    const saved = cursor.cursor;
    expect(saved?.snapshot).toBeDefined();
    const imapCursor = saved?.imap as { completed: string[]; active: Record<string, unknown> };
    expect(imapCursor.completed).toEqual([]);
    expect(imapCursor.active.INBOX).toMatchObject({ uidValidity: "1000" });
    expect(await snapshots.latestCompleted(protectedObject.id)).toBeNull();
    // Five messages were stored before the abort; the sixth left the server but never reached the writer.
    expect(imapCursor.active.INBOX).toMatchObject({ lastUid: 5 });
    expect(server.stats.sourcesDelivered).toHaveLength(6);

    server.onDelivered = null;
    server.stats.sourcesDelivered.length = 0;
    const ctx = context();
    const result = await engine({ maxConnections: 1 }).run(ctx, protectedObject, {});
    expect(result.sequence).toBe(1);
    expect(result.snapshotId).toBe(saved?.snapshot?.snapshotId);
    expect(result.failures).toEqual([]);
    expect(result.objectsWritten).toBe(4);
    // Only what the checkpoint had not covered is fetched again.
    expect(server.stats.sourcesDelivered).toEqual(["INBOX:6", "INBOX:7", "INBOX:8", "Archive:1"]);

    const manifest = await manifestOf(result.snapshotId);
    expect(messages(manifest)).toHaveLength(9);
    for (const object of messages(manifest)) {
      const folder = server.folder(object.metadata?.[META.mailbox] as string);
      const original = folder.messages.get(Number(object.metadata?.[META.uid]));
      expect(await readBack(ctx, object)).toEqual(original?.source);
    }
    expect(cursor.cursor).toBeNull();
  });

  describe("a resumed attempt after a folder was renamed or deleted in between", () => {
    /** Attempt 1 completes INBOX and Projects, then is cancelled inside Zeta after a checkpoint. */
    async function interruptedInZeta(): Promise<void> {
      server.addFolder("INBOX").add(eml("inbox"));
      const projects = server.addFolder("Projects");
      for (let i = 1; i <= 3; i++) {
        projects.add(eml(`project ${i}`));
      }
      const zeta = server.addFolder("Zeta");
      for (let i = 1; i <= 6; i++) {
        zeta.add(eml(`zeta ${i}`));
      }
      const controller = new AbortController();
      server.onDelivered = (folder, uid) => {
        if (folder === "Zeta" && uid === 4) {
          controller.abort();
        }
      };
      await expect(
        engine({ maxConnections: 1 }).run(
          context({ signal: controller.signal }),
          protectedObject,
          {},
        ),
      ).rejects.toBeInstanceOf(JobAbortedError);
      server.onDelivered = null;
      const saved = cursor.cursor?.imap as { completed: string[]; active: Record<string, unknown> };
      expect(saved.completed).toEqual(["INBOX", "Projects"]);
      expect(Object.keys(saved.active)).toEqual(["Zeta"]);
    }

    function rename(from: string, to: string): void {
      const old = server.folder(from);
      const renamed = server.addFolder(to);
      for (const uid of old.uids()) {
        const message = old.messages.get(uid);
        if (message) {
          renamed.add(message.source, { messageId: message.messageId });
        }
      }
      server.folders.delete(from);
    }

    it("keeps only the new name of a folder the earlier attempt had completed", async () => {
      await interruptedInZeta();
      rename("Projects", "Projects-2024");

      const result = await engine({ maxConnections: 1 }).run(context(), protectedObject, {});
      const manifest = await manifestOf(result.snapshotId);
      const mailboxes = manifest.objects.map((o) => o.metadata?.[META.mailbox]);
      expect(mailboxes).not.toContain("Projects");
      expect(
        messages(manifest).filter((o) => o.metadata?.[META.mailbox] === "Projects-2024"),
      ).toHaveLength(3);
      expect(messages(manifest)).toHaveLength(1 + 3 + 6);
      const state = manifest.state as { imap: { folders: Record<string, unknown> } };
      expect(Object.keys(state.imap.folders).sort()).toEqual(["INBOX", "Projects-2024", "Zeta"]);
    });

    it("drops the half-done folder the earlier attempt was in when it is gone", async () => {
      await interruptedInZeta();
      server.folders.delete("Zeta");

      const result = await engine({ maxConnections: 1 }).run(context(), protectedObject, {});
      const manifest = await manifestOf(result.snapshotId);
      expect(manifest.objects.some((o) => o.metadata?.[META.mailbox] === "Zeta")).toBe(false);
      expect(messages(manifest)).toHaveLength(4);
      const state = manifest.state as { imap: { folders: Record<string, unknown> } };
      expect(state.imap.folders.Zeta).toBeUndefined();
    });
  });

  it("refuses an account without transport security", async () => {
    seedMailbox();
    const insecure = engine({ resolveAccount: async () => ({ ...account, security: "none" }) });
    await expect(insecure.run(context(), protectedObject, {})).rejects.toBeInstanceOf(
      ImapConfigError,
    );
    expect(server.stats.connects).toBe(0);
    expect(snapshots.rows.size).toBe(0);
  });

  it("allows cleartext only when explicitly enabled", async () => {
    seedMailbox();
    const dev = engine({
      resolveAccount: async () => ({ ...account, security: "none" }),
      allowInsecure: true,
    });
    const result = await dev.run(context(), protectedObject, {});
    expect(result.objectsWritten).toBe(5);
  });

  it("fails on rejected credentials without leaving a snapshot behind", async () => {
    seedMailbox();
    server.faults.rejectAuth = true;
    await expect(engine().run(context(), protectedObject, {})).rejects.toBeInstanceOf(
      ImapAuthError,
    );
    expect(snapshots.rows.size).toBe(0);
    expect(cursor.cursor).toBeNull();
  });

  describe("probeLogin", () => {
    it("logs in and out without opening a folder", async () => {
      seedMailbox();
      await engine().probeLogin(context(), protectedObject);
      expect(server.stats.connects).toBe(1);
      expect(snapshots.rows.size).toBe(0);
    });

    it("throws ImapAuthError for a refused login, classified imap.auth_failed", async () => {
      server.faults.rejectAuth = true;
      const error = await engine()
        .probeLogin(context(), protectedObject)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ImapAuthError);
      expect(classifyFailure(error).code).toBe("imap.auth_failed");
    });

    it("keeps the transport rule and the missing-secret rule of a backup run", async () => {
      const insecure = engine({ resolveAccount: async () => ({ ...account, security: "none" }) });
      await expect(insecure.probeLogin(context(), protectedObject)).rejects.toBeInstanceOf(
        ImapConfigError,
      );
      expect(server.stats.connects).toBe(0);
      await expect(
        engine().probeLogin(context({ secrets: {} }), protectedObject),
      ).rejects.toBeInstanceOf(ImapConfigError);
    });
  });

  it("fails when the secret is missing", async () => {
    seedMailbox();
    await expect(
      engine().run(context({ secrets: {} }), protectedObject, {}),
    ).rejects.toBeInstanceOf(ImapConfigError);
  });

  it("connects OAuth2 accounts with a freshly refreshed access token", async () => {
    seedMailbox();
    const requests: Array<{ url: string; body: string }> = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, body: String(init.body) });
      return new Response(
        JSON.stringify({
          access_token: "access-token-1",
          expires_in: 3600,
          refresh_token: "refresh-token-2",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const rotated: Array<{ secretId: string; json: string }> = [];
    const oauthEngine = engine({
      resolveAccount: async () => ({ ...account, authKind: "oauth2", secretId: "secret-oauth" }),
      fetch: fetchImpl,
      onRefreshTokenRotated: async (secretId, json) => {
        rotated.push({ secretId, json });
      },
    });
    const secret = JSON.stringify({
      provider: "microsoft",
      tenantId: "contoso.onmicrosoft.com",
      clientId: "client-id",
      refreshToken: "refresh-token-1",
    });
    const result = await oauthEngine.run(
      context({ secrets: { "secret-oauth": secret } }),
      protectedObject,
      {},
    );
    expect(result.objectsWritten).toBe(5);
    // One token exchange serves both sessions.
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token",
    );
    expect(requests[0].body).toContain("grant_type=refresh_token");
    expect(server.logins.every((login) => login.kind === "oauth2")).toBe(true);
    expect(server.logins[0].accessToken).toBe("access-token-1");
    expect(rotated).toHaveLength(1);
    expect(rotated[0].secretId).toBe("secret-oauth");
    expect(JSON.parse(rotated[0].json)).toEqual({
      provider: "microsoft",
      tenantId: "contoso.onmicrosoft.com",
      clientId: "client-id",
      refreshToken: "refresh-token-2",
    });
  });

  it("logs in with the Dovecot master*mailbox separator for master-user mode", async () => {
    // docs/IMAP.md master_user, separator style: the login is the combined
    // "master*mailbox" string, authenticated with the master account's own
    // password; no authzid is carried for this style.
    seedMailbox();
    const masterUserEngine = engine({
      resolveAccount: async () => ({
        ...account,
        username: "master*alice@example.test",
        secretId: "secret-master",
      }),
    });
    const result = await masterUserEngine.run(
      context({ secrets: { "secret-master": "master-password-not-real" } }),
      protectedObject,
      {},
    );
    expect(result.objectsWritten).toBe(5);
    // The engine opens up to two connections per account (metadata and fetch
    // phases), each with the same login.
    expect(server.logins.length).toBeGreaterThan(0);
    for (const login of server.logins) {
      expect(login).toEqual({
        user: "master*alice@example.test",
        kind: "password",
        password: "master-password-not-real",
      });
    }
  });

  it("logs in with the master account plus a SASL authzid for master-user mode", async () => {
    // docs/IMAP.md master_user, SASL authzid style: the login stays the master
    // account, the target mailbox is carried in authzid.
    seedMailbox();
    const masterUserEngine = engine({
      resolveAccount: async () => ({
        ...account,
        username: "master",
        authzid: "alice@example.test",
        secretId: "secret-master",
      }),
    });
    const result = await masterUserEngine.run(
      context({ secrets: { "secret-master": "master-password-not-real" } }),
      protectedObject,
      {},
    );
    expect(result.objectsWritten).toBe(5);
    expect(server.logins.length).toBeGreaterThan(0);
    for (const login of server.logins) {
      expect(login).toEqual({
        user: "master",
        kind: "password",
        password: "master-password-not-real",
        authzid: "alice@example.test",
      });
    }
  });

  describe("Gmail (labels are folders; every message is in All Mail once)", () => {
    const ALL = "[Gmail]/All Mail";

    /** 10 messages in All Mail: 4 also in INBOX, 3 labelled Projekte; one in Spam, one in Trash. */
    function seedGmail(options: { allMailHidden?: boolean } = {}) {
      server.setupGmail({ labels: ["Projekte"], ...options });
      const labelsOf = (i: number): string[] => [
        ...(i < 4 ? ["\\Inbox"] : []),
        ...(i >= 4 && i < 7 ? ["Projekte"] : []),
        ...(i === 9 ? ["\\Sent"] : []),
      ];
      const mails = Array.from({ length: 10 }, (_, i) =>
        server.addGmailMessage(eml(`gmail ${i}`), labelsOf(i)),
      );
      server.folder("[Gmail]/Spam").add(eml("spam"));
      server.folder("[Gmail]/Trash").add(eml("trash"));
      return mails;
    }

    it("downloads each message once from All Mail, Spam and Trash and records the labels", async () => {
      seedGmail();
      // What this test guards against: INBOX (4), Projekte (3) and Sent Mail (1) read again.
      expect(server.folder("INBOX").messages.size).toBe(4);
      expect(server.folder("Projekte").messages.size).toBe(3);
      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures).toEqual([]);

      expect(server.stats.sourcesDelivered).toHaveLength(12);
      expect(new Set(server.stats.sourcesDelivered.map((key) => key.split(":")[0]))).toEqual(
        new Set([ALL, "[Gmail]/Spam", "[Gmail]/Trash"]),
      );
      const manifest = await manifestOf(result.snapshotId);
      const stored = messages(manifest);
      const allMail = stored.filter((o) => o.metadata?.[META.mailbox] === ALL);
      expect(allMail).toHaveLength(10);

      const labels = allMail.map((o) => o.metadata?.[META.gmailLabels]).sort();
      expect(labels).toEqual([
        '["Projekte"]',
        '["Projekte"]',
        '["Projekte"]',
        '["\\\\Inbox"]',
        '["\\\\Inbox"]',
        '["\\\\Inbox"]',
        '["\\\\Inbox"]',
        '["\\\\Sent"]',
        "[]",
        "[]",
      ]);
      const state = manifest.state as {
        imap: { layout?: string; folders: Record<string, unknown> };
      };
      expect(state.imap.layout).toBe("gmail");
      expect(state.imap.folders.INBOX).toMatchObject({ messages: 4 });
    });

    it("keeps every label folder's messages, with the All Mail copy's content and no download", async () => {
      const mails = seedGmail();
      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures).toEqual([]);
      const manifest = await manifestOf(result.snapshotId);
      const stored = messages(manifest);
      // 10 in All Mail, 1 Spam, 1 Trash, and the label folders: INBOX 4, Projekte 3, Sent 1.
      expect(stored).toHaveLength(20);
      const inFolder = (mailbox: string) =>
        stored.filter((o) => o.metadata?.[META.mailbox] === mailbox);
      expect(inFolder("INBOX")).toHaveLength(4);
      expect(inFolder("Projekte")).toHaveLength(3);
      expect(inFolder("[Gmail]/Sent Mail")).toHaveLength(1);

      const first = mails[0] as NonNullable<(typeof mails)[number]>;
      const inAll = must(
        stored.find((o) => o.path === `mail/[Gmail]/All Mail/${first.copies.get(ALL)}.eml`),
      );
      const inInbox = must(
        stored.find((o) => o.path === `mail/INBOX/${first.copies.get("INBOX")}.eml`),
      );
      expect(inInbox.sha256).toBe(inAll.sha256);
      expect(inInbox.chunks).toEqual(inAll.chunks);
      expect(inInbox.metadata).toMatchObject({
        [META.mailbox]: "INBOX",
        [META.uid]: String(first.copies.get("INBOX")),
        [META.gmailMessageId]: first.id,
        [META.messageId]: inAll.metadata?.[META.messageId],
      });
      expect(inInbox.metadata?.[META.gmailLabels]).toBeUndefined();
      expect(inAll.metadata?.[META.gmailMessageId]).toBe(first.id);
      const sent = stored.find((o) => o.metadata?.[META.mailbox] === "[Gmail]/Sent Mail");
      expect(sent?.metadata?.[META.specialUse]).toBe("\\Sent");
      expect(Buffer.compare(await readBack(context(), inInbox), first.source)).toBe(0);
    });

    it("restores the INBOX of a Gmail backup on its own, with its messages", async () => {
      seedGmail();
      const backup = await engine().run(context(), protectedObject, {});
      const target = new MemoryRestoreTarget("/");
      const restore = new ImapRestoreEngine({ imap: async () => target });
      const report = await restore.run(context(), {
        restoreJobId: "restore-inbox",
        snapshotId: backup.snapshotId,
        protectedObject,
        selection: { folderPaths: ["mail/INBOX"] },
        target: { type: "original", ref: null },
        mode: "skip",
        actor: { userId: null, impersonated: false, reason: null },
      });
      expect(report.failures).toEqual([]);
      expect(target.mailbox("INBOX")).toHaveLength(4);
    });

    it("reads a label folder's message itself when All Mail could not deliver it", async () => {
      const mails = seedGmail();
      const first = mails[0] as NonNullable<(typeof mails)[number]>;
      server.faults.omitSource.add(`${ALL}:${first.copies.get(ALL)}`);
      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures.map((failure) => failure.itemRef)).toEqual([
        `mail/[Gmail]/All Mail/${first.copies.get(ALL)}.eml`,
      ]);
      expect(server.stats.sourcesDelivered).toContain(`INBOX:${first.copies.get("INBOX")}`);
      expect(server.stats.sourcesDelivered).toHaveLength(12);
      const manifest = await manifestOf(result.snapshotId);
      expect(messages(manifest).filter((o) => o.metadata?.[META.mailbox] === "INBOX")).toHaveLength(
        4,
      );
    });

    it("updates the labels of a carried-forward message without downloading it again", async () => {
      const mails = seedGmail();
      await engine().run(context(), protectedObject, {});
      server.stats.sourcesDelivered.length = 0;

      server.setGmailLabels(mails[0] as never, ["Projekte"]);
      const second = await engine().run(context(), protectedObject, {});
      expect(second.failures).toEqual([]);
      expect(server.stats.sourcesDelivered).toEqual([]);
      const manifest = await manifestOf(second.snapshotId);
      const uid = mails[0]?.copies.get(ALL);
      const object = manifest.objects.find((o) => o.path === `mail/[Gmail]/All Mail/${uid}.eml`);
      expect(object?.metadata?.[META.gmailLabels]).toBe('["Projekte"]');
      const inFolder = (mailbox: string) =>
        messages(manifest).filter((o) => o.metadata?.[META.mailbox] === mailbox);
      expect(inFolder("INBOX")).toHaveLength(3);
      expect(inFolder("Projekte")).toHaveLength(4);
      expect(messages(manifest)).toHaveLength(20);
    });

    it("keeps the per-label messages of a restore point taken before and adds the labels", async () => {
      seedGmail();
      // An earlier backup without the Gmail layout: every folder with its own messages.
      server.gmailExtensions = false;
      const before = await engine().run(context(), protectedObject, {});
      expect(messages(await manifestOf(before.snapshotId))).toHaveLength(20);
      server.gmailExtensions = true;
      server.stats.sourcesDelivered.length = 0;

      const after = await engine().run(context(), protectedObject, {});
      expect(after.failures).toEqual([]);
      expect(server.stats.sourcesDelivered).toEqual([]);
      const manifest = await manifestOf(after.snapshotId);
      expect(messages(manifest)).toHaveLength(20);
      expect(messages(manifest).filter((o) => o.metadata?.[META.mailbox] === "INBOX")).toHaveLength(
        4,
      );
      expect(
        messages(manifest).filter(
          (o) =>
            o.metadata?.[META.mailbox] === ALL &&
            o.metadata?.[META.gmailLabels] &&
            o.metadata?.[META.gmailMessageId],
        ),
      ).toHaveLength(10);
    });

    it("warns that every label is a copy when All Mail is hidden from IMAP", async () => {
      seedGmail({ allMailHidden: true });
      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures).toEqual([
        expect.objectContaining({
          itemRef: "[Gmail]/All Mail",
          cause: expect.objectContaining({ code: "imap.gmail_all_mail_hidden" }),
        }),
      ]);
      // Folder by folder: nothing is left out.
      const manifest = await manifestOf(result.snapshotId);
      expect(messages(manifest)).toHaveLength(10);
      expect((manifest.state as { imap: { layout?: string } }).imap.layout).toBeUndefined();
    });

    it("leaves a server without X-GM-EXT-1 as it was, even with an \\All folder", async () => {
      seedGmail();
      server.gmailExtensions = false;
      const result = await engine().run(context(), protectedObject, {});
      expect(result.failures).toEqual([]);
      expect(server.stats.listFlagsWithLabels).toBe(0);
      expect(messages(await manifestOf(result.snapshotId))).toHaveLength(20);
    });
  });

  it("drops the messages of a folder that vanished from the server", async () => {
    seedMailbox();
    await engine().run(context(), protectedObject, {});
    server.folders.delete("Sent");
    const result = await engine().run(context(), protectedObject, {});
    const manifest = await manifestOf(result.snapshotId);
    expect(manifest.objects.some((o) => o.metadata?.[META.mailbox] === "Sent")).toBe(false);
    const state = manifest.state as { imap: { folders: Record<string, unknown> } };
    expect(state.imap.folders.Sent).toBeUndefined();
  });

  it("records mail envelope metadata: subject, from, to/cc with counts, attachments and protection", async () => {
    const inbox = server.addFolder("INBOX");
    const many = Array.from({ length: 25 }, (_, i) => `Recipient ${i} <r${i}@example.test>`);
    inbox.add(eml("Quarterly numbers"), {
      envelope: {
        subject: "Quarterly numbers",
        from: "Alice Example <alice@example.test>",
        to: many,
        cc: ["Carol <carol@example.test>"],
        hasAttachments: true,
        sentDateTime: new Date("2026-09-20T08:00:00Z"),
        protection: "smime-encrypted",
      },
    });
    const result = await engine().run(context(), protectedObject, {});
    expect(result.failures).toEqual([]);

    const manifest = await manifestOf(result.snapshotId);
    const object = manifest.objects.find((o) => o.path === "mail/INBOX/1.eml");
    expect(object?.metadata?.[META.subject]).toBe("Quarterly numbers");
    expect(object?.metadata?.[META.from]).toBe("Alice Example <alice@example.test>");
    // Capped at 20 formatted entries; the count carries the full total.
    expect(object?.metadata?.[META.to]).toBe(many.slice(0, 20).join(", "));
    expect(object?.metadata?.[META.toCount]).toBe("25");
    expect(object?.metadata?.[META.cc]).toBe("Carol <carol@example.test>");
    expect(object?.metadata?.[META.ccCount]).toBe("1");
    expect(object?.metadata?.[META.hasAttachments]).toBe("true");
    expect(object?.metadata?.[META.sentDateTime]).toBe("2026-09-20T08:00:00.000Z");
    expect(object?.metadata?.[META.protection]).toBe("smime-encrypted");
  });

  it("backs up a message whose envelope could not be read with the old fields only, never as a failure", async () => {
    const inbox = server.addFolder("INBOX");
    const added = inbox.add(eml("hello"));
    server.faults.envelopeFailures.add(`INBOX:${added.uid}`);

    const result = await engine().run(context(), protectedObject, {});
    expect(result.failures).toEqual([]);

    const manifest = await manifestOf(result.snapshotId);
    const object = manifest.objects.find((o) => o.path === "mail/INBOX/1.eml");
    expect(object?.metadata?.[META.subject]).toBeUndefined();
    expect(object?.metadata?.[META.flags]).toBeDefined();
    expect(object?.metadata?.[META.messageId]).toBe(added.messageId);
  });

  it("backfills envelope metadata of carried-forward messages on the next run without downloading bodies", async () => {
    const inbox = server.addFolder("INBOX");
    const added = inbox.add(eml("legacy mail"), {
      envelope: { subject: "legacy mail", from: "Alice <alice@example.test>" },
    });
    const key = `INBOX:${added.uid}`;
    // Simulates a mailbox backed up before this metadata existed: no envelope was ever recorded.
    server.faults.envelopeFailures.add(key);
    const first = await engine().run(context(), protectedObject, {});
    const firstManifest = await manifestOf(first.snapshotId);
    const before = firstManifest.objects.find((o) => o.path === "mail/INBOX/1.eml");
    expect(before?.metadata?.[META.subject]).toBeUndefined();

    server.faults.envelopeFailures.delete(key);
    server.stats.sourcesDelivered.length = 0;
    server.stats.metaFetches = 0;
    const second = await engine().run(context(), protectedObject, {});
    expect(second.objectsWritten).toBe(0);
    // No body FETCH happened: only a metadata-only FETCH (no new chunks).
    expect(server.stats.sourcesDelivered).toEqual([]);
    expect(server.stats.metaFetches).toBeGreaterThan(0);

    const manifest = await manifestOf(second.snapshotId);
    const after = manifest.objects.find((o) => o.path === "mail/INBOX/1.eml");
    expect(after?.metadata?.[META.subject]).toBe("legacy mail");
    expect(after?.metadata?.[META.from]).toBe("Alice <alice@example.test>");
    expect(after?.sha256).toBe(before?.sha256);
    expect(after?.chunks).toEqual(before?.chunks);

    // Older restore points are immutable: the first snapshot keeps its old metadata.
    const firstAgain = await manifestOf(first.snapshotId);
    expect(
      firstAgain.objects.find((o) => o.path === "mail/INBOX/1.eml")?.metadata?.[META.subject],
    ).toBeUndefined();
  });

  it("restores what it backed up: bytes, mailbox, flags and internal date survive the round trip", async () => {
    const inboxDate = new Date("2025-11-03T08:15:00Z");
    const inbox = server.addFolder("INBOX", { delimiter: "." });
    const inboxMail = inbox.add(`Message-ID: <r1@test>\r\n${eml("restore me")}`, {
      messageId: "<r1@test>",
      flags: ["\\Seen", "\\Flagged", "$Label1"],
      internalDate: inboxDate,
    });
    server.addFolder("Clients", { delimiter: ".", selectable: false });
    // A "/" inside a name is legal on "."-delimited servers; only the recorded mailbox keeps it intact.
    const nested = server.addFolder("Clients.A/B Corp", { delimiter: "." });
    const nestedMail = nested.add(`Message-ID: <r2@test>\r\n${eml("nested", "n".repeat(70_000))}`, {
      messageId: "<r2@test>",
      flags: ["\\Answered"],
    });
    const backup = await engine().run(context(), protectedObject, {});
    expect(backup.failures).toEqual([]);
    const manifest = await manifestOf(backup.snapshotId);
    expect(
      messages(manifest)
        .map((object) => object.path)
        .sort(),
    ).toEqual(["mail/Clients/A%2FB Corp/1.eml", "mail/INBOX/1.eml"]);

    const target = new MemoryRestoreTarget(".");
    const restore = new ImapRestoreEngine({ imap: async () => target });
    const request: RestoreRequest = {
      restoreJobId: "restore-1",
      snapshotId: backup.snapshotId,
      protectedObject,
      selection: { all: true },
      target: { type: "original", ref: null },
      mode: "skip",
      actor: { userId: null, impersonated: false, reason: null },
    };
    const report = await restore.run(context(), request);
    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    expect(target.mailboxNames()).toEqual(["Clients.A/B Corp", "INBOX"]);

    const [restoredInbox] = target.mailbox("INBOX");
    expect(restoredInbox.content).toEqual(inboxMail.source);
    expect([...restoredInbox.flags].sort()).toEqual(["$Label1", "\\Flagged", "\\Seen"]);
    expect(restoredInbox.internalDate).toEqual(inboxDate);

    const [restoredNested] = target.mailbox("Clients.A/B Corp");
    expect(restoredNested.content).toEqual(nestedMail.source);
    expect(restoredNested.flags).toEqual(["\\Answered"]);
    expect(restoredNested.internalDate).toEqual(nestedMail.internalDate);

    // The recorded Message-ID lets a second restore recognise what is already there.
    const again = await restore.run(context(), { ...request, restoreJobId: "restore-2" });
    expect(again.restored).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it("per-mailbox credentials: two mailboxes back up and restore with their own, different passwords", async () => {
    // Two separate mailboxes of the same hoster (`SourceConfig.imapAuthMode:
    // "per_mailbox"`, docs/IMAP.md), each with its own sealed password and,
    // like real separate mailboxes, its own IMAP account and its own mail: a
    // fake server per mailbox, routed to by username, stands in for that
    // (`FakeImapServer` itself has no notion of separate users; see the class
    // doc comment). That is what proves isolation, not just credentials: a
    // regression that fed mailbox A's manifest into mailbox B's restore, or
    // vice versa, fails this test on content, not just on login.
    const serverA = new FakeImapServer();
    const serverB = new FakeImapServer();
    serverA.addFolder("INBOX").add(eml("hello a", "content only a has ever seen"));
    serverB.addFolder("INBOX").add(eml("hello b", "content only b has ever seen"));
    const router: ImapConnector = {
      connect: (account, credential, options) =>
        (account.username === "a@hoster.test" ? serverA : serverB).connect(
          account,
          credential,
          options,
        ),
    };
    const objectA: ProtectedObjectRef = {
      ...protectedObject,
      id: "po-imap-a",
      externalId: "a@hoster.test",
    };
    const objectB: ProtectedObjectRef = {
      ...protectedObject,
      id: "po-imap-b",
      externalId: "b@hoster.test",
    };
    const accountOf = (object: ProtectedObjectRef): ImapAccountConfig => ({
      host: "imap.hoster.test",
      port: 993,
      security: "tls",
      username: object.externalId,
      authKind: "password",
      secretId: `secret-${object.externalId}`,
    });
    const perMailboxEngine = engine({
      resolveAccount: async (_ctx, object) => accountOf(object),
      connector: router,
    });
    const ctx = context({
      secrets: {
        "secret-a@hoster.test": "password-for-a",
        "secret-b@hoster.test": "password-for-b",
      },
    });

    const backupA = await perMailboxEngine.run(ctx, objectA, {});
    const backupB = await perMailboxEngine.run({ ...ctx, jobId: "job-b" }, objectB, {});
    expect(backupA.failures).toEqual([]);
    expect(backupB.failures).toEqual([]);
    expect(backupA.objectsWritten).toBeGreaterThan(0);
    expect(backupB.objectsWritten).toBeGreaterThan(0);

    // Each connection carried its own mailbox's password, never the other's.
    expect(serverA.logins).toEqual([
      expect.objectContaining({ user: "a@hoster.test", password: "password-for-a" }),
    ]);
    expect(serverB.logins).toEqual([
      expect.objectContaining({ user: "b@hoster.test", password: "password-for-b" }),
    ]);

    // Restore both, each into its own target: a per_mailbox backup keeps its
    // mailboxes' data as isolated as their credentials, not just mailbox A's.
    const targetA = new MemoryRestoreTarget(".");
    const targetB = new MemoryRestoreTarget(".");
    const restoreA = new ImapRestoreEngine({ imap: async () => targetA });
    const restoreB = new ImapRestoreEngine({ imap: async () => targetB });
    const reportA = await restoreA.run(ctx, {
      restoreJobId: "restore-a",
      snapshotId: backupA.snapshotId,
      protectedObject: objectA,
      selection: { all: true },
      target: { type: "original", ref: null },
      mode: "skip",
      actor: { userId: null, impersonated: false, reason: null },
    });
    const reportB = await restoreB.run(ctx, {
      restoreJobId: "restore-b",
      snapshotId: backupB.snapshotId,
      protectedObject: objectB,
      selection: { all: true },
      target: { type: "original", ref: null },
      mode: "skip",
      actor: { userId: null, impersonated: false, reason: null },
    });
    expect(reportA.failures).toEqual([]);
    expect(reportB.failures).toEqual([]);
    expect(reportA.restored).toBe(1);
    expect(reportB.restored).toBe(1);
    expect(targetA.mailboxNames()).toEqual(["INBOX"]);
    expect(targetB.mailboxNames()).toEqual(["INBOX"]);

    // Byte-exact, and each mailbox got back only its own content, never the other's.
    const [restoredA] = targetA.mailbox("INBOX");
    const [restoredB] = targetB.mailbox("INBOX");
    const [originalA] = serverA
      .folder("INBOX")
      .uids()
      .map((uid) => serverA.folder("INBOX").messages.get(uid));
    const [originalB] = serverB
      .folder("INBOX")
      .uids()
      .map((uid) => serverB.folder("INBOX").messages.get(uid));
    expect(restoredA.content).toEqual(originalA?.source);
    expect(restoredB.content).toEqual(originalB?.source);
    expect(restoredA.content).not.toEqual(restoredB.content);
  });

  it("per-mailbox credentials: propagates a missing-password rejection as the job's failure cause, verbatim and never as a crash", async () => {
    // The engine itself only has a contract to keep here: whatever
    // `resolveAccount` rejects with becomes the job's failure cause,
    // unmodified and never swallowed into a generic error. The exact wording
    // a real per_mailbox source produces ("has no password set; add one
    // before it can be backed up") is owned and asserted against the real
    // `imapAccountFor` in apps/worker/src/handlers/backup.test.ts ("per_mailbox:
    // fails the object with a clear, non-secret cause when it has no
    // password"), not duplicated here: packages/core never depends on the
    // worker, so this test cannot call that function itself.
    const cause = new Error(
      `IMAP account "${protectedObject.externalId}" on source "Hoster" has no password set; add one before it can be backed up`,
    );
    const noPassword = engine({ resolveAccount: async () => Promise.reject(cause) });
    await expect(noPassword.run(context(), protectedObject, {})).rejects.toBe(cause);
  });
});
