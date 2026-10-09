import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { InMemoryDeltaTokenStore } from "../delta.js";
import { GraphError } from "../errors.js";
import { batchEnvelope, createFakeGraph, graphError, must } from "../testing/fake-graph.js";
import foldersFixture from "../testing/fixtures/mail-folders.json" with { type: "json" };
import contentFixture from "../testing/fixtures/message-content.json" with { type: "json" };
import deltaFixture from "../testing/fixtures/messages-delta.json" with { type: "json" };
import {
  MESSAGE_DELTA_SELECT,
  type MessageDeltaEntry,
  addFileAttachment,
  attachmentIdFromLocation,
  createMessageFromMime,
  ensureMailFolderPath,
  fetchMessageContent,
  findMessagesByInternetMessageId,
  getMessageMime,
  listMailFolderTree,
  messagesDelta,
  patchMessage,
  resolveWellKnownFolders,
  toCreatableMessage,
} from "./mail.js";

const USER = "user-1";

/** $batch answering well-known folder lookups from the fixture. */
function wellKnownBatchRoute() {
  const wellKnown = foldersFixture.wellKnown as Record<string, string>;
  return {
    method: "POST",
    url: "/v1.0/$batch",
    respond: (call: Parameters<typeof batchEnvelope>[0]) =>
      batchEnvelope(call, (sub) => {
        const name = sub.url.match(/mailFolders\/([^/?]+)/)?.[1] ?? "";
        const id = wellKnown[name];
        return id
          ? { status: 200, body: { id } }
          : { status: 404, body: graphError("ErrorFolderNotFound") };
      }),
  };
}

describe("mail folders", () => {
  it("resolves well-known folders with one $batch and tolerates 404s", async () => {
    const graph = createFakeGraph([wellKnownBatchRoute()]);
    const result = await resolveWellKnownFolders(graph.client(), USER);
    expect(result.byName.get("inbox")).toBe("AAMkFolderInbox");
    expect(result.byId.get("AAMkFolderSent")).toBe("sentitems");
    expect(result.byName.has("clutter")).toBe(false);
    expect(graph.callsTo("POST", "$batch")).toHaveLength(1);
    const payload = must(graph.calls[0]).json as { requests: unknown[] };
    expect(payload.requests).toHaveLength(17);
  });

  it("walks the tree breadth first, including hidden folders, batching child lookups", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) =>
          batchEnvelope(call, (sub) => {
            if (sub.url.includes("/childFolders")) {
              if (sub.url.includes("AAMkFolderInbox")) {
                return { status: 200, body: foldersFixture.inboxChildren };
              }
              if (sub.url.includes("AAMkFolderProjects")) {
                return { status: 200, body: foldersFixture.projectsChildren };
              }
              return { status: 200, body: { value: [] } };
            }
            const name = sub.url.match(/mailFolders\/([^/?]+)/)?.[1] ?? "";
            const id = (foldersFixture.wellKnown as Record<string, string>)[name];
            return id
              ? { status: 200, body: { id } }
              : { status: 404, body: graphError("ErrorFolderNotFound") };
          }),
      },
      {
        url: (u) => u.pathname === `/v1.0/users/${USER}/mailFolders` && !u.search.includes("skip"),
        respond: { status: 200, json: foldersFixture.topLevelPage1 },
      },
      { url: /\$skip=100/, respond: { status: 200, json: foldersFixture.topLevelPage2 } },
    ]);

    const tree = await listMailFolderTree(graph.client(), USER);
    expect(tree.map((f) => f.path.join("/"))).toEqual([
      "Inbox",
      "Sent Items",
      "Deleted Items",
      "Quick Step Settings",
      "Inbox/Projects",
      "Inbox/Newsletters",
      "Inbox/Projects/Restow",
    ]);
    expect(tree.find((f) => f.id === "AAMkFolderInbox")?.wellKnownName).toBe("inbox");
    expect(tree.find((f) => f.id === "AAMkFolderHidden")?.isHidden).toBe(true);
    expect(tree.find((f) => f.id === "AAMkFolderRestow")).toMatchObject({
      depth: 2,
      parentFolderId: "AAMkFolderProjects",
      totalItemCount: 12,
    });

    const topLevel = new URL(must(graph.callsTo("GET", "/mailFolders")[0]).url);
    expect(topLevel.searchParams.get("includeHiddenFolders")).toBe("true");
    // Well-known resolution plus one batch per tree level with children.
    expect(graph.callsTo("POST", "$batch")).toHaveLength(3);
  });
});

describe("mail folder tree with a folder listed twice", () => {
  it("keeps each folder once and asks for its children once", async () => {
    const page1 = foldersFixture.topLevelPage1;
    const inbox = must(page1.value.find((folder) => folder.id === "AAMkFolderInbox"));
    const graph = createFakeGraph([
      {
        method: "POST",
        url: "/v1.0/$batch",
        respond: (call) =>
          batchEnvelope(call, (sub) => {
            if (sub.url.includes("/childFolders")) {
              return { status: 200, body: { value: [] } };
            }
            const name = sub.url.match(/mailFolders\/([^/?]+)/)?.[1] ?? "";
            const id = (foldersFixture.wellKnown as Record<string, string>)[name];
            return id
              ? { status: 200, body: { id } }
              : { status: 404, body: graphError("ErrorFolderNotFound") };
          }),
      },
      {
        url: (u) => u.pathname === `/v1.0/users/${USER}/mailFolders` && !u.search.includes("skip"),
        respond: { status: 200, json: page1 },
      },
      {
        url: /\$skip=100/,
        respond: {
          status: 200,
          json: {
            ...foldersFixture.topLevelPage2,
            value: [...foldersFixture.topLevelPage2.value, inbox],
          },
        },
      },
    ]);

    const tree = await listMailFolderTree(graph.client(), USER);
    expect(tree.filter((f) => f.id === "AAMkFolderInbox")).toHaveLength(1);
    const childLookups = graph
      .callsTo("POST", "$batch")
      .flatMap((call) => (call.json as { requests: { url: string }[] }).requests)
      .filter((sub) => sub.url.includes("AAMkFolderInbox/childFolders"));
    expect(childLookups).toHaveLength(1);
  });
});

describe("messages delta", () => {
  it("selects the envelope fields the mail restore explorer metadata contract needs", () => {
    expect(MESSAGE_DELTA_SELECT).toEqual(
      expect.arrayContaining(["from", "toRecipients", "ccRecipients"]),
    );
  });

  it("uses the documented $select and a page-size preference, storing the token per folder", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/messages/delta") && !u.search.includes("skiptoken"),
        respond: { status: 200, json: deltaFixture.initialPage1 },
      },
      { url: /\$skiptoken=SKIP1/, respond: { status: 200, json: deltaFixture.initialPage2 } },
    ]);
    const store = new InMemoryDeltaTokenStore();
    const entries: MessageDeltaEntry[] = [];
    const generator = messagesDelta(graph.client(), store, USER, "AAMkFolderInbox");
    let next = await generator.next();
    while (!next.done) {
      entries.push(...next.value.items);
      next = await generator.next();
    }

    expect(entries.map((e) => e.internetMessageId)).toEqual([
      "<msg1@contoso.example>",
      "<msg2@contoso.example>",
      "<msg3@contoso.example>",
    ]);
    const first = new URL(must(graph.calls[0]).url);
    expect(first.searchParams.get("$select")).toBe(MESSAGE_DELTA_SELECT.join(","));
    expect(must(graph.calls[0]).headers.prefer).toBe("odata.maxpagesize=200");
    expect(await store.get("mail:user-1:AAMkFolderInbox")).toContain("DELTA1");
  });
});

describe("message content", () => {
  it("streams the MIME through $value with a 429 in between", async () => {
    const graph = createFakeGraph([
      {
        url: /messages\/AAMkMsg1\/\$value/,
        respond: [
          { status: 429, headers: { "Retry-After": "2" }, json: deltaFixture.throttled },
          { status: 200, headers: { "content-type": "message/rfc822" }, text: contentFixture.mime },
        ],
      },
    ]);
    const waits: number[] = [];
    const client = graph.client({ onThrottle: (info) => waits.push(info.waitMs) });
    const mime = await getMessageMime(client, USER, "AAMkMsg1");
    expect(mime.toString()).toBe(contentFixture.mime);
    expect(mime.toString()).toContain("Message-ID: <msg1@contoso.example>");
    expect(waits).toEqual([2000]);
    expect(must(graph.calls[0]).headers.accept).toBe("*/*");
  });

  it("falls back to JSON plus attachments when the MIME export is refused as too large", async () => {
    const graph = createFakeGraph([
      {
        url: /messages\/AAMkMsgBig\/\$value/,
        respond: { status: 413, json: contentFixture.tooLarge },
      },
      {
        url: (u) => u.pathname === `/v1.0/users/${USER}/messages/AAMkMsgBig`,
        respond: { status: 200, json: contentFixture.messageJson },
      },
      {
        url: (u) => u.pathname.endsWith("/messages/AAMkMsgBig/attachments"),
        respond: { status: 200, json: contentFixture.attachments },
      },
      {
        url: /attachments\/AAMkAtt1\/\$value/,
        respond: { status: 200, bytes: new Uint8Array([0, 1, 2]) },
      },
    ]);
    const content = await fetchMessageContent(graph.client(), USER, "AAMkMsgBig");
    expect(content.kind).toBe("parts");
    if (content.kind !== "parts") {
      throw new Error("unreachable");
    }
    expect(content.message.body?.content).toBe("<p>See attachment.</p>");
    expect(content.attachments.map((a) => a.meta.name)).toEqual(["launch.mp4"]);
    const bytes: Buffer[] = [];
    for await (const chunk of await must(content.attachments[0]).open()) {
      bytes.push(chunk as Buffer);
    }
    expect(Buffer.concat(bytes)).toEqual(Buffer.from([0, 1, 2]));
    const messageGet = must(
      graph.calls
        .map((c) => new URL(c.url))
        .find((u) => u.pathname.endsWith("/messages/AAMkMsgBig")),
    );
    expect(messageGet.searchParams.get("$select")).toContain("body");
  });

  it("skips the MIME attempt entirely when the known size exceeds the threshold", async () => {
    const graph = createFakeGraph([
      {
        url: (u) => u.pathname.endsWith("/messages/AAMkMsgBig"),
        respond: { status: 200, json: contentFixture.messageJson },
      },
      {
        url: (u) => u.pathname.endsWith("/attachments"),
        respond: { status: 200, json: contentFixture.attachments },
      },
    ]);
    const content = await fetchMessageContent(graph.client(), USER, "AAMkMsgBig", {
      knownSizeBytes: 200 * 1024 * 1024,
    });
    expect(content.kind).toBe("parts");
    expect(graph.callsTo("GET", "$value")).toHaveLength(0);
  });

  it("does not hide real errors behind the fallback", async () => {
    const graph = createFakeGraph([
      { url: /\$value/, respond: { status: 404, json: graphError("ErrorItemNotFound") } },
    ]);
    await expect(fetchMessageContent(graph.client(), USER, "gone")).rejects.toMatchObject({
      status: 404,
      code: "ErrorItemNotFound",
    });
  });
});

describe("restore", () => {
  it("creates a message from base64 MIME as text/plain and patches flags afterwards", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: /mailFolders\/AAMkFolderInbox\/messages$/,
        respond: { status: 201, json: { id: "AAMkNew" } },
      },
      {
        method: "PATCH",
        url: /messages\/AAMkNew$/,
        respond: { status: 200, json: { id: "AAMkNew" } },
      },
    ]);
    const client = graph.client();
    const mimeBase64 = Buffer.from(contentFixture.mime).toString("base64");
    const created = await createMessageFromMime(client, USER, "AAMkFolderInbox", mimeBase64);
    expect(created.id).toBe("AAMkNew");
    const post = must(graph.calls[0]);
    expect(post.headers["content-type"]).toBe("text/plain");
    expect(post.body).toBe(mimeBase64);

    await patchMessage(client, USER, "AAMkNew", {
      isRead: true,
      categories: ["Finance"],
      flag: undefined,
    });
    expect(must(graph.calls[1]).json).toEqual({ isRead: true, categories: ["Finance"] });

    await patchMessage(client, USER, "AAMkNew", {});
    expect(graph.calls).toHaveLength(2);
  });

  it("checks duplicates by internetMessageId with a quoted OData filter", async () => {
    const graph = createFakeGraph([
      {
        url: /\/messages\?/,
        respond: {
          status: 200,
          json: { value: [{ id: "AAMkMsg1", parentFolderId: "AAMkFolderInbox" }] },
        },
      },
    ]);
    const found = await findMessagesByInternetMessageId(
      graph.client(),
      USER,
      "<o'brien@contoso.example>",
    );
    expect(found.map((m) => m.id)).toEqual(["AAMkMsg1"]);
    const url = new URL(must(graph.calls[0]).url);
    expect(url.searchParams.get("$filter")).toBe(
      "internetMessageId eq '<o''brien@contoso.example>'",
    );
  });

  it("ensures a folder path, reusing existing folders and creating the missing tail once", async () => {
    const graph = createFakeGraph([
      {
        url: (u) =>
          u.pathname === `/v1.0/users/${USER}/mailFolders` &&
          u.searchParams.get("$filter") === "displayName eq 'Inbox'",
        respond: {
          status: 200,
          json: { value: [{ id: "AAMkFolderInbox", displayName: "Inbox" }] },
        },
      },
      {
        url: (u) =>
          u.pathname.endsWith("/AAMkFolderInbox/childFolders") &&
          u.searchParams.get("$filter") === "displayName eq 'Restored 2026-09-22'",
        respond: { status: 200, json: { value: [] } },
      },
      {
        method: "POST",
        url: /AAMkFolderInbox\/childFolders$/,
        respond: { status: 201, json: { id: "AAMkFolderRestored" } },
      },
      {
        url: (u) => u.pathname.endsWith("/AAMkFolderRestored/childFolders"),
        respond: { status: 200, json: { value: [] } },
      },
      {
        method: "POST",
        url: /AAMkFolderRestored\/childFolders$/,
        respond: { status: 201, json: { id: "AAMkFolderProjects2" } },
      },
    ]);
    const cache = new Map<string, string>();
    const client = graph.client();
    const id = await ensureMailFolderPath(client, USER, "Inbox/Restored 2026-09-22/Projects", {
      cache,
    });
    expect(id).toBe("AAMkFolderProjects2");
    expect(graph.callsTo("POST", "childFolders")).toHaveLength(2);
    expect(must(graph.calls[2]).json).toEqual({ displayName: "Restored 2026-09-22" });

    const again = await ensureMailFolderPath(client, USER, ["Inbox", "Restored 2026-09-22"], {
      cache,
    });
    expect(again).toBe("AAMkFolderRestored");
    expect(graph.calls).toHaveLength(5);
  });

  it("strips read-only properties for a JSON re-create", () => {
    const creatable = toCreatableMessage({
      id: "x",
      subject: "Hi",
      body: { contentType: "text", content: "hello" },
      receivedDateTime: "2026-01-01T00:00:00Z",
      "@odata.etag": "W/1",
      conversationId: "c",
    } as never);
    expect(creatable).toEqual({ subject: "Hi", body: { contentType: "text", content: "hello" } });
  });

  it("uploads a large attachment through an Outlook upload session with ≤ 4 MiB fragments", async () => {
    const size = 5 * 1024 * 1024;
    const uploadUrl = "https://outlook.office.example/upload?session=ATT";
    let received = 0;
    const graph = createFakeGraph([
      {
        method: "POST",
        url: /attachments\/createUploadSession$/,
        respond: {
          status: 201,
          json: {
            uploadUrl,
            expirationDateTime: "2026-09-22T12:00:00Z",
            nextExpectedRanges: ["0-"],
          },
        },
      },
      {
        method: "PUT",
        url: /upload\?session=ATT/,
        respond: (call) => {
          received += (call.body as Uint8Array).length;
          return received >= size
            ? {
                status: 201,
                headers: {
                  Location:
                    "https://outlook.office.example/api/v2.0/Users('user-1')/Messages('AAMkNew')/Attachments('AAMkAttNew')",
                },
              }
            : { status: 200, json: { nextExpectedRanges: [`${received}-`] } };
        },
      },
    ]);
    const result = await addFileAttachment(
      graph.client(),
      USER,
      "AAMkNew",
      { name: "big.bin", contentType: "application/octet-stream", size },
      Readable.from([Buffer.alloc(size, 7)]),
    );
    expect(result.id).toBe("AAMkAttNew");
    const puts = graph.callsTo("PUT", "session=ATT");
    expect(puts).toHaveLength(2);
    expect(must(puts[0]).headers["content-range"]).toBe(`bytes 0-${12 * 320 * 1024 - 1}/${size}`);
    expect(must(puts[0]).headers.authorization).toBeUndefined();
    const session = must(graph.callsTo("POST", "createUploadSession")[0]).json as {
      AttachmentItem: { size: number };
    };
    expect(session.AttachmentItem.size).toBe(size);
  });

  it("reads the attachment id from Outlook-style and Graph-style Location headers", () => {
    expect(
      attachmentIdFromLocation(
        "https://outlook.office.example/api/v2.0/Users('u')/Messages('m')/Attachments('AAMk=')",
      ),
    ).toBe("AAMk=");
    expect(
      attachmentIdFromLocation(
        "https://graph.microsoft.com/v1.0/users/u/messages/m/attachments/AAMkX",
      ),
    ).toBe("AAMkX");
    expect(attachmentIdFromLocation(undefined)).toBeUndefined();
  });

  it("rejects a MIME create with a GraphError carrying Graph's code", async () => {
    const graph = createFakeGraph([
      {
        method: "POST",
        url: /messages$/,
        respond: { status: 403, json: graphError("ErrorAccessDenied", "Access is denied.") },
      },
    ]);
    const error = await createMessageFromMime(graph.client(), USER, "f", "QUJD").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GraphError);
    expect((error as GraphError).code).toBe("ErrorAccessDenied");
  });
});
