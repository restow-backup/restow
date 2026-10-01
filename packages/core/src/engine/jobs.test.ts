import { describe, expect, it } from "vitest";
import {
  type ArchiveJobPayload,
  type BackupJobPayload,
  type DirectoryJobPayload,
  JOB_PRIORITY,
  JOB_QUEUES,
  type RetentionJobPayload,
  type ScrubJobPayload,
  type StorageMigrationJobPayload,
  type VerifyJobPayload,
  isJobQueue,
  singletonKeyFor,
} from "./jobs.js";

describe("JOB_QUEUES", () => {
  it("lists every queue exactly once, storage_migration included", () => {
    expect(new Set(JOB_QUEUES).size).toBe(JOB_QUEUES.length);
    expect(JOB_QUEUES).toContain("storage_migration");
  });

  it("narrows an arbitrary string with isJobQueue", () => {
    expect(isJobQueue("storage_migration")).toBe(true);
    expect(isJobQueue("backup")).toBe(true);
    expect(isJobQueue("not-a-queue")).toBe(false);
  });

  it("gives every queue a priority, storage_migration below restore and backup, above scrub", () => {
    for (const queue of JOB_QUEUES) {
      expect(JOB_PRIORITY[queue], queue).toBeGreaterThan(0);
    }
    expect(JOB_PRIORITY.storage_migration).toBeLessThan(JOB_PRIORITY.restore);
    expect(JOB_PRIORITY.storage_migration).toBeLessThan(JOB_PRIORITY.backup);
    expect(JOB_PRIORITY.storage_migration).toBeGreaterThan(JOB_PRIORITY.scrub);
  });
});

describe("singletonKeyFor", () => {
  const tenantId = "11111111-1111-1111-1111-111111111111";

  it("keys backup and verify by protected object", () => {
    const backup: BackupJobPayload = { jobId: "j1", tenantId, protectedObjectId: "obj-1" };
    expect(singletonKeyFor("backup", backup)).toBe("backup:obj-1");
    const verify: VerifyJobPayload = {
      jobId: "j2",
      tenantId,
      protectedObjectId: "obj-1",
      kind: "verify",
    };
    expect(singletonKeyFor("verify", verify)).toBe("verify:obj-1");
  });

  it("keys archive by object, then source, then the tenant", () => {
    const byObject: ArchiveJobPayload = {
      jobId: "j3",
      tenantId,
      protectedObjectId: "obj-1",
      capture: "graph_sync",
    };
    expect(singletonKeyFor("archive", byObject)).toBe(`archive:${tenantId}:obj-1`);
    const bySource: ArchiveJobPayload = {
      jobId: "j4",
      tenantId,
      sourceId: "src-1",
      capture: "imap_sync",
    };
    expect(singletonKeyFor("archive", bySource)).toBe(`archive:${tenantId}:src-1`);
  });

  it("keys directory by source, retention and scrub by tenant", () => {
    const directory: DirectoryJobPayload = { jobId: "j5", tenantId, sourceId: "src-1" };
    expect(singletonKeyFor("directory", directory)).toBe("directory:src-1");
    const retention: RetentionJobPayload = { jobId: "j6", tenantId };
    expect(singletonKeyFor("retention", retention)).toBe(`retention:${tenantId}`);
    const scrub: ScrubJobPayload = { jobId: "j7", tenantId, mode: "sample" };
    expect(singletonKeyFor("scrub", scrub)).toBe(`scrub:${tenantId}`);
  });

  it("keys storage_migration by the migration row, never the tenant alone", () => {
    const first: StorageMigrationJobPayload = { jobId: "j8", tenantId, migrationId: "mig-1" };
    const second: StorageMigrationJobPayload = { jobId: "j9", tenantId, migrationId: "mig-2" };
    expect(singletonKeyFor("storage_migration", first)).toBe("storage_migration:mig-1");
    expect(singletonKeyFor("storage_migration", second)).toBe("storage_migration:mig-2");
    expect(singletonKeyFor("storage_migration", first)).not.toBe(
      singletonKeyFor("storage_migration", second),
    );
  });

  it("keys import by the imported mailbox and never deduplicates exports", () => {
    expect(
      singletonKeyFor("import", {
        jobId: "j11",
        tenantId,
        importId: "imp-1",
        protectedObjectId: "obj-1",
      }),
    ).toBe("import:obj-1");
    expect(
      singletonKeyFor("import", {
        jobId: "j12",
        tenantId,
        importId: "imp-2",
        protectedObjectId: "obj-1",
      }),
    ).toBe("import:obj-1");
    expect(singletonKeyFor("export", { jobId: "j13", tenantId, exportId: "exp-1" })).toBeNull();
  });

  it("never deduplicates restores", () => {
    expect(
      singletonKeyFor("restore", {
        jobId: "j10",
        tenantId,
        restoreJobId: "r1",
        protectedObjectId: "obj-1",
      }),
    ).toBeNull();
  });
});
