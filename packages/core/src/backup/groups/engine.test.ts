import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadManifest } from "../../engine/snapshot.js";
import type { ProtectedObjectRef, RestoreTarget } from "../../engine/types.js";
import {
  createFakeGraph,
  type FakeGraph,
  graphError,
  must,
} from "../../graph/testing/fake-graph.js";
import type { ManifestObject, SnapshotManifest } from "../../manifest.js";
import { chunkReaderFor } from "../../restore/common.js";
import { calendarFactsOf, folderSegmentsOf } from "../../restore/conventions.js";
import { DownloadRestoreEngine } from "../../restore/download.js";
import { GroupRestoreEngine } from "../../restore/groups.js";
import { FakeMailbox as TargetMailbox } from "../../restore/testing/fake-mailbox.js";
import {
  createJobContextFixture,
  type JobContextFixture,
  restoreRequestFor,
} from "../../restore/testing/fixtures.js";
import { buildPostMessage, CONVERSATIONS_PATH, POST_META, postMessageId } from "./conversations.js";
import { GroupMailboxBackupEngine, GroupUnavailableError } from "./engine.js";
import { FakeGroupMailbox } from "./testing/fake-group.js";

const NOW = new Date("2026-09-22T10:00:00Z");
const GROUP_ID = "0b6f8f5e-1111-4222-8333-444455556666";

function standardGroup(): FakeGroupMailbox {
  const group = new FakeGroupMailbox({
    id: GROUP_ID,
    displayName: "Project Phoenix",
    mail: "phoenix@contoso.example",
    resourceProvisioningOptions: ["Team"],
  });
  group.addEvent({
    id: "G-E1",
    type: "singleInstance",
    subject: "Kickoff",
    iCalUId: "uid-kickoff",
    changeKey: "ck-1",
    start: { dateTime: "2026-10-01T08:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-10-01T09:00:00.0000000", timeZone: "UTC" },
    attendees: [{ emailAddress: { address: "anna@contoso.example" }, type: "required" } as never],
  });
  group.addEvent({
    id: "G-E2",
    type: "seriesMaster",
    subject: "Weekly standup",
    changeKey: "ck-2",
    start: { dateTime: "2026-01-05T09:00:00.0000000", timeZone: "UTC" },
    end: { dateTime: "2026-01-05T09:15:00.0000000", timeZone: "UTC" },
    recurrence: {
      pattern: { type: "weekly", interval: 1, daysOfWeek: ["monday"] },
      range: { type: "endDate", startDate: "2026-01-05", endDate: "2026-12-28" },
    },
    exceptions: [
      {
        id: "G-E2-X1",
        type: "exception",
        seriesMasterId: "G-E2",
        subject: "Weekly standup (moved)",
        originalStart: "2026-09-14T09:00:00Z",
        start: { dateTime: "2026-09-14T11:00:00.0000000", timeZone: "UTC" },
      },
    ],
    occurrences: [
      {
        id: "G-E2-O1",
        type: "occurrence",
        seriesMasterId: "G-E2",
        subject: "Weekly standup",
        start: { dateTime: "2026-09-21T09:00:00.0000000", timeZone: "UTC" },
      },
    ],
  });
  group.addThread({
    id: "T1",
    topic: "Launch plan",
    lastDeliveredDateTime: "2026-09-02T10:00:00Z",
    posts: [
      {
        id: "P1",
        from: { emailAddress: { name: "Anna Admin", address: "anna@contoso.example" } },
        body: "<p>Here is the plan</p>",
        receivedDateTime: "2026-09-01T10:00:00Z",
        attachments: [
          {
            id: "A1",
            name: "plan.pdf",
            contentType: "application/pdf",
            bytes: new Uint8Array([1, 2, 3, 4]),
          },
          {
            id: "A2",
            name: "Shared doc",
            contentType: "application/octet-stream",
            bytes: new Uint8Array(),
            odataType: "#microsoft.graph.referenceAttachment",
          },
        ],
      },
      {
        id: "P2",
        from: { emailAddress: { name: "Ben Builder", address: "ben@contoso.example" } },
        body: "Looks good",
        bodyType: "text",
        receivedDateTime: "2026-09-02T10:00:00Z",
        newParticipants: [{ emailAddress: { name: "Carl", address: "carl@contoso.example" } }],
      },
    ],
  });
  group.addThread({
    id: "T2",
    topic: "Büro-Umzug",
    lastDeliveredDateTime: "2026-08-01T10:00:00Z",
    posts: [
      {
        id: "P3",
        from: { emailAddress: { address: "carl@contoso.example" } },
        body: "Wir ziehen um",
        receivedDateTime: "2026-08-01T10:00:00Z",
      },
    ],
  });
  return group;
}

describe("GroupMailboxBackupEngine", () => {
  let fixture: JobContextFixture;
  let group: FakeGroupMailbox;
  let graph: FakeGraph;
  let nextSnapshot: number;

  beforeEach(async () => {
    fixture = await createJobContextFixture({
      kind: "group",
      externalId: GROUP_ID,
      now: () => NOW,
    });
    group = standardGroup();
    graph = createFakeGraph(group.routes());
    nextSnapshot = 1;
  });

  afterEach(async () => {
    await fixture?.cleanup();
  });

  function engine(): GroupMailboxBackupEngine {
    return new GroupMailboxBackupEngine({
      graph: () => graph.client(),
      checkpointEveryItems: 1,
      snapshotIdGenerator: () => `snap-${nextSnapshot++}`,
    });
  }

  async function manifestOf(snapshotId: string): Promise<SnapshotManifest> {
    const record = must(await fixture.ctx.snapshots.get(snapshotId));
    return loadManifest(
      { primary: fixture.storage, copies: [] },
      must(record.manifestPath),
      fixture.ctx.keys,
    );
  }

  function byId(manifest: SnapshotManifest, id: string): ManifestObject {
    return must(
      manifest.objects.find((object) => object.id === id),
      `object ${id}`,
    );
  }

  async function text(object: ManifestObject): Promise<string> {
    return (await chunkReaderFor(fixture.ctx).readObjectToBuffer(object)).toString("utf8");
  }

  it("backs up the group calendar and every conversation post as a message", async () => {
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(result.failures).toEqual([]);
    const manifest = await manifestOf(result.snapshotId);

    const kickoff = byId(manifest, "G-E1");
    expect(kickoff.type).toBe("event");
    expect(kickoff.path.startsWith("calendar/Calendar/Kickoff.")).toBe(true);
    expect(calendarFactsOf(kickoff)).toMatchObject({ isDefault: true });
    const standup = JSON.parse(await text(byId(manifest, "G-E2")));
    expect(standup.event.subject).toBe("Weekly standup");
    expect(standup.exceptions.map((e: { id: string }) => e.id)).toEqual(["G-E2-X1"]);
    expect(graph.callsTo("GET", `/groups/${GROUP_ID}/calendar/events`)).toHaveLength(1);
    expect(graph.callsTo("GET", "/calendarView")).toHaveLength(0);

    const p1 = byId(manifest, "P1");
    expect(p1.type).toBe("mail");
    expect(p1.path.startsWith(`${CONVERSATIONS_PATH}/Launch plan.`)).toBe(true);
    expect(folderSegmentsOf(p1, "mail")).toEqual(["Conversations"]);
    expect(p1.metadata).toMatchObject({
      subject: "Launch plan",
      from: "Anna Admin <anna@contoso.example>",
      format: "mime",
      messageId: postMessageId("P1"),
      [POST_META.threadId]: "T1",
      // A link attachment: recorded by name, its file lives in OneDrive or SharePoint.
      referenceAttachments: JSON.stringify(["Shared doc"]),
    });
    expect(p1.metadata?.missingAttachments).toBeUndefined();
    const mime = await text(p1);
    expect(mime).toContain("From: Anna Admin <anna@contoso.example>");
    expect(mime).toContain("To: Project Phoenix <phoenix@contoso.example>");
    expect(mime).toContain("Subject: Launch plan");
    expect(mime).toContain("Date: Tue, 01 Sep 2026 10:00:00 +0000");
    expect(mime).toContain("Content-Disposition: attachment; filename=plan.pdf");
    expect(mime).toContain(Buffer.from([1, 2, 3, 4]).toString("base64"));

    const p2 = await text(byId(manifest, "P2"));
    expect(p2).toContain("Cc: Carl <carl@contoso.example>");
    expect(p2).toContain("Content-Type: text/plain; charset=utf-8");
    expect(byId(manifest, "P3").metadata?.subject).toBe("Büro-Umzug");
    expect(result.objectsTotal).toBe(
      manifest.objects.filter((o) => o.type !== "folder").length +
        manifest.objects.filter((o) => o.type === "folder").length,
    );
  });

  it("lists posts again only for threads with new posts, and drops vanished threads", async () => {
    const first = await engine().run(fixture.ctx, fixture.protectedObject);
    const postCalls = () => graph.calls.filter((call) => /\/threads\/[^/]+\/posts/.test(call.url));
    expect(postCalls()).toHaveLength(2);

    group.addPost("T1", {
      id: "P4",
      from: { emailAddress: { address: "anna@contoso.example" } },
      body: "Done",
      receivedDateTime: "2026-09-20T10:00:00Z",
    });
    group.threads.delete("T2");
    const before = postCalls().length;
    const second = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(
      postCalls()
        .slice(before)
        .map((call) => new URL(call.url).pathname),
    ).toEqual([`/v1.0/groups/${GROUP_ID}/threads/T1/posts`]);
    const manifest = await manifestOf(second.snapshotId);
    const ids = manifest.objects.filter((o) => o.type === "mail").map((o) => o.id);
    expect(ids.sort()).toEqual(["P1", "P2", "P4"]);
    // Unchanged posts keep their bytes.
    const firstManifest = await manifestOf(first.snapshotId);
    expect(byId(manifest, "P1").sha256).toBe(byId(firstManifest, "P1").sha256);
  });

  it("falls back to the calendar view when Graph refuses the event listing to the app", async () => {
    group.refuseEventsListing = true;
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    // Read through the window: said so, never plain green.
    expect(result.failures.map((failure) => failure.cause?.code)).toEqual([
      "graph.group_calendar_windowed",
    ]);
    const manifest = await manifestOf(result.snapshotId);
    const events = manifest.objects.filter((o) => o.type === "event").map((o) => o.id);
    // The series comes back as its master (read once), with its exceptions.
    expect(events.sort()).toEqual(["G-E1", "G-E2"]);
    expect(graph.callsTo("GET", `/groups/${GROUP_ID}/events/G-E2`)).toHaveLength(2);
    expect(JSON.parse(await text(byId(manifest, "G-E2"))).exceptions).toHaveLength(1);
  });

  it("keeps backed-up events outside the calendar view window when it falls back to the view", async () => {
    group.addEvent({
      id: "G-OLD",
      type: "singleInstance",
      subject: "Founding meeting",
      changeKey: "ck-old",
      start: { dateTime: "2015-03-02T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2015-03-02T10:00:00.0000000", timeZone: "UTC" },
    });
    group.addEvent({
      id: "G-FAR",
      type: "singleInstance",
      subject: "Ten-year anniversary",
      changeKey: "ck-far",
      start: { dateTime: "2029-09-24T09:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2029-09-24T10:00:00.0000000", timeZone: "UTC" },
    });
    const first = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(first.failures).toEqual([]);
    const ids = (manifest: SnapshotManifest) =>
      manifest.objects
        .filter((o) => o.type === "event")
        .map((o) => o.id)
        .sort();
    expect(ids(await manifestOf(first.snapshotId))).toEqual(["G-E1", "G-E2", "G-FAR", "G-OLD"]);

    // Graph now refuses /calendar/events: the view (five years back, two ahead) is read.
    group.refuseEventsListing = true;
    group.events.delete("G-E1");
    const second = await engine().run(fixture.ctx, fixture.protectedObject);
    const manifest = await manifestOf(second.snapshotId);
    // Outside the window: kept as stored. Inside and no longer listed: gone.
    expect(ids(manifest)).toEqual(["G-E2", "G-FAR", "G-OLD"]);
    expect(second.failures).toEqual([
      expect.objectContaining({
        itemRef: "calendar/Calendar",
        cause: expect.objectContaining({ code: "graph.group_calendar_windowed" }),
      }),
    ]);
    expect(second.failures[0]?.cause?.params).toEqual({
      windowStart: "2021-09-22",
      windowEnd: "2028-09-22",
    });
  });

  it("keeps a series' occurrences as single events when its master cannot be read", async () => {
    group.refuseEventsListing = true;
    group.refuseMasterRead = true;
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    // Read through the window: said so, never plain green.
    expect(result.failures.map((failure) => failure.cause?.code)).toEqual([
      "graph.group_calendar_windowed",
    ]);
    const manifest = await manifestOf(result.snapshotId);
    const events = manifest.objects.filter((o) => o.type === "event").map((o) => o.id);
    expect(events.sort()).toEqual(["G-E1", "G-E2-O1", "G-E2-X1"]);
  });

  it("records a refused group calendar as a warning and still backs up the conversations", async () => {
    group.refuseEventsListing = true;
    group.refuseCalendarView = true;
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.itemRef).toBe("calendar/Calendar");
    expect(result.failures[0]?.reason).toMatch(/group calendar cannot be read/);
    const manifest = await manifestOf(result.snapshotId);
    expect(manifest.objects.filter((o) => o.type === "mail")).toHaveLength(3);
  });

  it("stores posts without attachments when Graph refuses the expansion, and warns", async () => {
    group.refuseAttachmentExpand = true;
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    // Never plain green: one warning for the group, with the number of posts concerned.
    expect(result.failures).toEqual([
      expect.objectContaining({
        itemRef: CONVERSATIONS_PATH,
        cause: expect.objectContaining({
          code: "graph.group_post_attachments_refused",
          params: { count: 1 },
        }),
      }),
    ]);
    const manifest = await manifestOf(result.snapshotId);
    expect(byId(manifest, "P1").metadata).toMatchObject({
      missingAttachments: JSON.stringify(["(attachments not available to the app)"]),
      [POST_META.attachmentsNotBackedUp]: "true",
      hasAttachments: "true",
    });
    expect(await text(byId(manifest, "P1"))).not.toContain("plan.pdf");
    expect(byId(manifest, "P2").metadata?.missingAttachments).toBeUndefined();
    expect(byId(manifest, "P2").metadata?.[POST_META.attachmentsNotBackedUp]).toBeUndefined();

    // Still refused next run: the posts stored without them keep the warning.
    const again = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(again.failures.map((failure) => failure.cause?.code)).toEqual([
      "graph.group_post_attachments_refused",
    ]);

    // Graph hands them out again: the thread is read again and the warning is gone.
    group.refuseAttachmentExpand = false;
    const healed = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(healed.failures).toEqual([]);
    const after = await manifestOf(healed.snapshotId);
    expect(byId(after, "P1").metadata?.[POST_META.attachmentsNotBackedUp]).toBeUndefined();
    expect(await text(byId(after, "P1"))).toContain("plan.pdf");
  });

  it("embeds a forwarded mail (item attachment) and a file listed without bytes, and records links", async () => {
    const forwarded = "From: carol@example.test\r\nSubject: Original offer\r\n\r\nThe offer.\r\n";
    group.addPost("T1", {
      id: "P9",
      from: { emailAddress: { name: "Bob", address: "bob@contoso.example" } },
      body: "<p>See the forwarded offer.</p>",
      receivedDateTime: "2026-09-20T09:00:00Z",
      attachments: [
        {
          id: "IA1",
          name: "Original offer",
          contentType: "message/rfc822",
          odataType: "#microsoft.graph.itemAttachment",
          bytes: new Uint8Array(Buffer.from(forwarded)),
        },
        {
          id: "FA1",
          name: "large.pdf",
          contentType: "application/pdf",
          bytes: new Uint8Array(Buffer.from("%PDF-1.7 large")),
          withoutContentBytes: true,
        },
        {
          id: "RA1",
          name: "Budget.xlsx",
          contentType: "application/vnd.ms-excel",
          odataType: "#microsoft.graph.referenceAttachment",
          bytes: new Uint8Array(),
        },
      ],
    });
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(result.failures).toEqual([]);
    const post = byId(await manifestOf(result.snapshotId), "P9");
    const eml = await text(post);
    expect(eml).toContain("Content-Type: message/rfc822");
    expect(eml).toContain("Subject: Original offer");
    expect(eml).toContain("large.pdf");
    expect(post.metadata?.[POST_META.attachmentsNotBackedUp]).toBeUndefined();
    expect(post.metadata?.referenceAttachments).toBe(JSON.stringify(["Budget.xlsx"]));
  });

  it("warns about a post attachment that cannot be read and reads it again next run", async () => {
    const attachment = {
      id: "IA2",
      name: "Forwarded",
      contentType: "message/rfc822",
      odataType: "#microsoft.graph.itemAttachment",
      bytes: new Uint8Array(Buffer.from("Subject: Forwarded\r\n\r\nHi\r\n")),
      valueResponse: {
        status: 500,
        json: graphError("ErrorInternalServerError", "An internal server error occurred."),
      },
    };
    group.addPost("T1", {
      id: "P10",
      from: { emailAddress: { name: "Bob", address: "bob@contoso.example" } },
      body: "<p>fwd</p>",
      receivedDateTime: "2026-09-20T10:00:00Z",
      attachments: [attachment],
    });
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(result.failures).toEqual([
      expect.objectContaining({
        itemRef: CONVERSATIONS_PATH,
        cause: expect.objectContaining({
          code: "graph.group_post_attachments_unreadable",
          params: { count: 1 },
        }),
      }),
    ]);
    expect(byId(await manifestOf(result.snapshotId), "P10").metadata).toMatchObject({
      missingAttachments: JSON.stringify(["Forwarded"]),
      [POST_META.attachmentsNotBackedUp]: "true",
    });

    attachment.valueResponse = undefined as never;
    const healed = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(healed.failures).toEqual([]);
    const post = byId(await manifestOf(healed.snapshotId), "P10");
    expect(post.metadata?.[POST_META.attachmentsNotBackedUp]).toBeUndefined();
    expect(await text(post)).toContain("Subject: Forwarded");
  });

  it("warns once that attachments of group events are not backed up", async () => {
    const kickoff = must(group.events.get("G-E1"));
    kickoff.hasAttachments = true;
    const result = await engine().run(fixture.ctx, fixture.protectedObject);
    expect(result.failures).toEqual([
      expect.objectContaining({
        itemRef: "calendar/Calendar",
        cause: expect.objectContaining({
          code: "graph.group_event_attachments_not_covered",
          params: { count: 1 },
        }),
      }),
    ]);
    // Graph is not asked for them (it does not hand them to the app).
    expect(graph.calls.filter((call) => call.url.includes("/attachments"))).toEqual([]);
  });

  it("restores and downloads posts whose attachments Graph refused as not confirmed, with the reason", async () => {
    group.refuseAttachmentExpand = true;
    const backup = await engine().run(fixture.ctx, fixture.protectedObject);
    const request = (target: RestoreTarget) =>
      restoreRequestFor(
        { protectedObject: fixture.protectedObject, snapshotId: backup.snapshotId },
        { mode: "skip", target },
      );
    const target = new TargetMailbox();
    const report = await new GroupRestoreEngine({ graph: () => target.graph.client() }).run(
      fixture.ctx,
      request({ type: "other", ref: "bob@contoso.example" }),
    );
    const p1 = must(report.items.find((item) => item.id === "P1"));
    expect(p1).toMatchObject({ status: "restored", verified: false });
    expect(p1.reason).toMatch(/Microsoft did not hand out the attachments of this post/);

    const download = await new DownloadRestoreEngine().run(
      fixture.ctx,
      request({ type: "download", ref: null }),
    );
    const downloaded = must(download.items.find((item) => item.id === "P1"));
    expect(downloaded).toMatchObject({ status: "restored", verified: false });
    expect(downloaded.reason).toMatch(/Microsoft did not hand out the attachments/);
  });

  it("fails with GroupUnavailableError when the group no longer exists", async () => {
    group.exists = false;
    await expect(engine().run(fixture.ctx, fixture.protectedObject)).rejects.toBeInstanceOf(
      GroupUnavailableError,
    );
  });

  it("refuses objects of another kind", async () => {
    const mailbox: ProtectedObjectRef = { ...fixture.protectedObject, kind: "mailbox" };
    await expect(engine().run(fixture.ctx, mailbox)).rejects.toThrow(/group mailboxes/);
  });

  describe("restore", () => {
    it("puts calendar events back into the group and reports the posts as not restorable", async () => {
      const backup = await engine().run(fixture.ctx, fixture.protectedObject);
      const report = await new GroupRestoreEngine({ graph: () => graph.client() }).run(
        fixture.ctx,
        restoreRequestFor(
          { protectedObject: fixture.protectedObject, snapshotId: backup.snapshotId },
          { mode: "rename" },
        ),
      );
      expect(group.created.map((event) => event.subject).sort()).toEqual([
        "Kickoff",
        "Weekly standup",
      ]);
      // Attendees are not invited again.
      expect(group.created.every((event) => event.attendees === undefined)).toBe(true);
      const posts = report.items.filter((item) => item.type === "mail");
      expect(posts).toHaveLength(3);
      expect(posts.every((item) => item.code === "not_restorable")).toBe(true);
      expect(posts[0]?.reason).toMatch(/does not let an app post into a group conversation/);
    });

    it("skips events whose iCalUId the group calendar already has (skip mode)", async () => {
      const backup = await engine().run(fixture.ctx, fixture.protectedObject);
      group.created.push({ id: "existing", subject: "Kickoff", iCalUId: "uid-kickoff" });
      const report = await new GroupRestoreEngine({ graph: () => graph.client() }).run(
        fixture.ctx,
        restoreRequestFor(
          { protectedObject: fixture.protectedObject, snapshotId: backup.snapshotId },
          { mode: "skip", selection: { all: true } },
        ),
      );
      const kickoff = must(report.items.find((item) => item.id === "G-E1"));
      expect(kickoff.code).toBe("exists");
    });

    it("reports Graph's refusal per event when the group calendar does not take app writes [RESTORE-007]", async () => {
      const backup = await engine().run(fixture.ctx, fixture.protectedObject);
      group.refuseEventCreate = true;
      const report = await new GroupRestoreEngine({ graph: () => graph.client() }).run(
        fixture.ctx,
        restoreRequestFor({
          protectedObject: fixture.protectedObject,
          snapshotId: backup.snapshotId,
        }),
      );
      const events = report.items.filter((item) => item.type === "event");
      expect(events.every((item) => item.status === "failed")).toBe(true);
    });

    it("restores the calendar and the conversations into a user's mailbox [RESTORE-007]", async () => {
      const backup = await engine().run(fixture.ctx, fixture.protectedObject);
      const target = new TargetMailbox();
      const report = await new GroupRestoreEngine({ graph: () => target.graph.client() }).run(
        fixture.ctx,
        restoreRequestFor(
          { protectedObject: fixture.protectedObject, snapshotId: backup.snapshotId },
          { mode: "skip", target: { type: "other", ref: "bob@contoso.example" } },
        ),
      );
      expect(report.failures).toEqual([]);
      const messages = [...target.messages.values()];
      expect(messages.map((m) => m.internetMessageId).sort()).toEqual(
        ["P1", "P2", "P3"].map(postMessageId).sort(),
      );
      const folder = must(messages[0]).parentFolderId;
      expect(target.folderPath(folder)).toEqual(["Conversations"]);
      // P1's link attachment is recorded by name (its file lives in OneDrive or SharePoint):
      // said, as for a message, without taking the confirmation.
      const p1 = must(report.items.find((item) => item.id === "P1"));
      expect(p1).toMatchObject({ status: "restored", code: "restored", verified: true });
      expect(p1.reason).toMatch(
        /link attachments are listed in the backup but not re-created: Shared doc/,
      );
      expect(must(report.items.find((item) => item.id === "P2")).verified).toBe(true);
      const subjects = [...target.events.values()].map((event) => event.body.subject).sort();
      expect(subjects).toEqual(["Kickoff", "Weekly standup"]);
    });
  });
});

describe("buildPostMessage", () => {
  it("is deterministic and carries the thread as subject", () => {
    const post = {
      id: "P9",
      from: { emailAddress: { name: "Ä Person", address: "a@contoso.example" } },
      body: { contentType: "html" as const, content: "<b>Hi</b>" },
      receivedDateTime: "2026-01-02T03:04:05Z",
    };
    const thread = { id: "T9", topic: "Grüße" };
    const group = { displayName: "Team", mail: "team@contoso.example" };
    const one = buildPostMessage(post, thread, group);
    const two = buildPostMessage(post, thread, group);
    expect(one.bytes.equals(two.bytes)).toBe(true);
    const text = one.bytes.toString("latin1");
    expect(text).toMatch(/^From: =\?UTF-8\?B\?/m);
    expect(text).toContain("Subject: =?UTF-8?B?");
    expect(text).toContain("Thread-Topic: ");
    expect(text).toContain(`Message-ID: ${postMessageId("P9")}`);
    expect(text).toContain("Content-Type: text/html; charset=utf-8");
  });
});
