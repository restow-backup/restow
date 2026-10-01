import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Dek } from "../../crypto.js";
import { ChunkReader, JobAbortedError } from "../../engine/chunkstore.js";
import { Keyring } from "../../engine/keyring.js";
import {
  MemoryChunkIndex,
  MemoryCursorStore,
  MemoryProgressSink,
  MemorySnapshotIndex,
  createMemoryJobContext,
} from "../../engine/memory.js";
import { sealManifest } from "../../engine/sealed-manifest.js";
import { loadManifest } from "../../engine/snapshot.js";
import type { JobContext, ProtectedObjectRef } from "../../engine/types.js";
import { isGraphError } from "../../graph/errors.js";
import {
  type FakeGraph,
  createFakeGraph,
  graphError,
  must,
} from "../../graph/testing/fake-graph.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import {
  attachmentFactsOf,
  calendarFactsOf,
  folderSegmentsOf,
  messageFlagsOf,
  messageFormatOf,
  messageIdOf,
  referenceAttachmentsOf,
  wellKnownFolderOf,
} from "../../restore/conventions.js";
import { planRestore } from "../../restore/selection.js";
import { LocalStorageBackend } from "../../storage/local.js";
import { ExchangeBackupEngine, type ExchangeBackupEngineOptions } from "./engine.js";
import { mailObjectPath, shortId } from "./paths.js";
import { EXCHANGE_PHASES, META, MailboxAccessError } from "./run.js";
import { MAIL_SELECT_VERSION, parseCursor, readState } from "./state.js";
import { FakeMailbox, type FakeMessage } from "./testing/fake-mailbox.js";

const TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "alice@contoso.example";
const dek: Dek = { version: 1, material: Buffer.alloc(32, 0x07) };
const mailbox: ProtectedObjectRef = {
  id: "po-1",
  tenantId: TENANT,
  sourceId: "src-1",
  kind: "mailbox",
  externalId: USER,
  displayName: "Alice",
  userId: null,
};

/** Folder ids of the standard fixture mailbox. */
const F = {
  inbox: "AAMkFolderInbox",
  sent: "AAMkFolderSent",
  hidden: "AAMkFolderHidden",
  projects: "AAMkFolderProjects",
  restow: "AAMkFolderRestow",
  search: "AAMkFolderSearch",
} as const;

const ALL_MESSAGES = [
  "AAMkMsg1",
  "AAMkMsg2",
  "AAMkMsg3",
  "AAMkMsg4",
  "AAMkMsg5",
  "AAMkMsg6",
  "AAMkMsg7",
];
const MESSAGE_COUNT = ALL_MESSAGES.length;
const EVENT_COUNT = 3;
const CONTACT_COUNT = 2;
const ITEM_COUNT = MESSAGE_COUNT + EVENT_COUNT + CONTACT_COUNT;

type NewMessage = Parameters<FakeMailbox["addMessage"]>[0];

function message(
  id: string,
  folderId: string,
  subject: string,
  extra: Partial<NewMessage> = {},
): NewMessage {
  return {
    id,
    folderId,
    subject,
    internetMessageId: `<${id.toLowerCase()}@contoso.example>`,
    isRead: true,
    flagStatus: "notFlagged",
    categories: [],
    hasAttachments: false,
    ...extra,
  };
}

function standardMailbox(): FakeMailbox {
  const box = new FakeMailbox(USER);
  box.addFolder({
    id: F.inbox,
    displayName: "Inbox",
    parentFolderId: null,
    wellKnownName: "inbox",
  });
  box.addFolder({
    id: F.sent,
    displayName: "Sent Items",
    parentFolderId: null,
    wellKnownName: "sentitems",
  });
  box.addFolder({
    id: F.hidden,
    displayName: "Quick Step Settings",
    parentFolderId: null,
    isHidden: true,
  });
  box.addFolder({
    id: F.search,
    displayName: "Search Folders",
    parentFolderId: null,
    wellKnownName: "searchfolders",
  });
  box.addFolder({ id: F.projects, displayName: "Projects", parentFolderId: F.inbox });
  box.addFolder({ id: F.restow, displayName: "Restow", parentFolderId: F.projects });

  box.addMessage(
    message("AAMkMsg1", F.inbox, "Quarterly numbers", {
      categories: ["Finance"],
      hasAttachments: true,
    }),
  );
  box.addMessage(message("AAMkMsg2", F.inbox, "Lunch?", { isRead: false, flagStatus: "flagged" }));
  box.addMessage(message("AAMkMsg3", F.inbox, "Re: Lunch?", { isRead: false }));
  box.addMessage(message("AAMkMsg4", F.projects, "Kickoff / agenda"));
  box.addMessage(message("AAMkMsg5", F.restow, ""));
  box.addMessage(
    message("AAMkMsg6", F.sent, "Draft reply", { isDraft: true, bodyPreview: "First version" }),
  );
  box.addMessage(message("AAMkMsg7", F.hidden, "Quick step settings"));

  box.addCalendar({ id: "cal-default", name: "Calendar", isDefaultCalendar: true });
  box.addCalendar({ id: "cal-team", name: "Team" });
  box.addEvent({
    id: "evt-single",
    calendarId: "cal-default",
    type: "singleInstance",
    subject: "Dentist",
    iCalUId: "uid-dentist",
    changeKey: "ck-1",
    start: { dateTime: "2026-09-10T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-09-10T09:00:00.0000000", timeZone: "UTC" },
  });
  box.addEvent({
    id: "evt-master",
    calendarId: "cal-default",
    type: "seriesMaster",
    subject: "Weekly sync",
    changeKey: "ck-2",
    start: { dateTime: "2026-01-05T10:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-01-05T10:30:00.0000000", timeZone: "UTC" },
    recurrence: {
      pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
      range: { type: "endDate", startDate: "2026-01-05", endDate: "2026-12-28" },
    },
    exceptions: [
      {
        id: "evt-exc-1",
        type: "exception",
        seriesMasterId: "evt-master",
        subject: "Weekly sync (moved)",
        originalStart: "2026-09-14T10:00:00Z",
        start: { dateTime: "2026-09-14T14:00:00.0000000", timeZone: "UTC" },
      },
    ],
  });
  box.addEvent({
    id: "evt-team",
    calendarId: "cal-team",
    type: "singleInstance",
    subject: "Team lunch",
    changeKey: "ck-3",
  });

  box.addContactFolder({ id: "cf-suppliers", displayName: "Suppliers", parentFolderId: null });
  box.addContact({
    id: "ct-1",
    folderId: null,
    displayName: "Bob Example",
    changeKey: "ck-ct-1",
    emailAddresses: [{ address: "bob@contoso.example" }],
  });
  box.addContact({
    id: "ct-2",
    folderId: "cf-suppliers",
    displayName: "Carol Contact",
    changeKey: "ck-ct-2",
    emailAddresses: [{ address: "carol@supplier.example" }],
  });
  return box;
}

/** An oversized message: Graph refuses its MIME, so it is stored as JSON plus attachments. */
function bigMessage(extra: Partial<NewMessage> = {}): NewMessage {
  return message("AAMkMsgBig", F.inbox, "Video from the launch", {
    isRead: false,
    hasAttachments: true,
    mimeTooLarge: true,
    attachments: [
      {
        id: "AAMkAtt1",
        name: "launch.mp4",
        contentType: "video/mp4",
        bytes: new Uint8Array([0, 1, 2, 3]),
      },
      {
        id: "AAMkAtt2",
        name: "shared link",
        contentType: "application/octet-stream",
        bytes: new Uint8Array(),
        odataType: "#microsoft.graph.referenceAttachment",
      },
      {
        id: "AAMkAtt3",
        name: "logo.png",
        contentType: "image/png",
        bytes: new Uint8Array([9, 9, 9]),
        isInline: true,
      },
    ],
    ...extra,
  });
}

describe("ExchangeBackupEngine", () => {
  let root: string;
  let box: FakeMailbox;
  let graph: FakeGraph;
  let chunkIndex: MemoryChunkIndex;
  let snapshots: MemorySnapshotIndex;
  let cursor: MemoryCursorStore;
  let sink: MemoryProgressSink;
  let nextSnapshot: number;
  let nextPack: number;
  let engine: ExchangeBackupEngine;

  function newContext(overrides: { signal?: AbortSignal; jobId?: string } = {}): JobContext {
    sink = new MemoryProgressSink();
    return createMemoryJobContext({
      tenantId: TENANT,
      keys: new Keyring(TENANT, [dek]),
      storage: new LocalStorageBackend(root),
      chunkIndex,
      snapshots,
      cursor,
      progressSink: sink,
      jobId: overrides.jobId ?? "job-1",
      signal: overrides.signal,
      now: () => new Date("2026-09-22T10:00:00Z"),
    });
  }

  function newEngine(options: Partial<ExchangeBackupEngineOptions> = {}): ExchangeBackupEngine {
    return new ExchangeBackupEngine({
      graph: () => graph.client(),
      checkpointEveryItems: 1,
      snapshotIdGenerator: () => `snap-${nextSnapshot++}`,
      packIdGenerator: () => `pack-${nextPack++}`,
      ...options,
    });
  }

  async function manifestOf(snapshotId: string): Promise<SnapshotManifest> {
    const record = must(await snapshots.get(snapshotId));
    return loadManifest(
      { primary: new LocalStorageBackend(root), copies: [] },
      must(record.manifestPath),
      new Keyring(TENANT, [dek]),
    );
  }

  function mailObjects(manifest: SnapshotManifest): ManifestObject[] {
    return manifest.objects.filter((o) => o.type === "mail");
  }

  function byId(manifest: SnapshotManifest, id: string): ManifestObject {
    return must(
      manifest.objects.find((o) => o.id === id),
      `object ${id}`,
    );
  }

  function byPath(manifest: SnapshotManifest, path: string): ManifestObject {
    return must(
      manifest.objects.find((o) => o.path === path),
      `object at ${path}`,
    );
  }

  async function readBytes(ctx: JobContext, object: ManifestObject): Promise<Buffer> {
    const reader = new ChunkReader({ storage: ctx.storage, keys: ctx.keys, index: chunkIndex });
    return reader.readObjectToBuffer(object);
  }

  /** Message ids whose MIME was requested, in order. */
  function mimeDownloads(): string[] {
    return graph
      .callsTo("GET", "/$value")
      .map((call) => new URL(call.url).pathname.match(/messages\/([^/]+)\/\$value$/)?.[1])
      .filter((id): id is string => id !== undefined);
  }

  function reportedPhases(): string[] {
    const phases: string[] = [];
    for (const update of sink.updates) {
      const phase = update.snapshot.phase;
      if (phase !== null && phases[phases.length - 1] !== phase) {
        phases.push(phase);
      }
    }
    return phases;
  }

  function fake(id: string): FakeMessage {
    return must(box.messages.get(id), `message ${id}`);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "restow-exchange-"));
    box = standardMailbox();
    graph = createFakeGraph(box.routes());
    chunkIndex = new MemoryChunkIndex();
    snapshots = new MemorySnapshotIndex(TENANT);
    cursor = new MemoryCursorStore();
    nextSnapshot = 1;
    nextPack = 1;
    engine = newEngine();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores every message, folder, event and contact on the first run", async () => {
    const ctx = newContext();
    const result = await engine.run(ctx, mailbox, {});

    expect(result.sequence).toBe(1);
    expect(result.resumed).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.counters).toEqual({
      written: ITEM_COUNT,
      updated: 0,
      unchanged: 0,
      removed: 0,
      vanished: 0,
      failed: 0,
    });
    expect(result.objectsWritten).toBe(ITEM_COUNT);
    expect(result.bytes).toBeGreaterThan(0);
    expect(mimeDownloads().sort()).toEqual(ALL_MESSAGES);

    const manifest = await manifestOf(result.snapshotId);
    const paths = manifest.objects.map((o) => o.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "mail",
        "mail/Inbox",
        "mail/Inbox/Projects",
        "mail/Inbox/Projects/Restow",
        "mail/Quick Step Settings",
        `mail/Inbox/Quarterly numbers.${shortId("AAMkMsg1")}.eml`,
        `mail/Inbox/Projects/Kickoff ∕ agenda.${shortId("AAMkMsg4")}.eml`,
        `mail/Inbox/Projects/Restow/(no subject).${shortId("AAMkMsg5")}.eml`,
        "calendar/Calendar",
        `calendar/Calendar/Weekly sync.${shortId("evt-master")}.json`,
        "calendar/Team",
        "contacts",
        "contacts/Suppliers",
        `contacts/Suppliers/Carol Contact.${shortId("ct-2")}.json`,
      ]),
    );
    expect(paths).not.toContain("mail/Search Folders");
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT);

    const msg1 = byId(manifest, "AAMkMsg1");
    expect(msg1.type).toBe("mail");
    expect(msg1.metadata).toMatchObject({
      [META.messageId]: "<aamkmsg1@contoso.example>",
      [META.folderId]: F.inbox,
      [META.folderPath]: "Inbox",
      [META.wellKnownFolder]: "inbox",
      [META.format]: "mime",
      [META.contentType]: "message/rfc822",
      [META.fetchedInSnapshot]: "snap-1",
      [META.isRead]: "true",
      [META.flagStatus]: "notFlagged",
      [META.categories]: '["Finance"]',
      [META.importance]: "normal",
      subject: "Quarterly numbers",
      hasAttachments: "true",
    });
    expect(msg1.mtime).toBe(Date.parse(fake("AAMkMsg1").lastModifiedDateTime));
    expect((await readBytes(ctx, msg1)).toString("utf8")).toBe(fake("AAMkMsg1").mime);

    // Nested folders name the top-level folder's well-known name; hidden ones have none.
    expect(byId(manifest, "AAMkMsg5").metadata).toMatchObject({
      [META.folderPath]: "Inbox/Projects/Restow",
      [META.wellKnownFolder]: "inbox",
    });
    expect(byId(manifest, "AAMkMsg6").metadata?.[META.wellKnownFolder]).toBe("sentitems");
    expect(byId(manifest, "AAMkMsg7").metadata?.[META.folderPath]).toBe("Quick Step Settings");
    expect(byId(manifest, "AAMkMsg7").metadata?.[META.wellKnownFolder]).toBeUndefined();

    const projects = byPath(manifest, "mail/Inbox/Projects");
    expect(projects).toMatchObject({ type: "folder", id: F.projects, chunks: [] });
    expect(projects.metadata).toMatchObject({
      [META.folderPath]: "Inbox/Projects",
      [META.wellKnownFolder]: "inbox",
    });
    expect(projects.metadata?.[META.wellKnownName]).toBeUndefined();
    expect(byPath(manifest, "mail/Inbox").metadata?.[META.wellKnownName]).toBe("inbox");

    const master = byId(manifest, "evt-master");
    expect(master.type).toBe("event");
    expect(master.metadata).toMatchObject({
      [META.calendarId]: "cal-default",
      [META.calendarName]: "Calendar",
      [META.isDefaultCalendar]: "true",
      [META.folderPath]: "Calendar",
      eventType: "seriesMaster",
      exceptionCount: "1",
    });
    const stored = JSON.parse((await readBytes(ctx, master)).toString("utf8")) as {
      event: { id: string };
      exceptions: Array<{ id: string }>;
    };
    expect(stored.event.id).toBe("evt-master");
    expect(stored.exceptions.map((e) => e.id)).toEqual(["evt-exc-1"]);
    expect(byId(manifest, "evt-team").metadata).toMatchObject({
      [META.calendarName]: "Team",
      [META.isDefaultCalendar]: "false",
    });

    expect(byId(manifest, "ct-1").metadata).toMatchObject({ [META.folderPath]: "" });
    expect(byId(manifest, "ct-2")).toMatchObject({ type: "contact" });
    expect(byId(manifest, "ct-2").metadata).toMatchObject({
      [META.folderId]: "cf-suppliers",
      [META.folderPath]: "Suppliers",
      emailAddress: "carol@supplier.example",
    });

    const state = readState(manifest.state);
    expect(Object.keys(state.mailDeltaLinks).sort()).toEqual(
      [F.inbox, F.sent, F.hidden, F.projects, F.restow].sort(),
    );
    expect(state.mailFolders[F.restow]).toMatchObject({
      path: "mail/Inbox/Projects/Restow",
      displayPath: "Inbox/Projects/Restow",
      topWellKnownName: "inbox",
    });
    expect(state.mailRetry).toEqual({});
    expect(state.calendars).toEqual({
      "cal-default": "calendar/Calendar",
      "cal-team": "calendar/Team",
    });
    expect(state.contactFolders).toEqual({ "": "contacts", "cf-suppliers": "contacts/Suppliers" });

    expect(cursor.cursor).toBeNull();
    const last = must(sink.last).snapshot;
    expect(last).toMatchObject({ done: ITEM_COUNT, total: ITEM_COUNT, failed: 0, phase: "commit" });
    expect(reportedPhases()).toEqual(["folders", "mail", "calendar", "contacts", "commit"]);
    for (const phase of reportedPhases()) {
      expect(Object.values(EXCHANGE_PHASES)).toContain(phase);
    }
  });

  it("records from, to and cc with counts capped at 20, alongside the unchanged subject/date/messageId/hasAttachments", async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      emailAddress: { name: `Recipient ${i}`, address: `r${i}@contoso.example` },
    }));
    box.addMessage(
      message("AAMkMsgEnv", F.inbox, "Envelope test", {
        hasAttachments: true,
        from: { emailAddress: { name: "Dave Sender", address: "dave@contoso.example" } },
        to: many,
        cc: [{ emailAddress: { name: "Carol Cc", address: "carol@contoso.example" } }],
      }),
    );
    const result = await engine.run(newContext(), mailbox, {});
    expect(result.failures).toEqual([]);

    const manifest = await manifestOf(result.snapshotId);
    const object = byId(manifest, "AAMkMsgEnv");
    expect(object.metadata?.[META.from]).toBe("Dave Sender <dave@contoso.example>");
    const expectedTo = many
      .slice(0, 20)
      .map((r) => `${r.emailAddress.name} <${r.emailAddress.address}>`)
      .join(", ");
    expect(object.metadata?.[META.to]).toBe(expectedTo);
    expect(object.metadata?.[META.toCount]).toBe("25");
    expect(object.metadata?.[META.cc]).toBe("Carol Cc <carol@contoso.example>");
    expect(object.metadata?.[META.ccCount]).toBe("1");

    // Regression: this item must not change these.
    expect(object.metadata?.[META.subject]).toBe("Envelope test");
    expect(object.metadata?.receivedDateTime).toBe(fake("AAMkMsgEnv").receivedDateTime);
    expect(object.metadata?.[META.messageId]).toBe("<aamkmsgenv@contoso.example>");
    expect(object.metadata?.[META.hasAttachments]).toBe("true");
  });

  it("flags rights-protected and S/MIME-encrypted messages from the top-level Content-Type, leaving a signed-only S/MIME message unflagged", async () => {
    const withContentType = (contentType: string, id: string, subject: string): string =>
      [
        "From: Alice Example <alice@contoso.example>",
        "To: Bob Example <bob@contoso.example>",
        `Subject: ${subject}`,
        "Date: Tue, 1 Sep 2026 10:15:00 +0200",
        `Message-ID: <${id.toLowerCase()}@contoso.example>`,
        "MIME-Version: 1.0",
        `Content-Type: ${contentType}`,
        "",
        "opaque-bytes",
        "",
      ].join("\r\n");
    box.addMessage(
      message("AAMkMsgRpmsg", F.inbox, "Protected", {
        mime: withContentType("application/x-microsoft-rpmsg-message", "AAMkMsgRpmsg", "Protected"),
      }),
    );
    box.addMessage(
      message("AAMkMsgSmime", F.inbox, "Encrypted", {
        mime: withContentType(
          'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
          "AAMkMsgSmime",
          "Encrypted",
        ),
      }),
    );
    box.addMessage(
      message("AAMkMsgSigned", F.inbox, "Signed", {
        mime: withContentType(
          'multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256',
          "AAMkMsgSigned",
          "Signed",
        ),
      }),
    );
    box.addMessage(
      message("AAMkMsgSignedOpaque", F.inbox, "Signed opaque", {
        // RFC 8551 3.5.2 opaque signing: same smime.p7m name as enveloped (encrypted)
        // data conventionally uses, but smime-type says signed-data, not encrypted.
        mime: withContentType(
          'application/pkcs7-mime; smime-type=signed-data; name="smime.p7m"',
          "AAMkMsgSignedOpaque",
          "Signed opaque",
        ),
      }),
    );

    const first = await engine.run(newContext(), mailbox, {});
    expect(first.failures).toEqual([]);
    const firstManifest = await manifestOf(first.snapshotId);
    expect(byId(firstManifest, "AAMkMsgRpmsg").metadata?.[META.protection]).toBe(
      "rights-protected",
    );
    expect(byId(firstManifest, "AAMkMsgSmime").metadata?.[META.protection]).toBe("smime-encrypted");
    expect(byId(firstManifest, "AAMkMsgSigned").metadata?.[META.protection]).toBeUndefined();
    expect(byId(firstManifest, "AAMkMsgSignedOpaque").metadata?.[META.protection]).toBeUndefined();

    // A flag-only change carries the content forward: protection is copied, not re-detected.
    box.updateMessage("AAMkMsgSmime", { isRead: true });
    graph.calls.length = 0;
    const second = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    expect(mimeDownloads()).not.toContain("AAMkMsgSmime");
    const manifest = await manifestOf(second.snapshotId);
    const carried = byId(manifest, "AAMkMsgSmime");
    expect(carried.metadata?.[META.protection]).toBe("smime-encrypted");
    expect(carried.metadata?.[META.fetchedInSnapshot]).toBe("snap-1");
  });

  it("detects protection from internetMessageHeaders in the oversized-message JSON fallback", async () => {
    box.addMessage(
      bigMessage({
        internetMessageHeaders: [
          {
            name: "Content-Type",
            value: 'application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
          },
        ],
      }),
    );
    const result = await engine.run(newContext(), mailbox, {});
    expect(result.failures).toEqual([]);
    const manifest = await manifestOf(result.snapshotId);
    expect(byId(manifest, "AAMkMsgBig").metadata?.[META.protection]).toBe("smime-encrypted");
  });

  it("flags rights-protected mail exported as an ordinary multipart/mixed Content-Class: rpmsg.message", async () => {
    // A real IRM/Purview export rarely uses the top-level rpmsg Content-Type; the client
    // marks it with Content-Class instead and wraps the protected part as an attachment.
    const mime = [
      "From: Alice Example <alice@contoso.example>",
      "To: Bob Example <bob@contoso.example>",
      "Subject: Confidential",
      "Date: Tue, 1 Sep 2026 10:15:00 +0200",
      "Message-ID: <aamkmsgrpmsgclass@contoso.example>",
      "MIME-Version: 1.0",
      "Content-Class: rpmsg.message",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain",
      "",
      "This message is protected; open the attachment to view it.",
      "--b1",
      'Content-Type: application/octet-stream; name="message.rpmsg"',
      "Content-Disposition: attachment; filename=message.rpmsg",
      "",
      "opaque-bytes",
      "--b1--",
      "",
    ].join("\r\n");
    box.addMessage(message("AAMkMsgRpmsgClass", F.inbox, "Confidential", { mime }));

    const result = await engine.run(newContext(), mailbox, {});
    expect(result.failures).toEqual([]);
    const manifest = await manifestOf(result.snapshotId);
    expect(byId(manifest, "AAMkMsgRpmsgClass").metadata?.[META.protection]).toBe(
      "rights-protected",
    );
  });

  it("flags rights-protected from Content-Class in the oversized-message JSON fallback", async () => {
    box.addMessage(
      bigMessage({
        internetMessageHeaders: [{ name: "Content-Class", value: "rpmsg.message" }],
      }),
    );
    const result = await engine.run(newContext(), mailbox, {});
    expect(result.failures).toEqual([]);
    const manifest = await manifestOf(result.snapshotId);
    expect(byId(manifest, "AAMkMsgBig").metadata?.[META.protection]).toBe("rights-protected");
  });

  it("quotes a display name that contains a comma so from/to/cc still split unambiguously", async () => {
    box.addMessage(
      message("AAMkMsgComma", F.inbox, "Directory names", {
        from: { emailAddress: { name: "Flores, Lucas", address: "lucas@contoso.example" } },
        to: [{ emailAddress: { name: "Doe, John", address: "john@contoso.example" } }],
      }),
    );
    const result = await engine.run(newContext(), mailbox, {});
    expect(result.failures).toEqual([]);
    const manifest = await manifestOf(result.snapshotId);
    const object = byId(manifest, "AAMkMsgComma");
    expect(object.metadata?.[META.from]).toBe('"Flores, Lucas" <lucas@contoso.example>');
    expect(object.metadata?.[META.to]).toBe('"Doe, John" <john@contoso.example>');
  });

  it("recovers from/to/cc after an upgrade whose stored delta links still carry the old $select", async () => {
    const first = await engine.run(newContext(), mailbox, {});
    const manifest1 = await manifestOf(first.snapshotId);
    const state1 = readState(manifest1.state);

    // The $select Graph used to build these links before this item added from/to/cc.
    const oldSelect = [
      "id",
      "internetMessageId",
      "subject",
      "receivedDateTime",
      "lastModifiedDateTime",
      "isRead",
      "flag",
      "categories",
      "hasAttachments",
      "parentFolderId",
      "isDraft",
      "bodyPreview",
      "importance",
    ].join(",");
    // Graph replays a stored delta link's own `$select` verbatim (docs/MICROSOFT.md), so an
    // upgraded installation is still carrying links built before from/to/cc existed.
    const staleLinks = Object.fromEntries(
      Object.entries(state1.mailDeltaLinks).map(([id, link]) => [
        id,
        link.replace(/\$select=[^&]+/, `$select=${oldSelect}`),
      ]),
    );
    // Pre-upgrade installations never recorded from/to/cc either.
    const downgradedObjects = manifest1.objects.map((object) => {
      if (object.type !== "mail") {
        return object;
      }
      const metadata = { ...object.metadata };
      delete metadata[META.from];
      delete metadata[META.to];
      delete metadata[META.toCount];
      delete metadata[META.cc];
      delete metadata[META.ccCount];
      return { ...object, metadata };
    });
    const record = must(await snapshots.get(first.snapshotId));
    const storage = new LocalStorageBackend(root);
    await storage.put(
      must(record.manifestPath),
      await sealManifest(
        {
          ...manifest1,
          objects: downgradedObjects,
          state: {
            exchange: {
              version: state1.version,
              // mailSelectVersion intentionally omitted: pre-upgrade manifests never had it.
              mailDeltaLinks: staleLinks,
              mailFolders: state1.mailFolders,
              mailRetry: state1.mailRetry,
              calendars: state1.calendars,
              contactFolders: state1.contactFolders,
            },
          },
        },
        dek,
        must(record.manifestPath),
      ),
    );

    box.addMessage(
      message("AAMkMsgNew", F.inbox, "New after upgrade", {
        from: { emailAddress: { name: "Eve New", address: "eve@contoso.example" } },
        to: [{ emailAddress: { name: "Alice", address: USER } }],
      }),
    );
    graph.calls.length = 0;

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    expect(result.failures).toEqual([]);
    const manifest2 = await manifestOf(result.snapshotId);

    // The stale link is replayed only long enough to be recognised and dropped: the run
    // enumerates from scratch with the current $select, so the new message gets from/to
    // despite arriving through what would otherwise still be the old link.
    expect(byId(manifest2, "AAMkMsgNew").metadata?.[META.from]).toBe(
      "Eve New <eve@contoso.example>",
    );
    expect(byId(manifest2, "AAMkMsgNew").metadata?.[META.to]).toBe("Alice <alice@contoso.example>");
    // Every other, untouched message is carried forward without its MIME being re-fetched.
    expect(mimeDownloads()).toEqual(["AAMkMsgNew"]);
    expect(byId(manifest2, "AAMkMsgNew").metadata?.[META.toCount]).toBe("1");

    // The state now carries the current mail-select version, so a later run does not reset again.
    const state2 = readState(manifest2.state);
    expect(state2.mailSelectVersion).toBe(MAIL_SELECT_VERSION);
  });

  it("stores only changes on the second run and never re-fetches MIME for a flag change", async () => {
    const first = await engine.run(newContext(), mailbox, {});
    const msg2Before = byId(await manifestOf(first.snapshotId), "AAMkMsg2");
    graph.calls.length = 0;

    box.updateMessage("AAMkMsg2", {
      isRead: true,
      flagStatus: "complete",
      categories: ["Personal"],
    });
    box.updateMessage("AAMkMsg3", { importance: "high" });
    box.deleteMessage("AAMkMsg1");
    box.addMessage(message("AAMkMsg8", F.projects, "New in projects", { isRead: false }));
    box.updateMessage("AAMkMsg6", { subject: "Draft reply v2", bodyPreview: "Second version" });
    box.updateEvent("evt-single", { subject: "Dentist (moved)" });
    box.updateContact("ct-1", { displayName: "Bob Example Jr." });

    const ctx = newContext({ jobId: "job-2" });
    const result = await engine.run(ctx, mailbox, {});

    expect(result.sequence).toBe(2);
    expect(mimeDownloads().sort()).toEqual(["AAMkMsg6", "AAMkMsg8"]);
    expect(result.counters).toEqual({
      written: 4,
      updated: 2,
      unchanged: 3,
      removed: 1,
      vanished: 0,
      failed: 0,
    });
    expect(result.objectsWritten).toBe(6);

    const manifest = await manifestOf(result.snapshotId);
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT);
    expect(manifest.objects.find((o) => o.id === "AAMkMsg1")).toBeUndefined();

    const msg2 = byId(manifest, "AAMkMsg2");
    expect(msg2.chunks).toEqual(msg2Before.chunks);
    expect(msg2.sha256).toBe(msg2Before.sha256);
    expect(msg2.metadata).toMatchObject({
      [META.isRead]: "true",
      [META.flagStatus]: "complete",
      [META.categories]: '["Personal"]',
      [META.fetchedInSnapshot]: "snap-1",
    });
    expect(msg2.mtime).toBeGreaterThan(msg2Before.mtime);
    expect(byId(manifest, "AAMkMsg3").metadata).toMatchObject({
      [META.importance]: "high",
      [META.fetchedInSnapshot]: "snap-1",
    });

    const draft = byId(manifest, "AAMkMsg6");
    expect(draft.path).toBe(`mail/Sent Items/Draft reply v2.${shortId("AAMkMsg6")}.eml`);
    expect(draft.metadata?.[META.fetchedInSnapshot]).toBe("snap-2");
    expect(manifest.objects.filter((o) => o.id === "AAMkMsg6")).toHaveLength(1);

    // Delta links were used: no folder was enumerated from scratch.
    const deltaCalls = graph.callsTo("GET", "/messages/delta");
    expect(deltaCalls.every((c) => new URL(c.url).searchParams.has("$deltatoken"))).toBe(true);
    expect(byId(manifest, "evt-single").metadata?.subject).toBe("Dentist (moved)");
    expect(byId(manifest, "evt-master").metadata?.[META.fetchedInSnapshot]).toBe("snap-1");
    expect(byId(manifest, "ct-1").metadata?.displayName).toBe("Bob Example Jr.");
    expect(byId(manifest, "ct-2").metadata?.[META.fetchedInSnapshot]).toBe("snap-1");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("resyncs only the folder whose delta token is gone", async () => {
    await engine.run(newContext(), mailbox, {});
    box.deleteMessage("AAMkMsg3");
    box.invalidateDelta(F.inbox);
    graph.calls.length = 0;

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});

    const inboxCalls = graph
      .callsTo("GET", `/mailFolders/${F.inbox}/messages/delta`)
      .map((c) => new URL(c.url).searchParams);
    expect(inboxCalls.length).toBeGreaterThanOrEqual(2);
    expect(must(inboxCalls[0]).has("$deltatoken")).toBe(true);
    expect(must(inboxCalls[1]).has("$deltatoken")).toBe(false);
    expect(must(inboxCalls[1]).has("$skiptoken")).toBe(false);
    for (const folderId of [F.sent, F.projects, F.restow, F.hidden]) {
      const calls = graph.callsTo("GET", `/mailFolders/${folderId}/messages/delta`);
      expect(calls).toHaveLength(1);
      expect(new URL(must(calls[0]).url).searchParams.has("$deltatoken")).toBe(true);
    }
    // The re-enumeration recognised the stored messages by their fingerprint.
    expect(mimeDownloads()).toEqual([]);
    expect(reportedPhases()).toContain("resync");
    const manifest = await manifestOf(result.snapshotId);
    expect(manifest.objects.find((o) => o.id === "AAMkMsg3")).toBeUndefined();
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT - 1);
    expect(result.counters.removed).toBe(1);
    expect(readState(manifest.state).mailDeltaLinks[F.inbox]).toContain("$deltatoken=");
  });

  it("resumes from the cursor after an abort between folders without fetching anything twice", async () => {
    // Cancel as soon as the second folder's delta page is served: the Inbox is
    // complete and checkpointed, the Sent Items entries are never processed.
    const controller = new AbortController();
    box.intercept = (call) => {
      if (call.url.includes(`/mailFolders/${F.sent}/messages/delta`)) {
        controller.abort();
      }
      return undefined;
    };
    await expect(
      engine.run(newContext({ signal: controller.signal }), mailbox, {}),
    ).rejects.toBeInstanceOf(JobAbortedError);

    const downloadedFirst = mimeDownloads();
    expect(downloadedFirst).toEqual(["AAMkMsg1", "AAMkMsg2", "AAMkMsg3"]);
    const saved = parseCursor(cursor.cursor);
    expect(saved.checkpoint?.snapshotId).toBe("snap-1");
    expect(saved.checkpoint?.objectCount).toBeGreaterThanOrEqual(3);
    expect(saved.progress.completedFolders).toEqual([F.inbox]);
    expect(saved.deltaTokens[F.inbox]).toContain("$deltatoken=");
    expect(cursor.cursor?.folderId).toBe(F.sent);
    expect((await snapshots.get("snap-1"))?.manifestPath).toBeNull();

    box.intercept = undefined;
    graph.calls.length = 0;
    const ctx = newContext({ jobId: "job-1" });
    const result = await engine.run(ctx, mailbox, {});

    expect(result.resumed).toBe(true);
    expect(result.snapshotId).toBe("snap-1");
    expect(result.sequence).toBe(1);
    const downloadedSecond = mimeDownloads();
    expect(downloadedSecond.some((id) => downloadedFirst.includes(id))).toBe(false);
    expect([...downloadedFirst, ...downloadedSecond].sort()).toEqual(ALL_MESSAGES);
    // The finished Inbox is not even enumerated again.
    expect(graph.callsTo("GET", `/mailFolders/${F.inbox}/messages/delta`)).toHaveLength(0);

    const manifest = await manifestOf(result.snapshotId);
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT);
    expect(new Set(mailObjects(manifest).map((o) => o.id)).size).toBe(MESSAGE_COUNT);
    expect(manifest.objects.filter((o) => o.type === "event")).toHaveLength(EVENT_COUNT);
    expect(manifest.objects.filter((o) => o.type === "contact")).toHaveLength(CONTACT_COUNT);
    expect(cursor.cursor).toBeNull();
    expect(await ctx.storage.primary.list(`tenants/${TENANT}/manifests/`)).toEqual([
      `tenants/${TENANT}/manifests/snap-1.json.zst`,
    ]);
    for (const object of manifest.objects) {
      for (const hex of object.chunks) {
        expect(chunkIndex.chunks.get(hex)?.refcount).toBe(1);
      }
    }
  });

  it("resumes inside a folder without fetching the messages it already stored", async () => {
    const controller = new AbortController();
    box.intercept = (call) => {
      if (call.url.includes("/messages/AAMkMsg2/$value")) {
        controller.abort();
      }
      return undefined;
    };
    await expect(
      engine.run(newContext({ signal: controller.signal }), mailbox, {}),
    ).rejects.toBeInstanceOf(JobAbortedError);

    expect(mimeDownloads()).toEqual(["AAMkMsg1", "AAMkMsg2"]);
    const saved = parseCursor(cursor.cursor);
    expect(saved.progress.completedFolders).toEqual([]);
    expect(cursor.cursor).toMatchObject({ folderId: F.inbox, lastItemId: "AAMkMsg1" });

    box.intercept = undefined;
    graph.calls.length = 0;
    const result = await engine.run(newContext({ jobId: "job-1" }), mailbox, {});

    expect(result.resumed).toBe(true);
    const downloadedSecond = mimeDownloads();
    expect(downloadedSecond).not.toContain("AAMkMsg1");
    expect(downloadedSecond.sort()).toEqual(ALL_MESSAGES.filter((id) => id !== "AAMkMsg1"));
    expect(result.counters).toMatchObject({ written: ITEM_COUNT - 1, unchanged: 1, failed: 0 });
    const manifest = await manifestOf(result.snapshotId);
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT);
    expect(byId(manifest, "AAMkMsg1").metadata?.[META.fetchedInSnapshot]).toBe("snap-1");
  });

  it("records item failures, rides out a 429, treats deleted items as vanished and retries failures next run", async () => {
    const waits: number[] = [];
    engine = newEngine({
      graph: () => graph.client({ onThrottle: (info) => waits.push(info.waitMs) }),
    });
    fake("AAMkMsg2").mimeResponses = [
      { status: 429, headers: { "Retry-After": "3" }, json: graphError("ApplicationThrottled") },
    ];
    fake("AAMkMsg4").mimeResponses = [
      { status: 500, json: graphError("ErrorInternalServerError", "Something went wrong.") },
    ];
    // The user deletes a message between the delta listing and the download.
    box.intercept = (call) => {
      if (call.url.includes("/messages/AAMkMsg5/$value") && box.messages.has("AAMkMsg5")) {
        box.deleteMessage("AAMkMsg5");
      }
      return undefined;
    };

    const result = await engine.run(newContext(), mailbox, {});

    expect(waits).toEqual([3000]);
    const failedRef = mailObjectPath("mail/Inbox/Projects", "Kickoff / agenda", "AAMkMsg4");
    expect(result.failures).toEqual([
      {
        itemRef: failedRef,
        reason: expect.stringContaining("Graph 500 ErrorInternalServerError"),
        cause: expect.objectContaining({
          code: "graph.service_unavailable",
          transient: true,
          technical: expect.objectContaining({
            httpStatus: 500,
            errorCode: "ErrorInternalServerError",
          }),
        }),
      },
    ]);
    expect(result.counters).toMatchObject({ failed: 1, vanished: 1, written: ITEM_COUNT - 2 });
    expect(sink.failures.map((f) => f.itemRef)).toEqual([failedRef]);
    const manifest = await manifestOf(result.snapshotId);
    expect(manifest.objects.find((o) => o.id === "AAMkMsg4")).toBeUndefined();
    expect(manifest.objects.find((o) => o.id === "AAMkMsg5")).toBeUndefined();
    expect(byId(manifest, "AAMkMsg2").sha256).toBeDefined();
    expect(readState(manifest.state).mailRetry).toEqual({ [F.projects]: ["AAMkMsg4"] });
    const progress = must(sink.last).snapshot;
    expect(progress.failed).toBe(1);
    expect(progress.done + progress.failed).toBe(progress.total);

    // The delta has moved past the failed message; the next run fetches it by id.
    box.intercept = undefined;
    graph.calls.length = 0;
    const second = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});

    expect(second.failures).toEqual([]);
    expect(mimeDownloads()).toEqual(["AAMkMsg4"]);
    expect(
      graph.calls.filter((c) => new URL(c.url).pathname.endsWith("/messages/AAMkMsg4")),
    ).toHaveLength(1);
    const manifest2 = await manifestOf(second.snapshotId);
    expect(byId(manifest2, "AAMkMsg4").path).toBe(failedRef);
    expect(mailObjects(manifest2)).toHaveLength(MESSAGE_COUNT - 1);
    expect(readState(manifest2.state).mailRetry).toEqual({});
  });

  it("fails the run resumably when throttling outlasts the client's retries", async () => {
    fake("AAMkMsg4").mimeResponses = Array.from({ length: 6 }, () => ({
      status: 429,
      headers: { "Retry-After": "1" },
      json: graphError("ApplicationThrottled"),
    }));

    const error = await engine.run(newContext(), mailbox, {}).catch((e: unknown) => e);
    expect(isGraphError(error) && error.status).toBe(429);
    // Not a flood of item failures: the job is retried and resumes.
    expect(sink.failures).toEqual([]);
    const saved = parseCursor(cursor.cursor);
    expect(saved.progress.completedFolders).toEqual([F.inbox, F.sent, F.hidden]);

    graph.calls.length = 0;
    const result = await engine.run(newContext({ jobId: "job-1" }), mailbox, {});
    expect(result.resumed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(mimeDownloads()).toEqual(["AAMkMsg4", "AAMkMsg5"]);
    expect(mailObjects(await manifestOf(result.snapshotId))).toHaveLength(MESSAGE_COUNT);
  });

  it("stores an oversized message as JSON with its attachments and keeps them together", async () => {
    box.addMessage(bigMessage());
    const ctx = newContext();
    const result = await engine.run(ctx, mailbox, {});
    expect(result.counters.written).toBe(ITEM_COUNT + 1);
    const manifest = await manifestOf(result.snapshotId);

    const big = byId(manifest, "AAMkMsgBig");
    const bigPath = `mail/Inbox/Video from the launch.${shortId("AAMkMsgBig")}.json`;
    const attachmentsFolder = `mail/Inbox/Video from the launch.${shortId("AAMkMsgBig")}.attachments`;
    expect(big.path).toBe(bigPath);
    expect(big.metadata).toMatchObject({
      [META.format]: "json",
      [META.contentType]: "application/json",
      [META.attachmentCount]: "2",
      [META.referenceAttachments]: '["shared link"]',
      [META.folderPath]: "Inbox",
    });
    const json = JSON.parse((await readBytes(ctx, big)).toString("utf8")) as {
      body: { content: string };
    };
    expect(json.body.content).toBe("Body of Video from the launch");

    expect(byPath(manifest, attachmentsFolder).type).toBe("folder");
    const video = byId(manifest, "AAMkMsgBig/AAMkAtt1");
    expect(video).toMatchObject({
      type: "attachment",
      path: `${attachmentsFolder}/launch.mp4.${shortId("AAMkAtt1")}`,
    });
    expect(video.metadata).toMatchObject({
      [META.messageItemId]: "AAMkMsgBig",
      [META.messagePath]: bigPath,
      [META.name]: "launch.mp4",
      [META.contentType]: "video/mp4",
      [META.isInline]: "false",
    });
    expect(await readBytes(ctx, video)).toEqual(Buffer.from([0, 1, 2, 3]));
    expect(byId(manifest, "AAMkMsgBig/AAMkAtt3").metadata).toMatchObject({
      [META.isInline]: "true",
      [META.contentType]: "image/png",
    });
    // A link attachment has no content Graph v1.0 exposes; it is named on the message instead.
    expect(manifest.objects.find((o) => o.id === "AAMkMsgBig/AAMkAtt2")).toBeUndefined();

    // A flag change keeps the attachments and touches only the message's metadata.
    box.updateMessage("AAMkMsgBig", { isRead: true });
    graph.calls.length = 0;
    const second = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    expect(mimeDownloads()).toEqual([]);
    expect(graph.callsTo("GET", "/attachments")).toHaveLength(0);
    const manifest2 = await manifestOf(second.snapshotId);
    expect(byId(manifest2, "AAMkMsgBig").metadata).toMatchObject({
      [META.isRead]: "true",
      [META.format]: "json",
      [META.attachmentCount]: "2",
    });
    expect(byId(manifest2, "AAMkMsgBig/AAMkAtt1")).toEqual(video);
    expect(second.counters).toMatchObject({ written: 0, updated: 1 });

    // A new version whose attachment disappears mid-download is not recorded
    // half: the previous version stays complete and the message is retried.
    box.updateMessage("AAMkMsgBig", { subject: "Launch video (final)" });
    box.intercept = (call) =>
      call.url.includes("/attachments/AAMkAtt3/$value")
        ? { status: 404, json: graphError("ErrorItemNotFound") }
        : undefined;
    const third = await engine.run(newContext({ jobId: "job-3" }), mailbox, {});
    expect(third.failures).toEqual([
      {
        itemRef: mailObjectPath("mail/Inbox", "Launch video (final)", "AAMkMsgBig"),
        reason: expect.stringContaining("ItemError"),
        cause: expect.objectContaining({ code: "graph.item_not_found", transient: true }),
      },
    ]);
    const manifest3 = await manifestOf(third.snapshotId);
    expect(byId(manifest3, "AAMkMsgBig")).toMatchObject({ path: bigPath, sha256: big.sha256 });
    expect(byId(manifest3, "AAMkMsgBig/AAMkAtt1")).toEqual(video);
    // Message, two attachments and their folder: exactly what the previous version had.
    expect(manifest3.objects.filter((o) => o.id?.startsWith("AAMkMsgBig"))).toHaveLength(4);

    box.intercept = undefined;
    const fourth = await engine.run(newContext({ jobId: "job-4" }), mailbox, {});
    expect(fourth.failures).toEqual([]);
    const manifest4 = await manifestOf(fourth.snapshotId);
    const renamed = byId(manifest4, "AAMkMsgBig");
    const renamedFolder = `mail/Inbox/Launch video (final).${shortId("AAMkMsgBig")}.attachments`;
    expect(renamed.path).toBe(`mail/Inbox/Launch video (final).${shortId("AAMkMsgBig")}.json`);
    expect(byId(manifest4, "AAMkMsgBig/AAMkAtt1")).toMatchObject({
      path: `${renamedFolder}/launch.mp4.${shortId("AAMkAtt1")}`,
      chunks: video.chunks,
    });
    expect(byId(manifest4, "AAMkMsgBig/AAMkAtt1").metadata?.[META.messagePath]).toBe(renamed.path);
    expect(manifest4.objects.filter((o) => o.path.startsWith(attachmentsFolder))).toEqual([]);

    // A folder rename moves the message and its attachments together.
    box.renameFolder(F.inbox, "Posteingang");
    graph.calls.length = 0;
    const fifth = await engine.run(newContext({ jobId: "job-5" }), mailbox, {});
    expect(mimeDownloads()).toEqual([]);
    const manifest5 = await manifestOf(fifth.snapshotId);
    const movedMessage = `mail/Posteingang/Launch video (final).${shortId("AAMkMsgBig")}.json`;
    const movedFolder = `mail/Posteingang/Launch video (final).${shortId("AAMkMsgBig")}.attachments`;
    expect(byId(manifest5, "AAMkMsgBig").path).toBe(movedMessage);
    expect(byId(manifest5, "AAMkMsgBig/AAMkAtt1")).toMatchObject({
      path: `${movedFolder}/launch.mp4.${shortId("AAMkAtt1")}`,
    });
    expect(byId(manifest5, "AAMkMsgBig/AAMkAtt1").metadata).toMatchObject({
      [META.messagePath]: movedMessage,
      [META.folderPath]: "Posteingang",
      [META.wellKnownFolder]: "inbox",
    });
    expect(byPath(manifest5, movedFolder).type).toBe("folder");
    expect(manifest5.objects.filter((o) => o.path.startsWith("mail/Inbox"))).toEqual([]);

    // Deleting the message takes its attachments along.
    box.deleteMessage("AAMkMsgBig");
    const sixth = await engine.run(newContext({ jobId: "job-6" }), mailbox, {});
    const manifest6 = await manifestOf(sixth.snapshotId);
    expect(manifest6.objects.filter((o) => o.id?.startsWith("AAMkMsgBig"))).toEqual([]);
    expect(manifest6.objects.filter((o) => o.path.startsWith(movedFolder))).toEqual([]);
    expect(sixth.counters.removed).toBe(1);
  });

  it("re-paths the objects of a renamed folder and drops those of a deleted folder", async () => {
    const first = await engine.run(newContext(), mailbox, {});
    const before = byId(await manifestOf(first.snapshotId), "AAMkMsg5");
    box.renameFolder(F.projects, "Projects 2026");
    box.deleteFolder(F.hidden);
    graph.calls.length = 0;

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    const manifest = await manifestOf(result.snapshotId);

    expect(mimeDownloads()).toEqual([]);
    const paths = manifest.objects.map((o) => o.path);
    expect(paths).toContain("mail/Inbox/Projects 2026");
    expect(paths).toContain("mail/Inbox/Projects 2026/Restow");
    expect(paths).not.toContain("mail/Inbox/Projects");
    expect(paths).not.toContain("mail/Quick Step Settings");
    expect(manifest.objects.find((o) => o.id === "AAMkMsg7")).toBeUndefined();
    const msg5 = byId(manifest, "AAMkMsg5");
    expect(msg5.path).toBe(
      `mail/Inbox/Projects 2026/Restow/(no subject).${shortId("AAMkMsg5")}.eml`,
    );
    expect(msg5.chunks).toEqual(before.chunks);
    expect(msg5.metadata?.[META.folderPath]).toBe("Inbox/Projects 2026/Restow");
    expect(byId(manifest, "AAMkMsg4").path).toBe(
      `mail/Inbox/Projects 2026/Kickoff ∕ agenda.${shortId("AAMkMsg4")}.eml`,
    );
    expect(result.counters).toMatchObject({ updated: 2, removed: 1 });
    const state = readState(manifest.state);
    expect(state.mailFolders[F.hidden]).toBeUndefined();
    expect(state.mailDeltaLinks[F.hidden]).toBeUndefined();
    expect(state.mailFolders[F.projects]?.path).toBe("mail/Inbox/Projects 2026");
  });

  it("re-homes the objects of a folder moved below another top-level folder", async () => {
    await engine.run(newContext(), mailbox, {});
    must(box.folders.get(F.projects)).parentFolderId = F.sent;

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    const manifest = await manifestOf(result.snapshotId);

    expect(byId(manifest, "AAMkMsg5").metadata).toMatchObject({
      [META.folderPath]: "Sent Items/Projects/Restow",
      [META.wellKnownFolder]: "sentitems",
    });
    expect(byId(manifest, "AAMkMsg4").path).toBe(
      `mail/Sent Items/Projects/Kickoff ∕ agenda.${shortId("AAMkMsg4")}.eml`,
    );
    expect(byPath(manifest, "mail/Sent Items/Projects/Restow").metadata).toMatchObject({
      [META.wellKnownFolder]: "sentitems",
    });
  });

  it("drops a folder deleted between the tree listing and its enumeration without a failure", async () => {
    await engine.run(newContext(), mailbox, {});
    box.intercept = (call) => {
      if (
        call.url.includes(`/mailFolders/${F.restow}/messages/delta`) &&
        box.folders.has(F.restow)
      ) {
        box.deleteFolder(F.restow);
      }
      return undefined;
    };

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    const manifest = await manifestOf(result.snapshotId);

    expect(result.failures).toEqual([]);
    expect(result.counters.removed).toBe(1);
    expect(manifest.objects.filter((o) => o.path.startsWith("mail/Inbox/Projects/Restow"))).toEqual(
      [],
    );
    expect(readState(manifest.state).mailFolders[F.restow]).toBeUndefined();
    expect(readState(manifest.state).mailDeltaLinks[F.restow]).toBeUndefined();
  });

  it("starts over from a full enumeration when the stored state is unreadable", async () => {
    const first = await engine.run(newContext(), mailbox, {});
    // Replace the committed manifest's state with one from an unknown future version.
    const record = must(await snapshots.get(first.snapshotId));
    const storage = new LocalStorageBackend(root);
    const manifest1 = await manifestOf(first.snapshotId);
    await storage.put(
      must(record.manifestPath),
      await sealManifest(
        { ...manifest1, state: { exchange: { version: 99 } } },
        dek,
        must(record.manifestPath),
      ),
    );
    box.deleteFolder(F.hidden);
    graph.calls.length = 0;

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    const manifest = await manifestOf(result.snapshotId);

    expect(
      graph
        .callsTo("GET", "/messages/delta")
        .every((c) => !new URL(c.url).searchParams.has("$deltatoken")),
    ).toBe(true);
    // Every stored message is recognised by its fingerprint: nothing is downloaded again.
    expect(mimeDownloads()).toEqual([]);
    expect(manifest.objects.filter((o) => o.path.startsWith("mail/Quick Step Settings"))).toEqual(
      [],
    );
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT - 1);
    expect(Object.keys(readState(manifest.state).mailDeltaLinks)).toHaveLength(4);
  });

  it("handles a message moved between folders as a removal plus a new item", async () => {
    await engine.run(newContext(), mailbox, {});
    box.moveMessage("AAMkMsg2", F.projects, "AAMkMsg2Moved");
    graph.calls.length = 0;

    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, {});
    const manifest = await manifestOf(result.snapshotId);

    expect(mimeDownloads()).toEqual(["AAMkMsg2Moved"]);
    expect(manifest.objects.find((o) => o.id === "AAMkMsg2")).toBeUndefined();
    expect(byId(manifest, "AAMkMsg2Moved").path).toBe(
      `mail/Inbox/Projects/Lunch?.${shortId("AAMkMsg2Moved")}.eml`,
    );
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT);
    // The bytes are the same, so the chunk store did not grow.
    expect(result.bytes).toBe(0);
  });

  it("writes manifests the restore engine reads correctly", async () => {
    box.addMessage(bigMessage());
    const result = await engine.run(newContext(), mailbox, {});
    const manifest = await manifestOf(result.snapshotId);

    const kickoff = byId(manifest, "AAMkMsg4");
    expect(folderSegmentsOf(kickoff)).toEqual(["Inbox", "Projects"]);
    expect(wellKnownFolderOf(kickoff)).toBe("inbox");
    expect(messageFormatOf(kickoff)).toBe("mime");
    expect(messageIdOf(kickoff)).toBe("<aamkmsg4@contoso.example>");
    expect(messageFlagsOf(byId(manifest, "AAMkMsg2"))).toEqual({
      isRead: false,
      flag: { flagStatus: "flagged" },
      categories: [],
      importance: "normal",
    });
    const hidden = byId(manifest, "AAMkMsg7");
    expect(folderSegmentsOf(hidden)).toEqual(["Quick Step Settings"]);
    expect(wellKnownFolderOf(hidden)).toBeUndefined();

    const big = byId(manifest, "AAMkMsgBig");
    expect(messageFormatOf(big)).toBe("json");
    expect(referenceAttachmentsOf(big)).toEqual(["shared link"]);
    // Selecting the message brings its attachments along, grouped under it.
    const plan = planRestore(manifest, { paths: [big.path] });
    expect(plan.mail).toEqual([big]);
    expect(plan.orphanAttachments).toEqual([]);
    const attachments = must(plan.attachmentsByMessage.get(big.path));
    expect(attachments.map((a) => attachmentFactsOf(a).name).sort()).toEqual([
      "launch.mp4",
      "logo.png",
    ]);
    expect(attachmentFactsOf(byId(manifest, "AAMkMsgBig/AAMkAtt3"))).toMatchObject({
      kind: "file",
      contentType: "image/png",
      isInline: true,
    });

    expect(calendarFactsOf(byId(manifest, "evt-master"))).toEqual({
      name: "Calendar",
      isDefault: true,
    });
    expect(calendarFactsOf(byId(manifest, "evt-team"))).toEqual({ name: "Team", isDefault: false });
    expect(folderSegmentsOf(byPath(manifest, "mail/Inbox/Projects"))).toEqual([
      "Inbox",
      "Projects",
    ]);
    expect(folderSegmentsOf(byId(manifest, "ct-1"))).toEqual([]);
    expect(folderSegmentsOf(byId(manifest, "ct-2"))).toEqual(["Suppliers"]);
  });

  it("abandons the snapshot when the mailbox is not accessible", async () => {
    box.intercept = (call) =>
      call.url.includes("/mailFolders")
        ? { status: 403, json: graphError("ErrorAccessDenied", "Access is denied.") }
        : undefined;
    const error = await engine.run(newContext(), mailbox, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailboxAccessError);
    expect((error as MailboxAccessError).status).toBe(403);
    expect(await snapshots.get("snap-1")).toBeNull();
    expect(cursor.cursor).toBeNull();
  });

  it("keeps the position when a run fails for a reason that deserves a retry", async () => {
    // Anything that is not an item failure and not a mailbox access problem
    // (here: a failure right after the mail phase) leaves a resumable cursor.
    const failing = newEngine({
      calendarWindow: () => {
        throw new Error("storage target unreachable");
      },
    });
    await expect(failing.run(newContext(), mailbox, {})).rejects.toThrow(
      "storage target unreachable",
    );
    expect(graph.callsTo("GET", "/calendars")).toHaveLength(0);
    const saved = parseCursor(cursor.cursor);
    expect(saved.checkpoint?.snapshotId).toBe("snap-1");
    expect(saved.progress.completedFolders).toHaveLength(5);
    expect(saved.progress.calendarDone).toBe(false);

    graph.calls.length = 0;
    const result = await engine.run(newContext({ jobId: "job-1" }), mailbox, {});
    expect(result.resumed).toBe(true);
    expect(mimeDownloads()).toEqual([]);
    expect(graph.callsTo("GET", "/messages/delta")).toHaveLength(0);
    expect(result.counters.written).toBe(EVENT_COUNT + CONTACT_COUNT);
  });

  it("re-fetches everything on a full run but stores no new bytes when nothing changed", async () => {
    await engine.run(newContext(), mailbox, {});
    graph.calls.length = 0;
    const result = await engine.run(newContext({ jobId: "job-2" }), mailbox, { full: true });

    expect(mimeDownloads()).toHaveLength(MESSAGE_COUNT);
    expect(
      graph
        .callsTo("GET", "/messages/delta")
        .every((c) => !new URL(c.url).searchParams.has("$deltatoken")),
    ).toBe(true);
    expect(result.bytes).toBe(0);
    expect(result.counters.written).toBe(ITEM_COUNT);
    const manifest = await manifestOf(result.snapshotId);
    expect(mailObjects(manifest)).toHaveLength(MESSAGE_COUNT);
    expect(byId(manifest, "AAMkMsg1").metadata?.[META.fetchedInSnapshot]).toBe("snap-2");
  });

  it("refuses protected objects of another kind", async () => {
    await expect(engine.run(newContext(), { ...mailbox, kind: "onedrive" }, {})).rejects.toThrow(
      /handles mailboxes/,
    );
  });
});
