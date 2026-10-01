import { describe, expect, it } from "vitest";
import type { ManifestObject } from "../manifest.js";
import { MessageIdDuplicates } from "./duplicates.js";

function mail(path: string, messageId?: string): ManifestObject {
  return {
    path,
    size: 1,
    mtime: 0,
    type: "message",
    chunks: [],
    ...(messageId !== undefined ? { metadata: { messageId } } : {}),
  };
}

const folderOf = (message: ManifestObject) => message.path.split("/").slice(0, -1).join("/");

describe("MessageIdDuplicates", () => {
  it("asks the target once per folder and Message-ID and never counts its own copies", async () => {
    const a = mail("INBOX/1", "<x@example.org>");
    const b = mail("INBOX/2", "<x@example.org>");
    const c = mail("Archive/3", "<x@example.org>");
    const duplicates = new MessageIdDuplicates<number>([a, b, c], folderOf);
    let lookups = 0;
    const target = new Map<string, number[]>([["INBOX", [10]]]);
    const lookup = (folder: string) => async () => {
      lookups++;
      return [...(target.get(folder) ?? [])];
    };

    const first = duplicates.slot(a);
    expect(await first.existing("INBOX", lookup("INBOX"))).toEqual([10]);
    target.get("INBOX")?.push(11);
    first.wrote("INBOX", 11);
    first.settle();

    const second = duplicates.slot(b);
    // The copy the target already had is still known to the group; settling
    // the first message (whatever it did) never loses it.
    expect(await second.existing("INBOX", lookup("INBOX"))).toEqual([10]);
    second.settle();
    expect(lookups).toBe(1);

    // Another source folder is another group. Should it land in the same target
    // folder, the copy this run wrote there is still not one the target had.
    const third = duplicates.slot(c);
    expect(await third.existing("INBOX", lookup("INBOX"))).toEqual([10]);
    expect(lookups).toBe(2);
  });

  it("shares the group's known copies with the next message even after one failed", async () => {
    const a = mail("INBOX/1", "<x@example.org>");
    const b = mail("INBOX/2", "<x@example.org>");
    const duplicates = new MessageIdDuplicates<number>([a, b], folderOf);
    const first = duplicates.slot(a);
    await first.existing("INBOX", async () => [10]);
    // The message could not be restored; settling still finishes its slot.
    first.settle();
    // Settling twice changes nothing.
    first.settle();

    const second = duplicates.slot(b);
    // A different lookup answer is never asked: the group's copies were cached.
    expect(await second.existing("INBOX", async () => [99])).toEqual([10]);
    second.settle();
  });

  it("lets each earlier copy stand for one message, preferring one with the same content", async () => {
    const a = mail("R/1", "<x@example.org>");
    const b = mail("R/2", "<x@example.org>");
    const duplicates = new MessageIdDuplicates<number>([a, b], folderOf);
    const content = new Map([
      [20, "b"],
      [21, "a"],
    ]);

    const first = duplicates.slot(a);
    await first.existing("R", async () => [20, 21]);
    expect(await first.claimEarlierCopy(async (copy) => content.get(copy) === "a")).toEqual({
      copy: 21,
      confirmed: true,
    });
    const second = duplicates.slot(b);
    expect(await second.existing("R", async () => [])).toEqual([20]);
    // A copy known to differ never counts; one that cannot be judged does, unconfirmed.
    expect(await second.claimEarlierCopy(async () => false)).toBeUndefined();
    expect(await second.claimEarlierCopy(async () => undefined)).toEqual({
      copy: 20,
      confirmed: false,
    });
  });

  it("treats messages without a recurring Message-ID as groups of one", async () => {
    const single = mail("INBOX/1", "<only@example.org>");
    const anonymous = mail("INBOX/2");
    const duplicates = new MessageIdDuplicates<number>([single, anonymous], folderOf);
    let lookups = 0;
    const lookup = async () => {
      lookups++;
      return [5];
    };

    const one = duplicates.slot(single);
    expect(await one.existing("INBOX", lookup)).toEqual([5]);
    one.settle();
    const none = duplicates.slot(anonymous);
    expect(none.messageId).toBeUndefined();
    expect(await none.existing("INBOX", lookup)).toEqual([]);
    expect(lookups).toBe(1);
  });
});
