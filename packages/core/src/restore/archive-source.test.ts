import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { must } from "../graph/testing/fake-graph.js";
import type { ManifestObject } from "../manifest.js";
import {
  type ArchiveRestoreItem,
  archiveRestoreObject,
  archiveRestorePath,
  archiveRestoreSource,
} from "./archive-source.js";
import { ExchangeRestoreEngine } from "./exchange.js";
import { ImapRestoreEngine } from "./imap.js";
import { RestoreSourceError, resolveRestoreSource } from "./selection.js";
import { FakeImapAccount } from "./testing/fake-imap.js";
import { FakeMailbox } from "./testing/fake-mailbox.js";
import {
  corruptStoredObject,
  createSnapshotFixture,
  mimeMessage,
  restoreRequestFor,
  type SnapshotFixture,
} from "./testing/fixtures.js";

const NOW = new Date(Date.UTC(2026, 10, 4, 9, 5));
const FOLDER = "Aus dem Archiv 2026-11-04 0905";

const late = mimeMessage({ messageId: "<late@example.org>", subject: "Nach der Sicherung" });
const later = mimeMessage({ messageId: "<later@example.org>", subject: "Noch später" });

/**
 * The bytes are written through the chunk store like the archive writes an original; the
 * snapshot the fixture commits around them is never named by the restore request.
 */
async function archived(kind: "mailbox" | "imap", externalId: string) {
  const fixture = await createSnapshotFixture({
    kind,
    externalId,
    now: () => NOW,
    objects: [
      { path: "a", content: late },
      { path: "b", content: later },
    ],
  });
  const items: ArchiveRestoreItem[] = fixture.objects.map((object, index) => ({
    id: randomUUID(),
    itemHash: must(object.sha256),
    sizeBytes: object.size,
    chunks: object.chunks,
    messageId: index === 0 ? "<late@example.org>" : " ",
    receivedAt: new Date(Date.UTC(2026, 10, 4, 8, index)),
    sentAt: index === 0 ? new Date(Date.UTC(2026, 10, 4, 7, 59)) : null,
  }));
  return { fixture, items };
}

function requestFor(fixture: SnapshotFixture, items: readonly ArchiveRestoreItem[]) {
  const restoreJobId = randomUUID();
  return {
    ...restoreRequestFor(
      { protectedObject: fixture.protectedObject, snapshotId: restoreJobId },
      { restoreJobId, options: { restoreFolderName: FOLDER } },
    ),
    source: archiveRestoreSource({
      protectedObject: fixture.protectedObject,
      items,
      label: restoreJobId,
      createdAt: NOW,
    }),
  };
}

describe("archived messages as a restore source", () => {
  let fixture: SnapshotFixture | undefined;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined;
  });

  it("describes an archived message as a MIME message at the root of the mail area", () => {
    const id = "6a1f0e0e-6c43-4d1e-9a39-0d6c7c1b1a11";
    const object = archiveRestoreObject({
      id,
      itemHash: "ab".repeat(32),
      sizeBytes: 120,
      chunks: ["c1", "c2"],
      messageId: " <x@example.org> ",
      receivedAt: new Date("2026-11-04T08:00:00Z"),
      sentAt: new Date("2026-11-04T07:00:00Z"),
    });
    expect(object).toEqual<ManifestObject>({
      path: archiveRestorePath(id),
      size: 120,
      mtime: Date.parse("2026-11-04T07:00:00Z"),
      id,
      type: "mail",
      sha256: "ab".repeat(32),
      chunks: ["c1", "c2"],
      metadata: {
        format: "mime",
        internalDate: "2026-11-04T07:00:00.000Z",
        messageId: "<x@example.org>",
      },
    });
    expect(archiveRestorePath(id)).toBe(`mail/${id}.eml`);
  });

  it("resolves without a snapshot, and only for the protected object it was built for", async () => {
    const built = await archived("mailbox", "anna@example.org");
    fixture = built.fixture;
    const request = requestFor(fixture, built.items);
    const resolved = await resolveRestoreSource(fixture.ctx, request);
    expect(resolved.manifest.objects.map((object) => object.id)).toEqual(
      built.items.map((item) => item.id),
    );
    expect(resolved.record).toMatchObject({
      protectedObjectId: fixture.protectedObject.id,
      manifestPath: null,
      itemCount: 2,
    });

    const other = { ...fixture.protectedObject, id: randomUUID() };
    await expect(
      resolveRestoreSource(fixture.ctx, { ...request, protectedObject: other }),
    ).rejects.toBeInstanceOf(RestoreSourceError);
  });

  it("puts the archived bytes into a restore folder of the mailbox through Graph", async () => {
    const built = await archived("mailbox", "anna@example.org");
    fixture = built.fixture;
    const mailbox = new FakeMailbox();
    const engine = new ExchangeRestoreEngine({ graph: () => mailbox.graph.client() });

    const report = await engine.run(fixture.ctx, requestFor(fixture, built.items));

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    const messages = [...mailbox.messages.values()];
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(mailbox.folderPath(message.parentFolderId)).toEqual([FOLDER]);
    }
    expect(messages.map((message) => message.mime).sort()).toEqual([late, later].sort());
    const first = must(report.items.find((item) => item.id === built.items[0]?.id));
    expect(first).toMatchObject({ status: "restored", verified: true });
  });

  it("appends the archived bytes below a restore mailbox of the IMAP account", async () => {
    const built = await archived("imap", "anna");
    fixture = built.fixture;
    const target = new FakeImapAccount({ delimiter: "." });
    const engine = new ImapRestoreEngine({ imap: async () => target });

    const report = await engine.run(fixture.ctx, requestFor(fixture, built.items));

    expect(report.failures).toEqual([]);
    expect(report.restored).toBe(2);
    const stored = target.messages(`${FOLDER}.INBOX`);
    expect(stored.map((message) => message.content.toString("utf8")).sort()).toEqual(
      [late, later].sort(),
    );
    expect(target.messages("INBOX")).toHaveLength(0);
  });

  it("never writes a message whose stored bytes do not match the capture", async () => {
    const built = await archived("mailbox", "anna@example.org");
    fixture = built.fixture;
    await corruptStoredObject(fixture, must(fixture.objects[0]));
    const mailbox = new FakeMailbox();
    const engine = new ExchangeRestoreEngine({ graph: () => mailbox.graph.client() });

    const report = await engine.run(fixture.ctx, requestFor(fixture, built.items));

    expect(report.restored).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect([...mailbox.messages.values()].map((message) => message.mime)).toEqual([later]);
  });
});
