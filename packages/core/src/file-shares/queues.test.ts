import { describe, expect, it } from "vitest";
import { FILE_SHARE_QUEUES, FILE_SHARE_QUEUE_SETTINGS, fileShareSingletonKey } from "./queues.js";

describe("file share queues", () => {
  it("has settings for every queue, named like the doc", () => {
    expect(Object.values(FILE_SHARE_QUEUES).sort()).toEqual(
      [
        "file-share-backup",
        "file-share-catalog",
        "file-share-check",
        "file-share-copy",
        "file-share-finish",
        "file-share-monitor",
        "file-share-purge",
        "file-share-retention",
        "file-share-verify",
      ].sort(),
    );
    for (const queue of Object.values(FILE_SHARE_QUEUES)) {
      const settings = FILE_SHARE_QUEUE_SETTINGS[queue];
      expect(settings.name).toBe(queue);
      expect(settings.policy).toBe("stately");
      // pg-boss refuses an expiry of a day or more.
      expect(settings.expireInHours).toBeLessThan(24);
    }
  });

  it("keys singletons by queue and id", () => {
    expect(fileShareSingletonKey(FILE_SHARE_QUEUES.backup, "x")).toBe("file-share-backup:x");
  });
});
