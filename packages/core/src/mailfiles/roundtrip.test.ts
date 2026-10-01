/**
 * Import, export, import again (docs/IMPORT.md, docs/TESTING.md): the proof that
 * what goes in comes out byte for byte, through the real readers, the real
 * import engine, the encrypted chunk store and the real export writers.
 *
 *   files -> import -> snapshot -> export (EML ZIP, MBOX, MBOX ZIP) -> read the
 *   export with the import readers -> the same messages, hash for hash
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Dek } from "../crypto.js";
import { ChunkReader } from "../engine/chunkstore.js";
import { Keyring } from "../engine/keyring.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../engine/memory.js";
import type { JobContext, ProtectedObjectRef } from "../engine/types.js";
import { MemoryStorage } from "../verify/testing.js";
import { openSnapshotExport } from "./export-sources.js";
import { createEmlZip } from "./export/eml-zip.js";
import { createMbox, createMboxZip } from "./export/mbox.js";
import type { ExportMessage } from "./export/types.js";
import { MailImportEngine } from "./import-engine.js";
import { buildEml, buildMbox, buildZip, inputFileFromBuffer } from "./testing/builders.js";
import type { MailInputFile, MailWalkEvent } from "./types.js";
import { walkMailFile } from "./walk.js";

const TENANT = "0f0e0d0c-0b0a-4908-8706-050403020100";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x33) };
const mailbox: ProtectedObjectRef = {
  id: "po-roundtrip",
  tenantId: TENANT,
  sourceId: "src-import",
  kind: "imap",
  externalId: "import-roundtrip",
  displayName: "Legacy",
  userId: null,
};

/** The messages are CRLF already: the MBOX keeps them byte for byte. */
const CRLF = { eol: "\r\n" } as const;

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function context(): JobContext {
  return createMemoryJobContext({
    tenantId: TENANT,
    keys: new Keyring(TENANT, [dek]),
    storage: new MemoryStorage(),
    chunkIndex: new MemoryChunkIndex(),
    snapshots: new MemorySnapshotIndex(TENANT),
    cursor: new MemoryCursorStore(),
    now: () => new Date("2026-09-30T10:00:00Z"),
  });
}

async function streamOf(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

async function walked(file: MailInputFile): Promise<MailWalkEvent[]> {
  const events: MailWalkEvent[] = [];
  for await (const event of walkMailFile(file)) {
    events.push(event);
  }
  return events;
}

async function messagesOf(file: MailInputFile) {
  return (await walked(file)).flatMap((event) => (event.type === "message" ? [event] : []));
}

const originals = {
  inbox: [
    buildEml({
      from: "Ada Example <ada@example.test>",
      to: "bob@example.test",
      subject: "Quarterly figures",
      body: "See attachment.\r\nFrom the board.",
      attachments: [{ filename: "figures.csv", content: "a,b\r\n1,2\r\n" }],
    }),
    buildEml({
      from: "bob@example.test",
      to: ["ada@example.test", "cy@example.test"],
      cc: "dee@example.test",
      subject: "Grüße aus Köln",
      body: "Umlaute: äöüß\r\n\r\n>From here on it gets tricky\r\nFrom line inside a body",
      html: "<p>Umlaute: &auml;&ouml;&uuml;&szlig;</p>",
    }),
  ],
  sent: [
    buildEml({
      from: "ada@example.test",
      to: "bob@example.test",
      subject: "Re: Quarterly figures",
      body: "Thanks!\r\n",
    }),
  ],
};

async function importAll(ctx: JobContext, files: MailInputFile[]) {
  const engine = new MailImportEngine();
  return engine.run(ctx, mailbox, {
    groups: files.map((file) => ({ label: file.path, size: file.size, kind: "file" as const })),
    units: files.map((file, index) => ({
      key: `f:${index}`,
      group: index,
      kind: "file" as const,
      path: file.path,
      size: file.size,
    })),
    open: (unit) => files[Number(unit.key.slice(2))] as MailInputFile,
  });
}

/** Export messages of a snapshot, as the export job does. */
async function exportMessagesOf(ctx: JobContext, snapshotId: string): Promise<ExportMessage[]> {
  const source = await openSnapshotExport(ctx, {
    snapshotId,
    protectedObject: mailbox,
    selection: { all: true },
  });
  return [...source.messages];
}

describe("import, export, import", () => {
  it("exports an imported MBOX + ZIP + loose EML as EML ZIP and reads every message back byte for byte", async () => {
    const ctx = context();
    const files = [
      inputFileFromBuffer("Inbox.mbox", buildMbox(originals.inbox, CRLF)),
      inputFileFromBuffer(
        "sent-items.zip",
        await buildZip([
          { name: "Sent/", data: "" },
          { name: "Sent/one.eml", data: originals.sent[0] as Buffer },
        ]),
      ),
    ];
    const result = await importAll(ctx, files);
    expect(result.report.totals).toMatchObject({ messages: 3, failed: 0, duplicates: 0 });

    // Stored: byte-exact, hash for hash.
    const reader = new ChunkReader({ storage: ctx.storage, keys: ctx.keys, index: ctx.chunkIndex });
    const source = await openSnapshotExport(ctx, {
      snapshotId: result.snapshotId,
      protectedObject: mailbox,
      selection: { all: true },
    });
    expect(reader).toBeDefined();
    const wanted = [...originals.inbox, ...originals.sent].map(sha).sort();
    const stored = (
      await Promise.all(source.messages.map(async (message) => sha(await streamOf(message.open()))))
    ).sort();
    expect(stored).toEqual(wanted);

    // EML ZIP: every .eml equals an original, the manifest hashes match, folders survive.
    const zip = createEmlZip(await exportMessagesOf(ctx, result.snapshotId));
    const archive = await streamOf(zip.stream);
    const summary = await zip.completed;
    expect(summary).toMatchObject({ messages: 3, failed: 0 });
    const exported = inputFileFromBuffer("export.zip", archive);
    const back = await messagesOf(exported);
    expect(back.map((event) => sha(event.raw)).sort()).toEqual(wanted);
    expect(back.map((event) => event.folder.join("/")).sort()).toEqual(["Inbox", "Inbox", "Sent"]);
    const problems = (await walked(exported)).filter((event) => event.type === "problem");
    // MANIFEST.csv and SHA256SUMS are not mail: reported as such, never as failures.
    expect(problems.every((event) => event.type === "problem" && event.code === "not_mail")).toBe(
      true,
    );
    expect(problems).toHaveLength(2);
  });

  it("exports one folder as a single MBOX that imports again to the same hashes", async () => {
    const ctx = context();
    const first = await importAll(ctx, [
      inputFileFromBuffer("Inbox.mbox", buildMbox(originals.inbox, CRLF)),
    ]);
    const messages = await exportMessagesOf(ctx, first.snapshotId);
    const mbox = createMbox(messages);
    const bytes = await streamOf(mbox.stream);
    await mbox.completed;

    const again = context();
    const second = await importAll(again, [inputFileFromBuffer("exported.mbox", bytes)]);
    expect(second.report.totals).toMatchObject({ messages: 2, failed: 0, duplicates: 0 });
    const back = (await messagesOf(inputFileFromBuffer("exported.mbox", bytes))).map((event) =>
      sha(event.raw),
    );
    expect(back.sort()).toEqual(originals.inbox.map(sha).sort());
  });

  it("exports several folders as MBOX inside a ZIP and reads them back with their folders", async () => {
    const ctx = context();
    const result = await importAll(ctx, [
      inputFileFromBuffer("Inbox.mbox", buildMbox(originals.inbox, CRLF)),
      inputFileFromBuffer("Sent.mbox", buildMbox(originals.sent, CRLF)),
    ]);
    const zip = createMboxZip(await exportMessagesOf(ctx, result.snapshotId));
    const bytes = await streamOf(zip.stream);
    expect(await zip.completed).toMatchObject({ messages: 3, failed: 0 });
    const back = await messagesOf(inputFileFromBuffer("mbox-export.zip", bytes));
    const byFolder = new Map<string, string[]>();
    for (const event of back) {
      const key = event.folder.join("/");
      byFolder.set(key, [...(byFolder.get(key) ?? []), sha(event.raw)]);
    }
    expect([...byFolder.keys()].sort()).toEqual(["Inbox", "Sent"]);
    expect((byFolder.get("Inbox") ?? []).sort()).toEqual(originals.inbox.map(sha).sort());
    expect(byFolder.get("Sent")).toEqual(originals.sent.map(sha));
  });

  it("does not store a message twice when the exported file is imported into the same mailbox", async () => {
    const ctx = context();
    const first = await importAll(ctx, [
      inputFileFromBuffer("Inbox.mbox", buildMbox(originals.inbox, CRLF)),
    ]);
    const mbox = createMbox(await exportMessagesOf(ctx, first.snapshotId));
    const bytes = await streamOf(mbox.stream);
    await mbox.completed;
    // Same mailbox, same folder name (the file is named like the folder): only duplicates.
    await expect(importAll(ctx, [inputFileFromBuffer("Inbox.mbox", bytes)])).rejects.toThrow(
      /no new messages/,
    );
  });

  it("keeps a message without a final line break exact in EML but gives it one in MBOX (documented)", async () => {
    const bare = buildEml({
      from: "ada@example.test",
      to: "bob@example.test",
      subject: "No final newline",
      body: "last line",
    });
    expect(bare.at(-1)).not.toBe(0x0a);
    const ctx = context();
    const result = await importAll(ctx, [
      inputFileFromBuffer("bare.zip", await buildZip([{ name: "Inbox/bare.eml", data: bare }])),
    ]);
    const messages = await exportMessagesOf(ctx, result.snapshotId);
    const zip = createEmlZip(messages);
    const eml = await messagesOf(inputFileFromBuffer("out.zip", await streamOf(zip.stream)));
    expect(eml.map((event) => event.raw.equals(bare))).toEqual([true]);
    const mbox = createMbox(await exportMessagesOf(ctx, result.snapshotId));
    const back = await messagesOf(inputFileFromBuffer("out.mbox", await streamOf(mbox.stream)));
    expect(back[0]?.raw.equals(Buffer.concat([bare, Buffer.from("\r\n")]))).toBe(true);
  });
});
