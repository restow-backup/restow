import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";
import {
  completenessOf,
  defaultRetention,
  hasSecondLocation,
  healthSummary,
  isMigrationActive,
  isMigrationRetryable,
  isMigrationRunning,
  migrationEtaParts,
  migrationSummary,
  objectLockSummary,
  primaryBlockedReason,
  problemFields,
  storageErrorKey,
  targetDisplayName,
} from "./presenters";
import type {
  InstallationDefaultDto,
  MigrationStatus,
  ObjectLockCapability,
  ProbeResult,
  StorageMigrationDto,
  StorageTargetDto,
} from "./types";

const probe = (overrides: Partial<ProbeResult>): ProbeResult => ({
  ok: true,
  checkedAt: "2026-09-01T08:00:00.000Z",
  durationMs: 40,
  steps: [],
  failedStep: null,
  errorCode: null,
  error: null,
  warnings: [],
  ...overrides,
});

const capability = (overrides: Partial<ObjectLockCapability>): ObjectLockCapability => ({
  status: "enabled",
  mode: null,
  defaultRetentionDays: null,
  defaultRetentionYears: null,
  reason: null,
  detail: null,
  checkedAt: "2026-09-01T08:00:00.000Z",
  ...overrides,
});

const defaults = (overrides: Partial<InstallationDefaultDto> = {}): InstallationDefaultDto => ({
  inUse: true,
  kind: "local",
  location: null,
  hasCopy: false,
  copyLocation: null,
  misconfigured: false,
  ...overrides,
});

const target = (role: "primary" | "copy") => ({ role }) as StorageTargetDto;

function problem(type: string, extensions: Record<string, unknown> = {}) {
  return new ApiError(409, { type, title: "x", status: 409, ...extensions }, "x");
}

describe("healthSummary", () => {
  it("says what the last test found", () => {
    expect(healthSummary({ status: "unverified", lastProbe: null, configValid: true })).toEqual({
      key: "health.notTested",
      tone: "warning",
    });
    // A target that answered its test is in order, not a passed restore check: no green.
    expect(healthSummary({ status: "ok", lastProbe: probe({}), configValid: true }).tone).toBe(
      "ok",
    );
    expect(
      healthSummary({
        status: "ok",
        lastProbe: probe({ warnings: ["ephemeral_path"] }),
        configValid: true,
      }),
    ).toEqual({ key: "health.okWithWarnings", tone: "warning" });
    expect(
      healthSummary({
        status: "error",
        lastProbe: probe({ ok: false, errorCode: "bucket_missing", failedStep: "write" }),
        configValid: true,
      }),
    ).toEqual({ key: "health.errors.bucket_missing", tone: "destructive" });
    expect(healthSummary({ status: "ok", lastProbe: probe({}), configValid: false }).key).toBe(
      "health.configInvalid",
    );
  });
});

describe("objectLockSummary", () => {
  it("never calls a filesystem WORM", () => {
    expect(objectLockSummary("local", capability({ status: "enabled" }))).toEqual({
      key: "objectLock.filesystem",
      tone: "warning",
    });
  });

  it("maps every S3 outcome", () => {
    expect(objectLockSummary("s3", null).key).toBe("objectLock.notChecked");
    expect(objectLockSummary("s3", capability({})).key).toBe("objectLock.enabled");
    expect(objectLockSummary("s3", capability({ status: "disabled" })).key).toBe(
      "objectLock.disabled",
    );
    expect(objectLockSummary("s3", capability({ status: "unsupported" })).key).toBe(
      "objectLock.unsupported",
    );
    expect(
      objectLockSummary("s3", capability({ status: "unknown", reason: "access_denied" })).key,
    ).toBe("objectLock.unknownAccess");
  });

  it("reports the default retention", () => {
    expect(defaultRetention(capability({ defaultRetentionYears: 10 }))).toEqual({
      unit: "years",
      count: 10,
    });
    expect(defaultRetention(capability({ defaultRetentionDays: 30 }))).toEqual({
      unit: "days",
      count: 30,
    });
    expect(
      defaultRetention(capability({ status: "disabled", defaultRetentionDays: 30 })),
    ).toBeNull();
  });
});

describe("setup rules for the dialog", () => {
  it("offers primary only to a tenant without data or primary", () => {
    expect(primaryBlockedReason({ items: [], tenantHasData: false })).toBeNull();
    expect(primaryBlockedReason({ items: [], tenantHasData: true })).toBe("tenantHasData");
    expect(primaryBlockedReason({ items: [target("primary")], tenantHasData: false })).toBe(
      "primaryExists",
    );
  });

  it("knows when backups live in a single place", () => {
    expect(hasSecondLocation({ items: [], installationDefault: defaults() })).toBe(false);
    expect(hasSecondLocation({ items: [], installationDefault: defaults({ hasCopy: true }) })).toBe(
      true,
    );
    expect(hasSecondLocation({ items: [target("copy")], installationDefault: defaults() })).toBe(
      true,
    );
    expect(
      hasSecondLocation({
        items: [target("primary")],
        installationDefault: defaults({ inUse: false, hasCopy: true }),
      }),
    ).toBe(false);
  });
});

function migration(overrides: Partial<StorageMigrationDto> = {}): StorageMigrationDto {
  return {
    id: "m1",
    mode: "move",
    status: "copying",
    sourceTargetId: "old",
    destinationTargetId: "new",
    role: "destination",
    objectsTotal: 100,
    objectsDone: 42,
    bytesTotal: 1000,
    bytesDone: 420,
    percent: 42,
    etaSeconds: 90,
    errorMessage: null,
    stalled: false,
    cancellable: true,
    startedAt: "2026-09-24T08:00:00.000Z",
    verifiedAt: null,
    switchedAt: null,
    finishedAt: null,
    createdAt: "2026-09-24T08:00:00.000Z",
    ...overrides,
  };
}

describe("isMigrationActive", () => {
  it("is active while queued, copying, verifying or switching", () => {
    const active: MigrationStatus[] = ["queued", "copying", "verifying", "switching"];
    const finished: MigrationStatus[] = ["completed", "failed", "cancelled"];
    for (const status of active) {
      expect(isMigrationActive(status)).toBe(true);
    }
    for (const status of finished) {
      expect(isMigrationActive(status)).toBe(false);
    }
  });
});

describe("migrationSummary", () => {
  it("shows the copy percentage on the destination", () => {
    expect(migrationSummary(migration({ status: "copying", percent: 42 }))).toMatchObject({
      key: "migration.copying",
      tone: "neutral",
      values: { percent: 42 },
    });
  });

  it("has no percentage while the total is still unknown", () => {
    expect(migrationSummary(migration({ status: "copying", percent: null }))).toMatchObject({
      key: "migration.copyingUnknown",
    });
  });

  it("reads switched on the destination and retirement on the source when done, in order but not green", () => {
    expect(migrationSummary(migration({ status: "completed", role: "destination" }))).toMatchObject(
      { key: "migration.switched", tone: "ok" },
    );
    expect(migrationSummary(migration({ status: "completed", role: "source" }))).toMatchObject({
      key: "migration.retired",
      tone: "ok",
    });
  });

  it("reads as a failure with the destructive tone", () => {
    expect(migrationSummary(migration({ status: "failed" }))).toMatchObject({
      key: "migration.failed",
      tone: "destructive",
    });
  });

  it("reads as stalled, not as its underlying in-progress status, once the job died", () => {
    expect(
      migrationSummary(migration({ status: "copying", percent: 42, stalled: true })),
    ).toMatchObject({ key: "migration.stalled", tone: "destructive" });
    expect(
      migrationSummary(migration({ status: "verifying", role: "source", stalled: true })),
    ).toMatchObject({ key: "migration.stalledSource", tone: "destructive" });
  });
});

describe("isMigrationRunning", () => {
  it("is not running once stalled, even though the status is still an active one", () => {
    expect(isMigrationRunning(migration({ status: "copying", stalled: false }))).toBe(true);
    expect(isMigrationRunning(migration({ status: "copying", stalled: true }))).toBe(false);
    expect(isMigrationRunning(migration({ status: "completed", stalled: false }))).toBe(false);
  });
});

describe("isMigrationRetryable", () => {
  it("is retryable only for a failed move", () => {
    expect(isMigrationRetryable(migration({ status: "failed", mode: "move" }))).toBe(true);
    expect(isMigrationRetryable(migration({ status: "failed", mode: "keep" }))).toBe(false);
    expect(isMigrationRetryable(migration({ status: "copying", mode: "move" }))).toBe(false);
    expect(isMigrationRetryable(migration({ status: "cancelled", mode: "move" }))).toBe(false);
  });
});

describe("migrationEtaParts", () => {
  it("picks the coarsest non-zero unit", () => {
    expect(migrationEtaParts(45)).toEqual({
      key: "migration.eta.seconds",
      values: { hours: 0, minutes: 0, seconds: 45 },
    });
    expect(migrationEtaParts(125)).toEqual({
      key: "migration.eta.minutes",
      values: { hours: 0, minutes: 2, seconds: 5 },
    });
    expect(migrationEtaParts(3725)).toEqual({
      key: "migration.eta.hours",
      values: { hours: 1, minutes: 2, seconds: 5 },
    });
  });

  it("never goes negative or non-finite", () => {
    expect(migrationEtaParts(-5).values).toEqual({ hours: 0, minutes: 0, seconds: 0 });
    expect(migrationEtaParts(Number.NaN).values).toEqual({ hours: 0, minutes: 0, seconds: 0 });
  });
});

describe("targetDisplayName", () => {
  const t = (key: string) => `t(${key})`;

  it("shows the placeholder's kind label instead of its empty name", () => {
    expect(targetDisplayName({ name: "", kind: "installation_default" }, t)).toBe(
      "t(kindLong.installation_default)",
    );
  });

  it("shows the stored name for every other target", () => {
    expect(targetDisplayName({ name: "Offsite Hetzner", kind: "s3" }, t)).toBe("Offsite Hetzner");
    expect(targetDisplayName({ name: "NAS", kind: "local" }, t)).toBe("NAS");
  });
});

describe("API problems", () => {
  it("maps storage problems to feature messages", () => {
    expect(storageErrorKey(problem("urn:restow:problem:storage-tenant-has-data"))).toBe(
      "storage:errors.tenantHasData",
    );
    expect(storageErrorKey(problem("urn:restow:problem:master-key-missing"))).toBe(
      "storage:errors.masterKeyMissing",
    );
    expect(storageErrorKey(problem("urn:restow:problem:storage-keep-target-unreachable"))).toBe(
      "storage:errors.keepTargetUnreachable",
    );
    expect(storageErrorKey(problem("urn:restow:problem:storage-keep-blocked-by-active-job"))).toBe(
      "storage:errors.keepBlockedByActiveJob",
    );
    expect(
      storageErrorKey(problem("urn:restow:problem:storage-previous-holds-exclusive-data")),
    ).toBe("storage:errors.previousHoldsExclusiveData");
    expect(storageErrorKey(problem("urn:restow:problem:storage-active-endpoints"))).toBe(
      "storage:errors.activeEndpoints",
    );
    expect(
      storageErrorKey(problem("urn:restow:problem:storage-previous-holds-endpoint-repositories")),
    ).toBe("storage:errors.previousHoldsEndpointRepositories");
    expect(storageErrorKey(new ApiError(500, null, "boom"))).toBe("common:errors.server");
  });

  it("extracts field problems", () => {
    expect(
      problemFields(
        problem("urn:restow:problem:storage-invalid-location", {
          fields: [{ field: "bucket", reason: "bucket_name" }, { bogus: true }],
        }),
      ),
    ).toEqual([{ field: "bucket", reason: "bucket_name" }]);
    expect(
      problemFields(
        problem("urn:restow:problem:storage-endpoint-not-allowed", {
          field: "endpoint",
          reason: "private_address",
        }),
      ),
    ).toEqual([{ field: "endpoint", reason: "private_address" }]);
    expect(problemFields(new Error("x"))).toEqual([]);
  });

  it("reads the completeness of a refused promotion", () => {
    const completeness = { complete: false };
    expect(
      completenessOf(problem("urn:restow:problem:storage-copy-incomplete", { completeness })),
    ).toBe(completeness);
    expect(completenessOf(problem("urn:restow:problem:storage-not-verified"))).toBeNull();
  });
});
