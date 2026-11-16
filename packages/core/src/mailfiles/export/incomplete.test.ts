/**
 * A group post whose attachments the backup does not hold is exported as it
 * is, never as a clean copy: the summary counts it, MANIFEST.csv gives it the
 * status `incomplete` with the reason, and the writers pass the reason on.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createSnapshotFixture,
  type FixtureObject,
  type SnapshotFixture,
} from "../../restore/testing/fixtures.js";
import { openSnapshotExport } from "../export-sources.js";
import { createEmlZip } from "./eml-zip.js";
import { createMbox, createMboxZip } from "./mbox.js";
import { collect, parseManifest, unzip } from "./testing.js";
import type { ExportEntry } from "./types.js";

/** A post as the group conversation backup writes it (backup/groups/conversations.ts). */
function post(id: string, missing?: string[]): FixtureObject {
  return {
    path: `mail/Conversations/Plan.${id}.eml`,
    type: "mail",
    id,
    content: [
      `Message-ID: <post-${id}@groups.restow.invalid>`,
      "Date: Tue, 03 Mar 2026 09:00:00 +0000",
      "From: Carla <carla@example.org>",
      "To: Projekt Nord <nord@example.org>",
      "Subject: Plan",
      "",
      "Plan im Anhang",
      "",
    ].join("\r\n"),
    metadata: {
      subject: "Plan",
      receivedDateTime: "2026-03-03T09:00:05Z",
      isRead: "true",
      flagStatus: "notFlagged",
      hasAttachments: missing ? "true" : "false",
      messageId: `<post-${id}@groups.restow.invalid>`,
      folderId: "thread:T1",
      folderPath: "Conversations",
      format: "mime",
      conversationThreadId: "T1",
      postId: id,
      ...(missing ? { missingAttachments: JSON.stringify(missing) } : {}),
    },
  };
}

describe("export of mail the backup holds without its attachments", () => {
  let fixture: SnapshotFixture;
  afterEach(async () => {
    await fixture?.cleanup();
  });

  const messages = async () =>
    (
      await openSnapshotExport(fixture.ctx, {
        snapshotId: fixture.snapshotId,
        protectedObject: fixture.protectedObject,
        selection: { all: true },
      })
    ).messages;

  it("marks such a post incomplete in the EML ZIP, the MBOX ZIP and a single MBOX", async () => {
    fixture = await createSnapshotFixture({
      kind: "group",
      externalId: "nord@example.org",
      objects: [
        post("AAQk1", ["Plan.pdf"]),
        post("AAQk2", ["(attachments not available to the app)"]),
        post("AAQk3"),
      ],
    });

    const zip = createEmlZip(await messages());
    const [archive, summary] = await Promise.all([collect(zip.stream), zip.completed]);
    expect(summary).toMatchObject({ messages: 3, failed: 0, incomplete: 2 });
    const entries = await unzip(archive);
    const manifest = parseManifest(
      String(entries.find((entry) => entry.name === "MANIFEST.csv")?.data),
    );
    const byId = (id: string) => manifest.find((row) => row.message_id.includes(id));
    expect(byId("AAQk1")).toMatchObject({ status: "incomplete" });
    expect(byId("AAQk1")?.note).toMatch(/does not hold these attachments of the post: Plan\.pdf/);
    expect(byId("AAQk2")).toMatchObject({ status: "incomplete" });
    expect(byId("AAQk2")?.note).toMatch(/did not hand out the attachments of this post/);
    expect(byId("AAQk3")).toMatchObject({ status: "added", note: "" });

    const seen: ExportEntry[] = [];
    const mboxZip = createMboxZip(await messages(), { onEntry: (entry) => seen.push(entry) });
    const [, mboxSummary] = await Promise.all([collect(mboxZip.stream), mboxZip.completed]);
    expect(mboxSummary.incomplete).toBe(2);
    expect(seen.filter((entry) => entry.incomplete !== undefined)).toHaveLength(2);

    const single = createMbox(await messages());
    const [, singleSummary] = await Promise.all([collect(single.stream), single.completed]);
    expect(singleSummary.incomplete).toBe(2);
  });
});
