import { afterEach, describe, expect, it } from "vitest";
import { createRestoreEngines } from "./dispatcher.js";
import { DownloadRestoreEngine } from "./download.js";
import { ExchangeRestoreEngine } from "./exchange.js";
import { ImapRestoreEngine } from "./imap.js";
import { OneDriveRestoreEngine } from "./onedrive.js";
import { FakeImapAccount } from "./testing/fake-imap.js";
import {
  type SnapshotFixture,
  createSnapshotFixture,
  mimeMessage,
  restoreRequestFor,
} from "./testing/fixtures.js";

describe("createRestoreEngines", () => {
  let fixture: SnapshotFixture;

  afterEach(async () => {
    await fixture?.cleanup();
  });

  function engines(account: FakeImapAccount) {
    return createRestoreEngines({
      graph: () => {
        throw new Error("no Graph in this test");
      },
      imap: async () => account,
    });
  }

  it("registers one engine per kind plus the download engine", () => {
    const set = engines(new FakeImapAccount());
    expect(set.byKind.get("mailbox")).toBeInstanceOf(ExchangeRestoreEngine);
    expect(set.byKind.get("onedrive")).toBeInstanceOf(OneDriveRestoreEngine);
    expect(set.byKind.get("imap")).toBeInstanceOf(ImapRestoreEngine);
    expect(set.download).toBeInstanceOf(DownloadRestoreEngine);
  });

  it("routes by target type first and protected object kind second", async () => {
    fixture = await createSnapshotFixture({
      kind: "imap",
      externalId: "anna",
      objects: [
        {
          path: "mail/INBOX/1.eml",
          type: "message",
          id: "imap:INBOX:1:1",
          content: mimeMessage({ messageId: "<x@example.org>", subject: "x" }),
          metadata: { mailbox: "INBOX", delimiter: "/", messageId: "<x@example.org>" },
        },
      ],
    });
    const account = new FakeImapAccount();
    const set = engines(account);

    const appended = await set.run(fixture.ctx, restoreRequestFor(fixture, { mode: "skip" }));
    expect(appended.restored).toBe(1);
    expect(account.messages("INBOX")).toHaveLength(1);

    const downloaded = await set.run(
      fixture.ctx,
      restoreRequestFor(fixture, { target: { type: "download", ref: null } }),
    );
    expect(downloaded.downloadKey).toMatch(/\/downloads\/.+\.zip$/);
    expect(account.messages("INBOX")).toHaveLength(1);
  });
});
