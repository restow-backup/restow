import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ImapFlow, ImapFlowOptions } from "imapflow";
import { describe, expect, it } from "vitest";
import type { ImapAccountConfig } from "../backup/imap/types.js";
import { Keyring } from "../engine/keyring.js";
import { createMemoryJobContext } from "../engine/memory.js";
import type { JobContext } from "../engine/types.js";
import { LocalStorageBackend } from "../storage/local.js";
import { ImapFlowRestoreSession, createImapFlowSessionFactory } from "./imap-flow.js";
import { ImapRestoreError } from "./imap.js";

interface Box {
  path: string;
  delimiter: string;
  specialUse?: string;
}

/** Just enough of imapflow for the restore session: records calls, answers from memory. */
class FakeImapFlow extends EventEmitter {
  readonly calls: string[] = [];
  secureConnection = true;
  connectError: Error | null = null;
  createError: Error | null = null;
  appendResult: { uid?: number } | false = { uid: 41 };
  logoutFails = false;
  closed = false;
  locks = 0;
  /** Empty by default: a server advertising neither AUTH=LOGIN nor AUTH=PLAIN. */
  capabilities = new Map<string, boolean>();

  constructor(
    readonly options: ImapFlowOptions,
    private readonly boxes: Box[],
    private readonly prefix = "",
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.connectError) {
      throw this.connectError;
    }
  }

  async list(): Promise<Box[]> {
    return this.boxes;
  }

  async mailboxCreate(path: string[]): Promise<{ path: string; created: boolean }> {
    this.calls.push(`CREATE ${path.join("|")}`);
    if (this.createError) {
      throw this.createError;
    }
    return { path: `${this.prefix}${path.join(".")}`, created: true };
  }

  async getMailboxLock(path: string): Promise<{ path: string; release(): void }> {
    this.locks++;
    this.calls.push(`LOCK ${path}`);
    return { path, release: () => this.locks-- };
  }

  async search(query: { header: Record<string, string> }): Promise<number[]> {
    this.calls.push(`SEARCH ${query.header["message-id"]}`);
    return [7, 9];
  }

  async append(
    path: string,
    content: Buffer,
    flags: string[],
    date?: Date,
  ): Promise<{ uid?: number } | false> {
    this.calls.push(
      `APPEND ${path} ${flags.join(" ")} ${date?.toISOString() ?? "-"} ${content.length}`,
    );
    return this.appendResult;
  }

  async fetchOne(uid: string): Promise<{ source: Buffer } | false> {
    this.calls.push(`FETCH ${uid}`);
    return uid === "41" ? { source: Buffer.from("stored bytes") } : false;
  }

  async logout(): Promise<void> {
    if (this.logoutFails) {
      throw new Error("connection already gone");
    }
    this.calls.push("LOGOUT");
  }

  close(): void {
    this.closed = true;
  }
}

function asClient(fake: FakeImapFlow): ImapFlow {
  return fake as unknown as ImapFlow;
}

const namespaced: Box[] = [
  { path: "INBOX", delimiter: ".", specialUse: "\\Inbox" },
  { path: "INBOX.Sent", delimiter: ".", specialUse: "\\Sent" },
  { path: "INBOX.Sent Messages", delimiter: ".", specialUse: "\\Sent" },
];

describe("ImapFlowRestoreSession", () => {
  it("learns the delimiter and special-use mailboxes from LIST", async () => {
    const session = await ImapFlowRestoreSession.open(
      asClient(new FakeImapFlow({} as ImapFlowOptions, namespaced)),
    );
    expect(session.delimiter).toBe(".");
    expect(session.specialUseMailbox("\\sent")).toBe("INBOX.Sent");
    expect(session.specialUseMailbox("\\Inbox")).toBe("INBOX");
    expect(session.specialUseMailbox("\\Trash")).toBeUndefined();
  });

  it("creates missing levels once and keeps the name the server gave them", async () => {
    const fake = new FakeImapFlow({} as ImapFlowOptions, namespaced, "INBOX.");
    const session = await ImapFlowRestoreSession.open(asClient(fake));

    expect(await session.ensureMailbox("Restow 2026-09-22 1430.INBOX")).toBe(
      "INBOX.Restow 2026-09-22 1430.INBOX",
    );
    expect(await session.ensureMailbox("Restow 2026-09-22 1430.INBOX")).toBe(
      "INBOX.Restow 2026-09-22 1430.INBOX",
    );
    expect(await session.ensureMailbox("INBOX.Sent")).toBe("INBOX.Sent");
    expect(fake.calls).toEqual([
      "CREATE Restow 2026-09-22 1430",
      "CREATE Restow 2026-09-22 1430|INBOX",
    ]);

    fake.createError = Object.assign(new Error("Mailbox exists"), {
      serverResponseCode: "ALREADYEXISTS",
    });
    expect(await session.ensureMailbox("Projects")).toBe("Projects");
    fake.createError = new Error("NO [CANNOT] invalid name");
    await expect(session.ensureMailbox("Bad")).rejects.toBeInstanceOf(ImapRestoreError);
  });

  it("searches, appends and fetches under a mailbox lock, and never deletes", async () => {
    const fake = new FakeImapFlow({} as ImapFlowOptions, namespaced);
    const session = await ImapFlowRestoreSession.open(asClient(fake));
    const date = new Date(Date.UTC(2025, 0, 2));

    expect(await session.findByMessageId("INBOX", "<a@b>")).toEqual([7, 9]);
    expect(await session.append("INBOX", Buffer.from("hello"), ["\\Seen"], date)).toEqual({
      uid: 41,
    });
    expect(await session.fetchSha256("INBOX", 41)).toBe(
      createHash("sha256").update("stored bytes").digest("hex"),
    );
    expect(await session.fetchSha256("INBOX", 42)).toBeNull();
    expect(fake.locks).toBe(0);
    expect(fake.calls).toEqual([
      "LOCK INBOX",
      "SEARCH <a@b>",
      `APPEND INBOX \\Seen ${date.toISOString()} 5`,
      "LOCK INBOX",
      "FETCH 41",
      "LOCK INBOX",
      "FETCH 42",
    ]);
    // Defence in depth: the session has no primitive left that could delete,
    // flag \Deleted or expunge a message (ImapFlowClient excludes
    // messageDelete), so no call the session ever issues can be one.
    expect(fake.calls.some((call) => /DELETE|EXPUNGE|\\Deleted/i.test(call))).toBe(false);
    expect("deleteMessages" in session).toBe(false);

    fake.appendResult = false;
    await expect(session.append("INBOX", Buffer.from("x"), [], undefined)).rejects.toThrow(
      /rejected the APPEND/,
    );

    fake.logoutFails = true;
    await session.close();
    expect(fake.closed).toBe(true);
  });
});

describe("createImapFlowSessionFactory", () => {
  const account: ImapAccountConfig = {
    host: "imap.example.org",
    port: 993,
    security: "tls",
    username: "anna@example.org",
    authKind: "password",
    secretId: "secret-1",
  };

  function context(signal = new AbortController().signal): JobContext {
    return createMemoryJobContext({
      tenantId: "11111111-2222-4333-8444-555555555555",
      keys: new Keyring("11111111-2222-4333-8444-555555555555", [
        { version: 1, material: Buffer.alloc(32, 1) },
      ]),
      storage: new LocalStorageBackend("/nonexistent/restow-imap-flow-test"),
      secrets: { "secret-1": "correct horse battery staple" },
      signal,
    });
  }

  const protectedObject = {
    id: "po",
    tenantId: "t",
    sourceId: "s",
    kind: "imap" as const,
    externalId: "anna@example.org",
    displayName: null,
    userId: null,
  };
  const original = { type: "original" as const, ref: null };

  it("connects with the stored password over TLS and closes on cancellation", async () => {
    const created: FakeImapFlow[] = [];
    const controller = new AbortController();
    const factory = createImapFlowSessionFactory({
      resolveAccount: async () => account,
      createClient: (options) => {
        const fake = new FakeImapFlow(options, namespaced);
        created.push(fake);
        return asClient(fake);
      },
    });

    const session = await factory(context(controller.signal), protectedObject, original);

    expect(session.delimiter).toBe(".");
    const fake = created[0] as FakeImapFlow;
    expect(fake.options.host).toBe("imap.example.org");
    expect(fake.options.secure).toBe(true);
    expect((fake.options.auth as { pass?: string }).pass).toBe("correct horse battery staple");
    expect(fake.listenerCount("error")).toBe(1);
    controller.abort();
    expect(fake.closed).toBe(true);
  });

  it("refuses cleartext accounts unless allowed and unencrypted connections always", async () => {
    const fake = new FakeImapFlow({} as ImapFlowOptions, namespaced);
    const factory = (allowInsecure: boolean, config: ImapAccountConfig) =>
      createImapFlowSessionFactory({
        resolveAccount: async () => config,
        allowInsecure,
        createClient: () => asClient(fake),
      });

    await expect(
      factory(false, { ...account, security: "none" })(context(), protectedObject, original),
    ).rejects.toThrow(/TLS is required/);

    fake.secureConnection = false;
    await expect(factory(false, account)(context(), protectedObject, original)).rejects.toThrow(
      /not encrypted/,
    );
    expect(fake.closed).toBe(true);
  });

  it("says when authentication failed", async () => {
    const fake = new FakeImapFlow({} as ImapFlowOptions, namespaced);
    fake.connectError = Object.assign(new Error("Command failed"), { authenticationFailed: true });
    const factory = createImapFlowSessionFactory({
      resolveAccount: async () => account,
      createClient: () => asClient(fake),
    });
    await expect(factory(context(), protectedObject, original)).rejects.toThrow(
      "authentication as anna@example.org failed",
    );
  });

  it("refuses a master-user restore session where the server silently dropped the authzid", async () => {
    // Regression: a server that advertises neither AUTH=LOGIN nor AUTH=PLAIN
    // makes imapflow fall back to a plain IMAP LOGIN with no notion of
    // authzid, so the connection that just succeeded is authenticated as the
    // master account itself, not impersonating this mailbox. Restoring
    // through it would APPEND into the wrong mailbox while the job still
    // reports success, so the session must never be handed back.
    const masterAccount: ImapAccountConfig = {
      ...account,
      username: "master",
      authzid: "anna@example.org",
    };
    const fake = new FakeImapFlow({} as ImapFlowOptions, namespaced);
    fake.capabilities = new Map();
    const factory = createImapFlowSessionFactory({
      resolveAccount: async () => masterAccount,
      createClient: () => asClient(fake),
    });

    await expect(factory(context(), protectedObject, original)).rejects.toThrow(
      /does not offer AUTH=PLAIN/,
    );
    expect(fake.closed).toBe(true);
    expect(fake.calls.some((call) => call.startsWith("APPEND"))).toBe(false);
  });

  it("proceeds with a master-user restore session once the server actually offers AUTH=PLAIN", async () => {
    const masterAccount: ImapAccountConfig = {
      ...account,
      username: "master",
      authzid: "anna@example.org",
    };
    const fake = new FakeImapFlow({} as ImapFlowOptions, namespaced);
    fake.capabilities = new Map([["AUTH=PLAIN", true]]);
    const factory = createImapFlowSessionFactory({
      resolveAccount: async () => masterAccount,
      createClient: () => asClient(fake),
    });

    const session = await factory(context(), protectedObject, original);
    expect(session.delimiter).toBe(".");
    expect(fake.closed).toBe(false);
  });

  it("per_mailbox: two restores of different mailboxes each connect with their own login and password, never the other's", async () => {
    // Controller finding (medium): the engine-level test proved this for the
    // backup leg (packages/core/src/backup/imap/engine.test.ts) but not for
    // restore, whose connection this factory is what actually builds. Two
    // objects on the same per_mailbox source, each resolving to its own
    // secret (exactly what apps/worker/src/handlers/restore.ts's
    // `imapTargetAccount` does, restore.test.ts proves that resolution).
    const objectA = { ...protectedObject, id: "po-a", externalId: "a@hoster.test" };
    const objectB = { ...protectedObject, id: "po-b", externalId: "b@hoster.test" };
    const accountOf = (login: string): ImapAccountConfig => ({
      host: "imap.hoster.test",
      port: 993,
      security: "tls",
      username: login,
      authKind: "password",
      secretId: `secret-${login}`,
    });
    const created: FakeImapFlow[] = [];
    const factory = createImapFlowSessionFactory({
      resolveAccount: async (_ctx, protectedObj) => accountOf(protectedObj.externalId),
      createClient: (options) => {
        const fake = new FakeImapFlow(options, namespaced);
        created.push(fake);
        return asClient(fake);
      },
    });
    // One shared context, so a secret store that cached by anything other
    // than the object it was asked to resolve for would leak one mailbox's
    // password into the other's connection.
    const ctx = createMemoryJobContext({
      tenantId: "11111111-2222-4333-8444-555555555555",
      keys: new Keyring("11111111-2222-4333-8444-555555555555", [
        { version: 1, material: Buffer.alloc(32, 1) },
      ]),
      storage: new LocalStorageBackend("/nonexistent/restow-imap-flow-test"),
      secrets: {
        "secret-a@hoster.test": "password-for-a",
        "secret-b@hoster.test": "password-for-b",
      },
      signal: new AbortController().signal,
    });

    await factory(ctx, objectA, original);
    await factory(ctx, objectB, original);

    expect(created).toHaveLength(2);
    const [fakeA, fakeB] = created as [FakeImapFlow, FakeImapFlow];
    expect(fakeA.options.auth).toMatchObject({ user: "a@hoster.test", pass: "password-for-a" });
    expect(fakeB.options.auth).toMatchObject({ user: "b@hoster.test", pass: "password-for-b" });
  });
});
