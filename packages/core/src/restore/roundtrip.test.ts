/**
 * Restore proof (docs/TESTING.md): what the backup engines write, the restore
 * engines put back. Each test runs a real backup engine against its Graph
 * fake, then restores the snapshot into a separate target fake and compares
 * bytes, placement, flags and timestamps with the source.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeBackupEngine } from "../backup/exchange/engine.js";
import { FakeMailbox as SourceMailbox } from "../backup/exchange/testing/fake-mailbox.js";
import { OneDriveBackupEngine } from "../backup/onedrive/engine.js";
import { DRIVE, contentRoutes, deltaUrl } from "../backup/onedrive/testing.js";
import { createFakeGraph, must } from "../graph/testing/fake-graph.js";
import { ExchangeRestoreEngine } from "./exchange.js";
import { OneDriveRestoreEngine } from "./onedrive.js";
import { quickXorHash } from "./quickxorhash.js";
import { FakeDrive } from "./testing/fake-drive.js";
import { FakeMailbox as TargetMailbox } from "./testing/fake-mailbox.js";
import {
  type JobContextFixture,
  createJobContextFixture,
  pseudoRandomBytes,
  restoreRequestFor,
} from "./testing/fixtures.js";

const NOW = new Date("2026-09-22T10:00:00Z");

describe("backup and restore round trip", () => {
  let fixture: JobContextFixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  it("puts an Exchange mailbox back into another mailbox, by meaning and byte for byte", async () => {
    const user = "alice@contoso.example";
    fixture = await createJobContextFixture({ kind: "mailbox", externalId: user, now: () => NOW });

    const source = new SourceMailbox(user);
    source.addFolder({
      id: "F-in",
      displayName: "Posteingang",
      parentFolderId: null,
      wellKnownName: "inbox",
    });
    source.addFolder({
      id: "F-sent",
      displayName: "Gesendete Elemente",
      parentFolderId: null,
      wellKnownName: "sentitems",
    });
    source.addFolder({ id: "F-proj", displayName: "Projekte / 2026", parentFolderId: "F-in" });
    source.addFolder({ id: "F-empty", displayName: "Archiv", parentFolderId: null });
    const base = {
      isRead: true,
      flagStatus: "notFlagged" as const,
      categories: [],
      hasAttachments: false,
    };
    source.addMessage({
      ...base,
      id: "M1",
      folderId: "F-in",
      subject: "Angebot",
      internetMessageId: "<m1@contoso.example>",
      isRead: false,
      flagStatus: "flagged",
      categories: ["Rot"],
    });
    source.addMessage({
      ...base,
      id: "M2",
      folderId: "F-proj",
      subject: "Kickoff",
      internetMessageId: "<m2@contoso.example>",
    });
    source.addMessage({
      ...base,
      id: "M3",
      folderId: "F-sent",
      subject: "Re: Angebot",
      internetMessageId: "<m3@contoso.example>",
    });
    const video = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const logo = new Uint8Array([9, 9, 9]);
    source.addMessage({
      ...base,
      id: "M4",
      folderId: "F-in",
      subject: "Video vom Launch",
      internetMessageId: "<m4@contoso.example>",
      hasAttachments: true,
      mimeTooLarge: true,
      attachments: [
        { id: "A1", name: "launch.mp4", contentType: "video/mp4", bytes: video },
        {
          id: "A2",
          name: "Freigabe",
          contentType: "application/octet-stream",
          bytes: new Uint8Array(),
          odataType: "#microsoft.graph.referenceAttachment",
        },
        { id: "A3", name: "logo.png", contentType: "image/png", bytes: logo, isInline: true },
      ],
    });
    source.addCalendar({ id: "cal-1", name: "Kalender", isDefaultCalendar: true });
    source.addCalendar({ id: "cal-2", name: "Team" });
    source.addEvent({
      id: "E1",
      calendarId: "cal-1",
      type: "singleInstance",
      subject: "Zahnarzt",
      iCalUId: "uid-e1",
      start: { dateTime: "2026-10-01T08:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-01T09:00:00.0000000", timeZone: "UTC" },
    });
    source.addEvent({
      id: "E2",
      calendarId: "cal-2",
      type: "singleInstance",
      subject: "Team lunch",
      start: { dateTime: "2026-10-02T12:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-10-02T13:00:00.0000000", timeZone: "UTC" },
    });
    source.addContactFolder({ id: "CF1", displayName: "Lieferanten", parentFolderId: null });
    source.addContact({
      id: "C1",
      folderId: null,
      displayName: "Bob Beispiel",
      emailAddresses: [{ address: "bob@contoso.example" }],
    });
    source.addContact({
      id: "C2",
      folderId: "CF1",
      displayName: "Carol Contact",
      emailAddresses: [{ address: "carol@supplier.example" }],
    });

    const sourceGraph = createFakeGraph(source.routes());
    const backup = await new ExchangeBackupEngine({ graph: () => sourceGraph.client() }).run(
      fixture.ctx,
      fixture.protectedObject,
      {},
    );
    expect(backup.failures).toEqual([]);

    const target = new TargetMailbox();
    const report = await new ExchangeRestoreEngine({ graph: () => target.graph.client() }).run(
      fixture.ctx,
      restoreRequestFor(
        { protectedObject: fixture.protectedObject, snapshotId: backup.snapshotId },
        { mode: "skip", target: { type: "other", ref: "bob@contoso.example" } },
      ),
    );

    expect(report.failures).toEqual([]);
    expect(report.unverified).toBe(0);
    // Four messages, two file attachments, two events, two contacts.
    expect(report.restored).toBe(10);

    const restored = (messageId: string) =>
      must(
        [...target.messages.values()].find((m) => m.internetMessageId === messageId),
        messageId,
      );
    for (const id of ["M1", "M2", "M3"]) {
      const original = must(source.messages.get(id));
      expect(restored(original.internetMessageId).mime, id).toBe(original.mime);
    }
    expect(restored("<m1@contoso.example>").parentFolderId).toBe("wk-inbox");
    expect(restored("<m1@contoso.example>").patches).toEqual([
      { isRead: false, flag: { flagStatus: "flagged" }, categories: ["Rot"], importance: "normal" },
    ]);
    expect(target.folderPath(restored("<m2@contoso.example>").parentFolderId)).toEqual([
      "Inbox",
      "Projekte / 2026",
    ]);
    expect(restored("<m3@contoso.example>").parentFolderId).toBe("wk-sentitems");
    expect([...target.folders.values()].map((f) => f.displayName)).toContain("Archiv");
    expect([...target.folders.values()].map((f) => f.displayName)).not.toContain("Posteingang");

    const big = restored("<m4@contoso.example>");
    expect(big.parentFolderId).toBe("wk-inbox");
    expect(big.attachments.map((a) => [a.name, a.contentBytes, a.isInline])).toEqual([
      ["launch.mp4", Buffer.from(video).toString("base64"), false],
      ["logo.png", Buffer.from(logo).toString("base64"), true],
    ]);
    expect(report.items.find((item) => item.id === "M4")?.reason).toMatch(
      /not re-created: Freigabe/,
    );

    const events = [...target.events.values()];
    expect(must(events.find((e) => e.body.subject === "Zahnarzt")).calendarId).toBe("cal-default");
    const lunch = must(events.find((e) => e.body.subject === "Team lunch"));
    expect(target.calendars.get(lunch.calendarId)?.name).toBe("Team");

    const contacts = [...target.contacts.values()];
    expect(must(contacts.find((c) => c.body.displayName === "Bob Beispiel")).folderId).toBeNull();
    const carol = must(contacts.find((c) => c.body.displayName === "Carol Contact"));
    expect(target.contactFolderPath(carol.folderId)).toEqual(["Lieferanten"]);
  });

  it("puts a OneDrive back byte for byte with its timestamps, notebook sections included", async () => {
    fixture = await createJobContextFixture({
      kind: "onedrive",
      externalId: DRIVE,
      now: () => NOW,
    });
    const report = Buffer.from("quarterly report, final version");
    const big = pseudoRandomBytes(6 * 1024 * 1024 + 99, 3);
    const section = Buffer.from("onenote section bytes");
    const host = "https://contoso-my.sharepoint.example/download.aspx";
    const parent = (id: string, path: string) => ({
      driveId: DRIVE,
      id,
      path: `/drive/root:${path}`,
    });
    const times = (created: string, modified: string) => ({
      fileSystemInfo: { createdDateTime: created, lastModifiedDateTime: modified },
    });
    const file = (
      id: string,
      name: string,
      bytes: Buffer,
      parentRef: object,
      modified: string,
    ) => ({
      id,
      name,
      size: bytes.length,
      cTag: `c-${id}`,
      eTag: `e-${id}`,
      file: { mimeType: "application/octet-stream", hashes: { quickXorHash: quickXorHash(bytes) } },
      "@microsoft.graph.downloadUrl": `${host}?item=${id}&tempauth=OK`,
      parentReference: parentRef,
      ...times("2025-01-01T00:00:00Z", modified),
    });
    const page = {
      value: [
        {
          id: "01ROOT",
          name: "root",
          root: {},
          folder: { childCount: 3 },
          parentReference: { driveId: DRIVE },
        },
        {
          id: "01DOCS",
          name: "Documents",
          folder: { childCount: 3 },
          parentReference: parent("01ROOT", ""),
          ...times("2024-06-01T00:00:00Z", "2025-05-05T05:05:05Z"),
        },
        {
          id: "01EMPTY",
          name: "Empty",
          folder: { childCount: 0 },
          parentReference: parent("01DOCS", "/Documents"),
        },
        file(
          "01REP",
          "report.docx",
          report,
          parent("01DOCS", "/Documents"),
          "2025-03-02T09:30:00Z",
        ),
        file("01BIG", "big.bin", big, parent("01DOCS", "/Documents"), "2025-04-01T12:00:00Z"),
        {
          id: "01NB",
          name: "Notebook",
          package: { type: "oneNote" },
          parentReference: parent("01ROOT", ""),
        },
        file("01SEC", "Section.one", section, parent("01NB", "/Notebook"), "2025-06-01T08:00:00Z"),
        {
          id: "01SC",
          name: "Team files",
          remoteItem: {
            id: "R1",
            parentReference: { driveId: "b!other" },
            folder: { childCount: 1 },
          },
          parentReference: parent("01ROOT", ""),
        },
      ],
      "@odata.deltaLink": `https://graph.microsoft.com/v1.0/drives/${DRIVE}/root/delta?token=D1`,
    };
    const sourceGraph = createFakeGraph([
      { url: deltaUrl(null), respond: { status: 200, json: page } },
      ...contentRoutes({ "01REP": report, "01BIG": big, "01SEC": section }),
    ]);
    const backup = await new OneDriveBackupEngine({ graph: async () => sourceGraph.client() }).run(
      fixture.ctx,
      fixture.protectedObject,
      {},
    );
    expect(backup.failures).toEqual([]);

    const target = new FakeDrive(DRIVE);
    const result = await new OneDriveRestoreEngine({
      graph: () => target.graph.client(),
      fragmentSize: 5 * 1024 * 1024,
    }).run(
      fixture.ctx,
      restoreRequestFor(
        { protectedObject: fixture.protectedObject, snapshotId: backup.snapshotId },
        { mode: "skip" },
      ),
    );

    expect(result.failures).toEqual([]);
    expect(result.restored).toBe(3);
    expect(result.unverified).toBe(0);
    expect(result.skipped).toBe(1);
    const byPath = new Map(target.files().map((item) => [target.pathOf(item.id), item]));
    expect(must(byPath.get("Documents/report.docx")).content.equals(report)).toBe(true);
    expect(must(byPath.get("Documents/big.bin")).content.equals(big)).toBe(true);
    expect(must(byPath.get("Notebook/Section.one")).content.equals(section)).toBe(true);
    expect(must(byPath.get("Documents/report.docx")).fileSystemInfo).toEqual({
      createdDateTime: "2025-01-01T00:00:00Z",
      lastModifiedDateTime: "2025-03-02T09:30:00Z",
    });
    expect(must(byPath.get("Documents/big.bin")).fileSystemInfo).toEqual({
      createdDateTime: "2025-01-01T00:00:00Z",
      lastModifiedDateTime: "2025-04-01T12:00:00Z",
    });
    expect(target.child(must(target.child("root", "Documents")).id, "Empty")?.kind).toBe("folder");
    expect(result.items.find((item) => item.path === "Notebook")?.reason).toMatch(
      /restored as a folder/,
    );
    expect(result.items.find((item) => item.path === "Team files")).toMatchObject({
      status: "skipped",
      code: "not_restorable",
    });
  });
});
