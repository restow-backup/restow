/**
 * An imported mailbox restored into a Microsoft 365 mailbox: the snapshot has the
 * IMAP manifest layout, the Exchange restore engine reads it (docs/IMPORT.md).
 */
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { Keyring } from "../engine/keyring.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../engine/memory.js";
import type { ProtectedObjectRef, RestoreRequest } from "../engine/types.js";
import { ExchangeRestoreEngine } from "../restore/exchange.js";
import { FakeMailbox } from "../restore/testing/fake-mailbox.js";
import { MemoryStorage } from "../verify/testing.js";
import { MailImportEngine } from "./import-engine.js";
import type { MailInputFile, MailWalkEvent, MessageMeta } from "./types.js";

const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x21) };
const imported: ProtectedObjectRef = {
  id: "po-import-x",
  tenantId: TENANT,
  sourceId: "src-import",
  kind: "imap",
  externalId: "import-x",
  displayName: "Legacy",
  userId: null,
};

function eml(subject: string, id: string): Buffer {
  return Buffer.from(
    `From: bob@example.test\r\nTo: anna@example.org\r\nSubject: ${subject}\r\nMessage-ID: <${id}@example.test>\r\nDate: Tue, 05 Mar 2019 14:12:00 +0000\r\n\r\nbody of ${subject}\r\n`,
  );
}

function meta(raw: Buffer): MessageMeta {
  const text = raw.toString("utf8");
  return {
    messageId: /^Message-ID:\s*(\S+)/im.exec(text)?.[1] ?? null,
    subject: /^Subject:\s*(.*)$/im.exec(text)?.[1]?.trim() ?? "",
    from: "bob@example.test",
    to: ["anna@example.org"],
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

describe("imported mailbox restored into Microsoft 365", () => {
  it("lands the messages, byte for byte, in a fresh restore folder with the folder structure", async () => {
    const storage = new MemoryStorage();
    const chunkIndex = new MemoryChunkIndex();
    const snapshots = new MemorySnapshotIndex(TENANT);
    const ctx = () =>
      createMemoryJobContext({
        tenantId: TENANT,
        keys: new Keyring(TENANT, [dek]),
        storage,
        chunkIndex,
        snapshots,
        cursor: new MemoryCursorStore(),
        now: () => new Date("2026-09-30T10:00:00Z"),
      });
    const one = eml("Offer", "o1");
    const two = eml("Contract", "o2");
    const walk = async function* (_file: MailInputFile): AsyncGenerator<MailWalkEvent> {
      yield {
        type: "message",
        ref: "x.mbox#0",
        index: 0,
        folder: ["Inbox"],
        sourceName: "0",
        format: "mbox",
        raw: one,
        synthesized: false,
        flags: [],
        internalDate: null,
        sourceBytes: one.length,
      };
      yield {
        type: "message",
        ref: "x.mbox#1",
        index: 1,
        folder: ["Inbox", "Clients"],
        sourceName: "1",
        format: "mbox",
        raw: two,
        synthesized: false,
        flags: ["\\Seen"],
        internalDate: null,
        sourceBytes: two.length,
      };
    };
    const file: MailInputFile = {
      path: "x.mbox",
      size: 100,
      open: () => Readable.from([Buffer.alloc(100)]),
      read: async () => Buffer.alloc(10),
    };
    const result = await new MailImportEngine({
      walk,
      parseMeta: async (raw) => meta(raw),
      detect: () => ({ format: "mbox" }),
    }).run(ctx(), imported, {
      groups: [{ label: "x.mbox", size: 100, kind: "file" }],
      units: [{ key: "k", group: 0, kind: "file", path: "x.mbox", size: 100 }],
      open: () => file,
    });

    const mailbox = new FakeMailbox();
    const engine = new ExchangeRestoreEngine({ graph: () => mailbox.graph.client() });
    const request: RestoreRequest = {
      restoreJobId: "restore-cross",
      snapshotId: result.snapshotId,
      protectedObject: imported,
      selection: { all: true },
      target: { type: "other", ref: "anna@example.org" },
      mode: "rename",
      actor: { userId: null, impersonated: false, reason: null },
      requestedAt: new Date("2026-09-30T10:00:00Z"),
    };
    const report = await engine.run(ctx(), request);
    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    const restored = [...mailbox.messages.values()];
    expect(restored).toHaveLength(2);
    const bytes = restored.map((message) => Buffer.from(message.mime as Buffer | string));
    expect(bytes).toContainEqual(one);
    expect(bytes).toContainEqual(two);
    expect(
      restored.map((message) => mailbox.folderPath(message.parentFolderId).join("/")).sort(),
    ).toEqual(["Restow 2026-09-30 1000/Inbox", "Restow 2026-09-30 1000/Inbox/Clients"]);
  });
});
