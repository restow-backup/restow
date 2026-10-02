import {
  type InstallationDefaultStorage,
  type ObjectLockCapability,
  type StorageLocation,
  type StorageProbeResult,
  StorageTargetError,
  describeStorageLocation,
  installationDefaultStorage,
  installationProbePrefix,
  openInstallationDefault,
} from "@restow/core";
import { auditLog, tenants } from "@restow/db";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { Actor } from "./service.js";

/**
 * The installation's default storage as the installation page shows it: what
 * the server's environment describes (STORAGE_TARGET, STORAGE_LOCAL_PATH,
 * S3_*), how many tenants keep their data on it, and the result of the last
 * test somebody ran from the installation page.
 *
 * The same default is tested from a tenant's storage page too
 * (features/storage `testInstallationDefault`); that test is recorded for the
 * tenant and feeds its setup checklist. This one belongs to no tenant: it is
 * recorded in the installation audit chain, probes below the installation's own
 * area of the store (`installation/probes/`) and leaves a tenant's checklist
 * alone, so it can be run before the first tenant exists.
 */

export const DEFAULT_STORAGE_AUDIT_ACTIONS = {
  tested: "settings.default_storage.tested",
} as const;

/** Problem type when the environment does not describe a usable default. */
export const DEFAULT_STORAGE_MISCONFIGURED_PROBLEM =
  "urn:restow:problem:settings-default-storage-misconfigured";

/** What a recorded test of the default says; the probe details stay in the audit entry. */
export interface DefaultStorageLastTest {
  ok: boolean;
  testedAt: string;
  /** Email of the provider admin who ran it. */
  testedBy: string;
  failedStep: string | null;
  errorCode: string | null;
}

export interface DefaultStorageView {
  /** False when the environment's storage settings are invalid. */
  configured: boolean;
  kind: StorageLocation["kind"] | null;
  /** A path, or `s3://bucket/prefix (host)`; never credentials. */
  location: string | null;
  /** The environment configures a copy path (STORAGE_COPY_LOCAL_PATH). */
  copyLocation: string | null;
  tenants: {
    total: number;
    /** Tenants without a primary target of their own, so their data is on this default. */
    usingDefault: number;
  };
  lastTest: DefaultStorageLastTest | null;
}

export interface DefaultStorageTestResult {
  probe: StorageProbeResult;
  objectLock: ObjectLockCapability | null;
  view: DefaultStorageView;
}

export interface DefaultStorageDeps {
  /** Environment of the installation default (tests inject theirs). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}

function readDefault(deps: DefaultStorageDeps): InstallationDefaultStorage | null {
  try {
    return installationDefaultStorage(deps.env ?? process.env);
  } catch (error) {
    if (error instanceof StorageTargetError) {
      return null;
    }
    throw error;
  }
}

function misconfigured(): ProblemError {
  return new ProblemError(503, "Default storage not configured", {
    type: DEFAULT_STORAGE_MISCONFIGURED_PROBLEM,
    detail: "The storage settings in the environment (STORAGE_TARGET, S3_*) are invalid.",
  });
}

async function tenantCounts(db: DbExecutor): Promise<DefaultStorageView["tenants"]> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`.mapWith(Number),
      // Spelled out: a single-table select leaves the columns unqualified, which would
      // bind both sides of the correlation to the inner table.
      usingDefault: sql<number>`count(*) filter (where not exists (
        select 1 from storage_targets as st
        where st.tenant_id = tenants.id and st.role = 'primary'
      ))`.mapWith(Number),
    })
    .from(tenants);
  return { total: row?.total ?? 0, usingDefault: row?.usingDefault ?? 0 };
}

/** The newest test of the default recorded in the installation chain, or null. */
async function lastTestOf(db: DbExecutor): Promise<DefaultStorageLastTest | null> {
  const [row] = await db
    .select({
      createdAt: auditLog.createdAt,
      actor: auditLog.actor,
      ok: sql<string | null>`${auditLog.details}->>'ok'`,
      failedStep: sql<string | null>`${auditLog.details}->>'failedStep'`,
      errorCode: sql<string | null>`${auditLog.details}->>'errorCode'`,
    })
    .from(auditLog)
    .where(
      and(isNull(auditLog.tenantId), eq(auditLog.action, DEFAULT_STORAGE_AUDIT_ACTIONS.tested)),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    ok: row.ok === "true",
    testedAt: row.createdAt.toISOString(),
    testedBy: row.actor,
    failedStep: row.failedStep,
    errorCode: row.errorCode,
  };
}

/** Where the default lives, how many tenants use it and when it was last tested. */
export async function getDefaultStorage(
  db: DbExecutor,
  deps: DefaultStorageDeps = {},
): Promise<DefaultStorageView> {
  const defaults = readDefault(deps);
  const [counts, lastTest] = await Promise.all([tenantCounts(db), lastTestOf(db)]);
  return {
    configured: defaults !== null,
    kind: defaults?.primary.kind ?? null,
    location: defaults ? describeStorageLocation(defaults.primary) : null,
    copyLocation: defaults?.copy ? describeStorageLocation(defaults.copy) : null,
    tenants: counts,
    lastTest,
  };
}

/**
 * Write, read, list and delete a small object on the default and detect Object
 * Lock, then record the outcome in the installation audit chain. A directory
 * that does not exist yet is not a failure: the default creates it on the first
 * write.
 */
export async function testDefaultStorage(
  db: DbExecutor,
  actor: Actor,
  deps: DefaultStorageDeps = {},
): Promise<DefaultStorageTestResult> {
  const now = deps.now ?? (() => new Date());
  const defaults = readDefault(deps);
  if (!defaults) {
    throw misconfigured();
  }
  const opened = openInstallationDefault(defaults, "probe");
  const probe = await opened.primary.probe({
    keyPrefix: installationProbePrefix(),
    requireExistingPath: false,
    now,
  });
  const objectLock =
    opened.primary.location.kind === "local" || probe.ok
      ? await opened.primary.detectObjectLock(now)
      : null;

  await audit(db, {
    actor: actor.email,
    actorUserId: actor.id,
    action: DEFAULT_STORAGE_AUDIT_ACTIONS.tested,
    target: "installation_default",
    targetType: "storage_location",
    ip: actor.ip,
    details: {
      ok: probe.ok,
      failedStep: probe.failedStep,
      errorCode: probe.errorCode,
      durationMs: probe.durationMs,
      warnings: probe.warnings,
      objectLock: objectLock?.status ?? null,
    },
  });
  return { probe, objectLock, view: await getDefaultStorage(db, deps) };
}
