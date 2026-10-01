import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RestoreTarget } from "../engine/types.js";
import { must } from "../graph/testing/fake-graph.js";
import { ImapRestoreEngine, appendableFlags, targetMailboxComponents } from "./imap.js";
import { FakeImapAccount } from "./testing/fake-imap.js";
import {
  type FixtureObject,
  type SnapshotFixture,
  corruptStoredObject,
  createSnapshotFixture,
  mimeMessage,
  restoreRequestFor,
} from "./testing/fixtures.js";

const NOW = new Date(Date.UTC(2026, 8, 22, 14, 30));
const RESTORE_FOLDER = "Restow 2026-09-22 1430";

// Objects shaped like the IMAP backup writes them (backup/imap): server paths
// with "." as delimiter, components percent-escaped in the logical path.

function folder(mailbox: string, path: string, specialUse?: string): FixtureObject {
  return {
    path,
    type: "folder",
    id: `imap:${mailbox}:7`,
    content: "",
    metadata: { mailbox, delimiter: ".", uidValidity: "7", ...(specialUse ? { specialUse } : {}) },
  };
}

function message(
  mailbox: string,
  path: string,
  uid: number,
  extra: { flags?: string; specialUse?: string; subject?: string } = {},
): FixtureObject {
  const messageId = `<m${uid}@example.org>`;
  return {
    path,
    type: "message",
    id: `imap:${mailbox}:7:${uid}`,
    content: mimeMessage({ messageId, subject: extra.subject ?? `Message ${uid}` }),
    mtime: Date.UTC(2025, 10, uid, 8, 15),
    metadata: {
      mailbox,
      delimiter: ".",
      uid: String(uid),
      uidValidity: "7",
      flags: extra.flags ?? "\\Seen",
      internalDate: new Date(Date.UTC(2025, 10, uid, 8, 15)).toISOString(),
      messageId,
      ...(extra.specialUse ? { specialUse: extra.specialUse } : {}),
    },
  };
}

const account: FixtureObject[] = [
  folder("INBOX", "mail/INBOX", "\\Inbox"),
  folder("Sent", "mail/Sent", "\\Sent"),
  folder("Sent.2025", "mail/Sent/2025"),
  folder("Clients.A/B Corp", "mail/Clients/A%2FB Corp"),
  folder("Archive", "mail/Archive"),
  message("INBOX", "mail/INBOX/1.eml", 1, {
    flags: "$Label1 \\Deleted \\Recent \\Seen",
    specialUse: "\\Inbox",
  }),
  message("Sent", "mail/Sent/2.eml", 2, { specialUse: "\\Sent" }),
  message("Sent.2025", "mail/Sent/2025/3.eml", 3),
  message("Clients.A/B Corp", "mail/Clients/A%2FB Corp/4.eml", 4, { flags: "\\Answered" }),
];

function engineFor(target: FakeImapAccount, seen: RestoreTarget[] = []): ImapRestoreEngine {
  return new ImapRestoreEngine({
    imap: async (_ctx, _protectedObject, restoreTarget) => {
      seen.push(restoreTarget);
      return target;
    },
  });
}

describe("ImapRestoreEngine", () => {
  let fixture: SnapshotFixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("restores messages byte for byte into their mailboxes with date and flags, and recreates empty ones", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: account,
    });
    const target = new FakeImapAccount({ delimiter: ".", mailboxes: { Sent: "\\Sent" } });

    const report = await engineFor(target).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(4);
    expect(report.folders).toBe(5);
    expect(report.unverified).toBe(0);
    expect(target.mailboxNames()).toEqual([
      "Archive",
      "Clients",
      "Clients.A/B Corp",
      "INBOX",
      "Sent",
      "Sent.2025",
    ]);
    expect(target.closed).toBe(true);

    const [inbox] = target.messages("INBOX");
    const source = must(fixture.objects.find((o) => o.id === "imap:INBOX:7:1"));
    expect(inbox?.content.toString()).toBe(account[5]?.content);
    expect(inbox?.flags).toEqual(["$Label1", "\\Seen"]);
    expect(inbox?.internalDate?.toISOString()).toBe(source.metadata?.internalDate);
    expect(target.messages("Clients.A/B Corp")[0]?.flags).toEqual(["\\Answered"]);

    const inboxItem = must(report.items.find((item) => item.id === "imap:INBOX:7:1"));
    expect(inboxItem).toMatchObject({
      status: "restored",
      verified: true,
      targetRef: `INBOX:${inbox?.uid}`,
    });
    expect(inboxItem.reason).toBe("\\Deleted \\Recent not set again");
    expect(fixture.ctx.progress.snapshot()).toMatchObject({ total: 9, done: 9, failed: 0 });
  });

  it("anchors special-use mailboxes on another server with another delimiter", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: account,
    });
    const target = new FakeImapAccount({ delimiter: "/", mailboxes: { "Sent Items": "\\Sent" } });
    const seen: RestoreTarget[] = [];

    const report = await engineFor(target, seen).run(
      fixture.ctx,
      restoreRequestFor(fixture, {
        mode: "skip",
        target: { type: "other", ref: "ben@imap.example.org" },
      }),
    );

    expect(report.failures).toEqual([]);
    expect(seen).toEqual([{ type: "other", ref: "ben@imap.example.org" }]);
    expect(target.messages("Sent Items")).toHaveLength(1);
    expect(target.messages("Sent Items/2025")).toHaveLength(1);
    // The target's delimiter inside a name would split it into two levels.
    expect(target.messages("Clients/A_B Corp")).toHaveLength(1);
    expect(target.mailboxNames()).not.toContain("Sent");
  });

  it("restores below a fresh mailbox in rename mode and recognises its own work on a retry", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: account,
    });
    const target = new FakeImapAccount({ delimiter: "." });
    const request = restoreRequestFor(fixture, { mode: "rename" });

    const first = await engineFor(target).run(fixture.ctx, request);
    expect(first.restored).toBe(4);
    expect(target.messages(`${RESTORE_FOLDER}.INBOX`)).toHaveLength(1);
    expect(target.messages(`${RESTORE_FOLDER}.Sent.2025`)).toHaveLength(1);
    expect(target.messages("INBOX")).toHaveLength(0);

    const retry = await engineFor(target).run(fixture.ctx, request);
    expect(retry.restored).toBe(0);
    expect(retry.skipped).toBe(4);
    expect(retry.items.find((item) => item.status === "skipped")?.reason).toMatch(
      /job was retried/,
    );
  });

  it("says a legacy 'replace' job ran as 'rename' on a retry's skips too, not only its restores", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: account,
    });
    const target = new FakeImapAccount({ delimiter: "." });
    const request = restoreRequestFor(fixture, { mode: "replace" });

    await engineFor(target).run(fixture.ctx, request);
    const retry = await engineFor(target).run(fixture.ctx, request);

    expect(retry.restored).toBe(0);
    expect(retry.skipped).toBe(4);
    // Every skipped message, not only a restored one, says the job ran as
    // "rename" (folders are recreated idempotently and carry no note either
    // way; this asserts on the messages the retry skipped).
    const skippedMessages = retry.items.filter((item) => item.status === "skipped");
    expect(skippedMessages).toHaveLength(4);
    expect(
      skippedMessages.every((skipped) => skipped.reason?.includes('ran as "rename" instead')),
    ).toBe(true);
  });

  it("keeps the restore mailbox of a retried job although the clock moved on", async () => {
    let clock = NOW;
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => clock,
      objects: account,
    });
    const target = new FakeImapAccount({ delimiter: "." });
    const request = restoreRequestFor(fixture, { mode: "rename", requestedAt: NOW });

    await engineFor(target).run(fixture.ctx, request);
    clock = new Date(NOW.getTime() + 7 * 60_000);
    const retry = await engineFor(target).run(fixture.ctx, request);

    expect(retry.restored).toBe(0);
    expect(retry.skipped).toBe(4);
    expect(new Set(target.mailboxNames().map((name) => name.split(".")[0]))).toEqual(
      new Set([RESTORE_FOLDER, "INBOX"]),
    );
    expect(target.messages(`${RESTORE_FOLDER}.INBOX`)).toHaveLength(1);
  });

  it("skips what already exists by Message-ID, and never deletes it in any mode", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: [message("INBOX", "mail/INBOX/1.eml", 1)],
    });
    const target = new FakeImapAccount({ delimiter: "." });
    const existing = target.seed(
      "INBOX",
      mimeMessage({ messageId: "<m1@example.org>", subject: "old" }),
    );

    const skipped = await engineFor(target).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );
    expect(skipped.skipped).toBe(1);
    expect(skipped.items[0]).toMatchObject({ code: "exists", targetRef: `INBOX:${existing.uid}` });

    // A job queued before "replace" was disallowed for mailboxes runs as
    // "rename" instead: the restored copy lands below a fresh restore
    // mailbox, and the original is never touched or removed.
    const replaced = await engineFor(target).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );
    expect(replaced.restored).toBe(1);
    expect(replaced.items[0]?.reason).toMatch(
      /queued with the mode "replace".*ran as "rename" instead/,
    );
    expect(target.commands.some((command) => command.startsWith("DELETE"))).toBe(false);
    expect(target.messages("INBOX")).toEqual([existing]);
    expect(target.messages(`${RESTORE_FOLDER}.INBOX`).map((m) => m.content.toString())).toEqual([
      mimeMessage({ messageId: "<m1@example.org>", subject: "Message 1" }),
    ]);
  });

  it("isolates a legacy 'replace' job's failures without ever touching or deleting existing messages", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: [message("INBOX", "mail/INBOX/1.eml", 1)],
    });
    const old = mimeMessage({ messageId: "<m1@example.org>", subject: "old" });
    const replace = restoreRequestFor(fixture, { mode: "replace" });
    const restoreMailbox = `${RESTORE_FOLDER}.INBOX`;

    // The server refuses the APPEND into the restore mailbox.
    const full = new FakeImapAccount({ delimiter: "." });
    const keptOnRefusal = full.seed("INBOX", old);
    full.refuseAppendTo = restoreMailbox;
    const refused = await engineFor(full).run(fixture.ctx, replace);
    expect(refused.items[0]).toMatchObject({ status: "failed", code: "error" });
    // Even a failed item says the job ran as "rename" instead of the
    // "replace" it was queued with — the downgrade must not go unsaid just
    // because nothing was actually restored.
    expect(refused.items[0]?.reason).toMatch(
      /queued with the mode "replace".*ran as "rename" instead/,
    );
    expect(full.messages("INBOX")).toEqual([keptOnRefusal]);
    expect(full.commands.some((command) => command.startsWith("DELETE"))).toBe(false);

    // The backup cannot be read: nothing is written at all.
    await corruptStoredObject(fixture, must(fixture.objects[0]));
    const target = new FakeImapAccount({ delimiter: "." });
    const keptOnCorruption = target.seed("INBOX", old);
    const corrupt = await engineFor(target).run(fixture.ctx, replace);
    // The failure code still reflects the real cause (a corrupted chunk),
    // not a generic one, even though the reason text was rewritten to add
    // the legacy-mode note.
    expect(corrupt.items[0]).toMatchObject({ status: "failed", code: "integrity" });
    expect(corrupt.items[0]?.reason).toMatch(
      /queued with the mode "replace".*ran as "rename" instead/,
    );
    expect(target.messages("INBOX")).toEqual([keptOnCorruption]);
    expect(target.commands.filter((command) => /^(APPEND|DELETE)/.test(command))).toEqual([]);
  });

  it("reports stored bytes that differ, and appends without UIDPLUS as unconfirmed", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      objects: [message("INBOX", "mail/INBOX/1.eml", 1)],
    });
    const mangling = new FakeImapAccount();
    mangling.mangle = (content) => Buffer.from(content.toString().replace(/\r\n/g, "\n"));
    const mangled = await engineFor(mangling).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );
    expect(mangled.unverified).toBe(1);
    expect(mangled.items[0]).toMatchObject({
      code: "unverified",
      reason: "the server stores different bytes than were appended",
    });

    const legacy = new FakeImapAccount({ noUidPlus: true });
    const unconfirmed = await engineFor(legacy).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );
    expect(unconfirmed.items[0]).toMatchObject({
      status: "restored",
      code: "restored",
      verified: false,
      targetRef: "INBOX",
    });
  });

  it("isolates refused appends and foreign objects, and always logs out", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      objects: [
        message("INBOX", "mail/INBOX/1.eml", 1),
        message("Sent", "mail/Sent/2.eml", 2),
        { path: "Documents/a.txt", type: "file", id: "F", content: "x" },
      ],
    });
    const target = new FakeImapAccount({ mailboxes: { Sent: "\\Sent" } });
    target.refuseAppendTo = "Sent";

    const report = await engineFor(target).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.restored).toBe(1);
    expect(report.failures).toEqual([
      {
        itemRef: "imap:Sent:7:2",
        reason: "NO [OVERQUOTA] mailbox is full",
        cause: expect.objectContaining({ code: "imap.mailbox_full" }),
      },
      {
        itemRef: "F",
        reason: "only messages and mailboxes can be restored into an IMAP account",
        cause: expect.objectContaining({ code: "unknown" }),
      },
    ]);
    expect(report.items.find((item) => item.id === "F")?.code).toBe("wrong_target");
    expect(target.closed).toBe(true);
  });

  it("logs out when the job is cancelled mid-restore", async () => {
    const controller = new AbortController();
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      signal: controller.signal,
      objects: [message("INBOX", "mail/INBOX/1.eml", 1)],
    });
    const target = new FakeImapAccount();
    const engine = new ImapRestoreEngine({
      imap: async () => {
        controller.abort();
        return target;
      },
    });
    await expect(engine.run(fixture.ctx, restoreRequestFor(fixture))).rejects.toThrow(/aborted/);
    expect(target.closed).toBe(true);
    expect(target.messages("INBOX")).toHaveLength(0);
  });

  it("refuses an other-account restore without an account", async () => {
    fixture = await createSnapshotFixture({ kind: "imap", externalId: "anna", objects: [] });
    await expect(
      engineFor(new FakeImapAccount()).run(
        fixture.ctx,
        restoreRequestFor(fixture, { target: { type: "other", ref: " " } }),
      ),
    ).rejects.toThrow(/needs the target account/);
  });
});

// A folder can hold two different messages with one Message-ID: the direct
// copy of a mail and the copy a mailing list delivered.
describe("ImapRestoreEngine with two backed-up messages sharing a Message-ID", () => {
  const SHARED = "<list-post-1@example.org>";
  const direct = mimeMessage({ messageId: SHARED, subject: "Direct copy" });
  const listCopy = mimeMessage({ messageId: SHARED, subject: "[list] List copy" });
  const old = mimeMessage({ messageId: SHARED, subject: "old" });
  const DIRECT_ID = "imap:INBOX:7:1";
  const LIST_ID = "imap:INBOX:7:2";

  function twin(uid: number, content: string): FixtureObject {
    const base = message("INBOX", `mail/INBOX/${uid}.eml`, uid, { specialUse: "\\Inbox" });
    return { ...base, content, metadata: { ...base.metadata, messageId: SHARED } };
  }

  let fixture: SnapshotFixture;

  beforeEach(async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      now: () => NOW,
      objects: [twin(1, direct), twin(2, listCopy)],
    });
  });

  afterEach(async () => {
    await fixture?.cleanup();
  });

  const contents = (target: FakeImapAccount, mailbox: string) =>
    target.messages(mailbox).map((stored) => stored.content.toString());
  const item = (report: { items: readonly { id: string | undefined }[] }, id: string) =>
    must(report.items.find((candidate) => candidate.id === id));

  it.each([
    ["skip", "INBOX"],
    // A legacy job queued with the discontinued mode "replace" runs exactly
    // as "rename": below the fresh restore mailbox, original untouched.
    ["replace", `${RESTORE_FOLDER}.INBOX`],
    ["rename", `${RESTORE_FOLDER}.INBOX`],
  ] as const)(
    "restores both in %s mode and never removes a copy it restored",
    async (mode, mailbox) => {
      const target = new FakeImapAccount({ delimiter: "." });

      const report = await engineFor(target).run(fixture.ctx, restoreRequestFor(fixture, { mode }));

      expect(report.failures).toEqual([]);
      expect(report.restored).toBe(2);
      expect(report.skipped).toBe(0);
      expect(contents(target, mailbox)).toEqual([direct, listCopy]);
      expect(target.commands.some((command) => command.startsWith("DELETE"))).toBe(false);
      // Every copy the report names is still there.
      const stored = target.messages(mailbox).map((copy) => `${mailbox}:${copy.uid}`);
      expect(report.items.map((restored) => restored.targetRef)).toEqual(stored);
      expect(report.items.every((restored) => restored.verified)).toBe(true);
    },
  );

  it("never deletes the copy the mailbox had for a legacy 'replace' job, with or without UIDPLUS", async () => {
    for (const noUidPlus of [false, true]) {
      const target = new FakeImapAccount({ delimiter: ".", noUidPlus });
      const had = target.seed("INBOX", old);

      const report = await engineFor(target).run(
        fixture.ctx,
        restoreRequestFor(fixture, { mode: "replace" }),
      );

      expect(report.failures).toEqual([]);
      expect(report.restored).toBe(2);
      expect(
        report.items.every((restored) => restored.reason?.includes('ran as "rename" instead')),
      ).toBe(true);
      // The original mailbox is untouched; both copies land below the restore mailbox.
      expect(target.messages("INBOX")).toEqual([had]);
      expect(contents(target, `${RESTORE_FOLDER}.INBOX`)).toEqual([direct, listCopy]);
      expect(target.commands.some((command) => command.startsWith("DELETE"))).toBe(false);
    }
  });

  it("keeps the copy the mailbox had for a legacy 'replace' job even when one message cannot be restored", async () => {
    await corruptStoredObject(fixture, must(fixture.objects.find((o) => o.id === DIRECT_ID)));
    const target = new FakeImapAccount({ delimiter: "." });
    const had = target.seed("INBOX", old);

    const report = await engineFor(target).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "replace" }),
    );

    // The failed item says the job ran as "rename" too, not just the one
    // that actually got restored — the downgrade must be visible even on a
    // partial (or, on another run, total) failure.
    expect(item(report, DIRECT_ID)).toMatchObject({
      status: "failed",
      code: "integrity",
      reason: expect.stringMatching(/queued with the mode "replace".*ran as "rename" instead/),
    });
    expect(item(report, LIST_ID)).toMatchObject({
      status: "restored",
      reason: expect.stringMatching(/queued with the mode "replace".*ran as "rename" instead/),
    });
    expect(target.messages("INBOX")).toEqual([had]);
    expect(contents(target, `${RESTORE_FOLDER}.INBOX`)).toEqual([listCopy]);
    expect(target.commands.some((command) => command.startsWith("DELETE"))).toBe(false);
  });

  it("skips both in skip mode when the mailbox already has the Message-ID", async () => {
    const target = new FakeImapAccount({ delimiter: "." });
    const had = target.seed("INBOX", old);

    const report = await engineFor(target).run(
      fixture.ctx,
      restoreRequestFor(fixture, { mode: "skip" }),
    );

    expect(report.skipped).toBe(2);
    for (const skipped of report.items) {
      expect(skipped).toMatchObject({ code: "exists", targetRef: `INBOX:${had.uid}` });
      expect(skipped.reason).toBe(
        "a message with this Message-ID already exists in the target mailbox",
      );
    }
    expect(contents(target, "INBOX")).toEqual([old]);
  });

  it("recognises each of its own earlier copies by content when a rename-mode job is retried", async () => {
    const request = restoreRequestFor(fixture, { mode: "rename" });
    const mailbox = `${RESTORE_FOLDER}.INBOX`;

    // Both were restored by the earlier attempt: nothing is written again.
    const target = new FakeImapAccount({ delimiter: "." });
    await engineFor(target).run(fixture.ctx, request);
    const retry = await engineFor(target).run(fixture.ctx, request);
    expect(retry.skipped).toBe(2);
    for (const skipped of retry.items) {
      expect(skipped.reason).toBe(
        "this message was already restored into this mailbox, with the same content (the job was retried)",
      );
    }
    expect(contents(target, mailbox)).toEqual([direct, listCopy]);

    // The earlier attempt restored only the list copy: the direct one follows now.
    const partial = new FakeImapAccount({ delimiter: "." });
    await partial.ensureMailbox(mailbox);
    const earlier = partial.seed(mailbox, listCopy);
    const resumed = await engineFor(partial).run(fixture.ctx, request);
    expect(resumed.restored).toBe(1);
    expect(item(resumed, DIRECT_ID)).toMatchObject({ status: "restored" });
    expect(item(resumed, LIST_ID)).toMatchObject({
      status: "skipped",
      targetRef: `${mailbox}:${earlier.uid}`,
    });
    expect(contents(partial, mailbox)).toEqual([listCopy, direct]);
  });
});

describe("IMAP helpers", () => {
  it("withholds \\Recent and \\Deleted", () => {
    expect(appendableFlags(["\\Seen", "\\Recent", "\\seen", "\\DELETED", "\\Seen"])).toEqual({
      flags: ["\\Seen", "\\seen"],
      withheld: ["\\Recent", "\\DELETED"],
    });
  });

  it("falls back to names when the target has no special-use mailbox", () => {
    const session = { delimiter: "/", specialUseMailbox: () => undefined };
    expect(
      targetMailboxComponents(
        [{ name: "Gesendet", anchor: "\\Sent" }, { name: "2025" }],
        session,
        null,
      ),
    ).toEqual(["Gesendet", "2025"]);
    expect(
      targetMailboxComponents(
        [{ name: "INBOX", anchor: "\\Inbox" }],
        { delimiter: "." },
        "Old/Stuff",
      ),
    ).toEqual(["Old/Stuff", "INBOX"]);
  });
});
