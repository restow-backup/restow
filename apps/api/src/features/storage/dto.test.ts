import type { StorageMigration, StorageTarget } from "@restow/db";
import { describe, expect, it } from "vitest";
import {
  accessKeyIdHint,
  compareTargets,
  toInstallationDefaultDto,
  toMigrationDto,
  toTargetDto,
  withStalledJob,
} from "./dto.js";

const CREATED = new Date("2026-09-01T08:00:00.000Z");

function row(overrides: Partial<StorageTarget>): StorageTarget {
  return {
    id: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
    tenantId: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
    name: "Offsite",
    kind: "s3",
    role: "copy",
    config: {
      bucket: "acme-restow",
      endpoint: "https://fsn1.your-objectstorage.com",
      region: "fsn1",
      forcePathStyle: false,
      accessKeyIdHint: "WXYZ",
    } as StorageTarget["config"],
    secretRef: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
    status: "unverified",
    errorMessage: null,
    checkedAt: null,
    bytesUsed: 0,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

describe("toTargetDto", () => {
  it("describes an S3 target without credentials", () => {
    const dto = toTargetDto(row({}), { isProviderAdmin: false });
    expect(dto).toMatchObject({
      name: "Offsite",
      location: "s3://acme-restow (fsn1.your-objectstorage.com)",
      local: null,
      s3: {
        bucket: "acme-restow",
        prefix: null,
        endpoint: "https://fsn1.your-objectstorage.com",
        region: "fsn1",
        forcePathStyle: false,
        hasCredentials: true,
        accessKeyIdHint: "WXYZ",
      },
      configValid: true,
      objectLock: null,
      canManage: true,
    });
    expect(JSON.stringify(dto)).not.toContain("secret");
  });

  it("says plainly that a filesystem has no WORM, and keeps it with the provider", () => {
    const local = row({ kind: "local", config: { basePath: "/mnt/nas" }, secretRef: null });
    const dto = toTargetDto(local, { isProviderAdmin: false });
    expect(dto.objectLock).toMatchObject({ status: "unsupported", reason: "filesystem" });
    expect(dto.local).toEqual({ basePath: "/mnt/nas" });
    expect(dto.canManage).toBe(false);
    expect(toTargetDto(local, { isProviderAdmin: true }).canManage).toBe(true);
  });

  it("flags stored addressing that no longer validates", () => {
    const broken = row({ config: { bucket: "Not Valid" } as StorageTarget["config"], name: null });
    const dto = toTargetDto(broken, { isProviderAdmin: true });
    expect(dto.configValid).toBe(false);
    expect(dto.s3).toBeNull();
    expect(dto.name).toBe("Not Valid");
  });

  it("attaches the migration the caller found for this target", () => {
    const migration = toMigrationDto(migrationRow({}), "destination", 120);
    const dto = toTargetDto(row({}), { isProviderAdmin: true }, migration);
    expect(dto.migration).toBe(migration);
  });

  it("defaults to no migration when the caller found none", () => {
    expect(toTargetDto(row({}), { isProviderAdmin: true }).migration).toBeNull();
  });
});

function migrationRow(overrides: Partial<StorageMigration>): StorageMigration {
  return {
    id: "3c2b1a0f-9e8d-4c7b-a6f5-e4d3c2b1a0f9",
    tenantId: "1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9",
    sourceTargetId: "old-primary",
    destinationTargetId: "8a7b6c5d-4e3f-4a1b-9c8d-7e6f5a4b3c2d",
    mode: "move",
    status: "copying",
    jobId: "job-1",
    objectsTotal: 100,
    objectsDone: 42,
    bytesTotal: 1000,
    bytesDone: 420,
    errorMessage: null,
    startedAt: CREATED,
    verifiedAt: null,
    switchedAt: null,
    finishedAt: null,
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

describe("toMigrationDto", () => {
  it("computes a percent from objects done/total and keeps the eta while cancellable", () => {
    const dto = toMigrationDto(migrationRow({}), "destination", 90);
    expect(dto).toMatchObject({
      percent: 42,
      etaSeconds: 90,
      cancellable: true,
      role: "destination",
    });
  });

  it("has no percent while the total is not known yet", () => {
    expect(
      toMigrationDto(migrationRow({ objectsTotal: 0, objectsDone: 0 }), "source", null).percent,
    ).toBeNull();
  });

  it("drops the eta and cancellability once the migration is no longer running", () => {
    const dto = toMigrationDto(
      migrationRow({ status: "completed", objectsDone: 100, finishedAt: CREATED }),
      "source",
      90,
    );
    expect(dto).toMatchObject({ percent: 100, etaSeconds: null, cancellable: false });
  });

  it("is not cancellable once the atomic switch has started, even though it is still unfinished", () => {
    // "switching" commits within moments (apps/worker/src/handlers/
    // storage-migration.ts): a cancel request then would not stop it, only
    // leave a misleading audit entry next to one that says it switched.
    const dto = toMigrationDto(migrationRow({ status: "switching" }), "destination", 5);
    expect(dto).toMatchObject({ cancellable: false, etaSeconds: null, status: "switching" });
  });

  it("defaults to not stalled", () => {
    expect(toMigrationDto(migrationRow({}), "destination", 90).stalled).toBe(false);
  });
});

describe("withStalledJob", () => {
  it("flags a migration whose job died for good, dropping the eta but keeping it cancellable", () => {
    const dto = toMigrationDto(migrationRow({}), "destination", 90);
    const stalled = withStalledJob(dto, "destination unreachable");
    expect(stalled).toMatchObject({
      stalled: true,
      etaSeconds: null,
      errorMessage: "destination unreachable",
      cancellable: true,
      // The underlying status is untouched: it is still what storage_migrations
      // actually stores until an explicit cancel reconciles it.
      status: "copying",
    });
  });

  it("falls back to a generic explanation when the job left no error message", () => {
    const dto = toMigrationDto(migrationRow({}), "destination", 90);
    expect(withStalledJob(dto, null).errorMessage).toBe(
      "The background job for this migration is no longer running.",
    );
  });
});

describe("compareTargets", () => {
  it("orders the primary first, then copies by creation", () => {
    const later = new Date(CREATED.getTime() + 1000);
    const rows = [
      { role: "copy" as const, createdAt: later },
      { role: "primary" as const, createdAt: later },
      { role: "copy" as const, createdAt: CREATED },
    ];
    expect(rows.sort(compareTargets)).toEqual([
      { role: "primary", createdAt: later },
      { role: "copy", createdAt: CREATED },
      { role: "copy", createdAt: later },
    ]);
  });
});

describe("toInstallationDefaultDto", () => {
  const defaults = {
    primary: { kind: "local" as const, basePath: "/data/chunks" },
    credentials: undefined,
    copy: { kind: "local" as const, basePath: "/mnt/copy" },
  };

  it("shows the server location to provider admins only", () => {
    expect(toInstallationDefaultDto(defaults, true, { isProviderAdmin: true })).toEqual({
      inUse: true,
      kind: "local",
      location: "/data/chunks",
      hasCopy: true,
      copyLocation: "/mnt/copy",
      misconfigured: false,
    });
    expect(toInstallationDefaultDto(defaults, true, { isProviderAdmin: false })).toMatchObject({
      location: null,
      copyLocation: null,
      hasCopy: true,
    });
  });

  it("reports an unusable environment", () => {
    expect(toInstallationDefaultDto(null, true, { isProviderAdmin: true })).toMatchObject({
      misconfigured: true,
      kind: null,
    });
  });
});

describe("accessKeyIdHint", () => {
  it("keeps only the last four characters", () => {
    expect(accessKeyIdHint("AKIAIOSFODNN7EXAMPLE")).toBe("MPLE");
  });
});
