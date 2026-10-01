import { describe, expect, it } from "vitest";
import {
  JOB_PRIORITY,
  JOB_QUEUES,
  MAX_EXPIRE_HOURS,
  QUEUE_DEFINITIONS,
  pgBossQueueOptions,
  sendOptionsFor,
  singletonKeyFor,
} from "./queues.js";

const TENANT = "0f6e4b4e-2f2a-4d9a-9c2b-1a2b3c4d5e6f";

describe("JOB_QUEUES and QUEUE_DEFINITIONS", () => {
  it("lists every queue exactly once, storage_migration included", () => {
    expect(new Set(JOB_QUEUES).size).toBe(JOB_QUEUES.length);
    expect(JOB_QUEUES).toContain("storage_migration");
  });

  it("gives every queue a pg-boss definition, storage_migration included", () => {
    for (const queue of JOB_QUEUES) {
      const options = pgBossQueueOptions(queue);
      expect(options.name, queue).toBe(queue);
      expect(options.expireInHours, queue).toBeLessThanOrEqual(MAX_EXPIRE_HOURS);
    }
    expect(QUEUE_DEFINITIONS.storage_migration.policy).toBe("stately");
  });

  it("ranks storage_migration below restore and backup, above scrub", () => {
    expect(JOB_PRIORITY.storage_migration).toBeLessThan(JOB_PRIORITY.restore);
    expect(JOB_PRIORITY.storage_migration).toBeLessThan(JOB_PRIORITY.backup);
    expect(JOB_PRIORITY.storage_migration).toBeGreaterThan(JOB_PRIORITY.scrub);
  });
});

describe("singletonKeyFor (scheduled queues)", () => {
  it("keys the scheduled queues as before", () => {
    expect(
      singletonKeyFor("backup", { jobId: "j1", tenantId: TENANT, protectedObjectId: "obj-1" }),
    ).toBe("backup:obj-1");
    expect(singletonKeyFor("retention", { jobId: "j2", tenantId: TENANT })).toBe(
      `retention:${TENANT}`,
    );
  });
});

describe("sendOptionsFor", () => {
  it("attaches priority and singleton key for a scheduled queue", () => {
    const options = sendOptionsFor("directory", {
      jobId: "j3",
      tenantId: TENANT,
      sourceId: "src-1",
    });
    expect(options).toEqual({ priority: JOB_PRIORITY.directory, singletonKey: "directory:src-1" });
  });
});
