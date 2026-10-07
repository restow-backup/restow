import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Dek } from "../../crypto.js";
import { ChunkReader, JobAbortedError } from "../../engine/chunkstore.js";
import { Keyring } from "../../engine/keyring.js";
import { type LogRecord, createLogger } from "../../engine/logger.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../../engine/memory.js";
import { loadManifest } from "../../engine/snapshot.js";
import type { JobContext, ProtectedObjectRef, RestoreRequest } from "../../engine/types.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { ImapRestoreEngine } from "../../restore/imap.js";
import { LocalStorageBackend } from "../../storage/local.js";
import { ImapBackupEngine, type ImapBackupEngineOptions } from "./engine.js";
import { META, decodeFlags } from "./paths.js";
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
    overrides: { signal?: AbortSignal; secrets?: Record<string, string>; logs?: LogRecord[] } = {},
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
      now: () => new Date("2026-09-22T10:00:00Z"),
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
      limits: { checkpointEveryMessages: 3, fetchBatchMessages: 4, metaBatchMessages: 5 },
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
