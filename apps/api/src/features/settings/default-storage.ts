import {
  DEFAULT_STORAGE_SECRET_KIND,
  type InstallationDefaultDocument,
  type InstallationDefaultResolution,
  InstallationDefaultResolver,
  type InstallationDefaultStorage,
  type ObjectLockCapability,
  type OpenedStorageTarget,
  type S3CredentialsSecret,
  type StorageLocation,
  type StorageProbeResult,
  StorageTargetError,
  describeStorageLocation,
  installationDefaultDocument,
  installationDefaultStorage,
  installationProbePrefix,
  openInstallationDefault,
  openStorageLocation,
  serializeInstallationDefaultDocument,
  storageLocationMoves,
  validateStorageLocation,
} from "@restow/core";
import {
  auditLog,
  endpoints,
  findInstallationSecret,
  jobs,
  packs,
  storageMigrations,
  storageTargets,
  tenants,
} from "@restow/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import {
  installationDefaultResolver,
  invalidateInstallationDefault,
} from "../../lib/installation-default.js";
import {
  deleteProviderSecrets,
  findProviderSecret,
  installationSecretsKey,
  replaceSecret,
  storeSecret,
} from "../../lib/secrets.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { accessKeyIdHint } from "../storage/dto.js";
import { credentialsBoundElsewhere } from "../storage/rules.js";
import {
  STORAGE_WRITING_QUEUES,
  UNFINISHED_MIGRATION_STATUSES,
  invalidLocationProblem,
} from "../storage/service.js";
import type { SaveDefaultStorageInput } from "./schemas.js";
import type { Actor } from "./service.js";

/**
 * The installation's default storage as the installation page shows and
 * changes it (docs/STORAGE.md, "Installation default"): where tenants without
 * a primary target of their own keep their data, where that setting comes
 * from (saved here, or the server's environment: STORAGE_TARGET,
 * STORAGE_LOCAL_PATH, S3_*), how many tenants use it, which tenants hold data
 * on it, and the result of the last test.
 *
 * Saving: the default is one JSON document sealed in the secret store
 * (installation level, kind `default_storage`); the S3 key pair inside it is
 * write-only like a tenant target's. Every reader in the API and the worker
 * resolves the default through @restow/core's InstallationDefaultResolver, so
 * a saved default replaces the environment's everywhere; removing it falls
 * back to the environment.
 *
 * Changing where the default points would orphan the data tenants already
 * keep there: a change that moves the location is refused (409
 * {@link DEFAULT_STORAGE_IN_USE_PROBLEM}) while any tenant holds data on the
 * current default, has a retired default attached as its `previous` target,
 * is moving off it, or has a storage job queued or running on it. A change
 * that keeps the location (credentials, region, addressing style) is always
 * possible. The new location is probed first (write, read, list, delete);
 * an unreachable or read-only location is refused.
 *
 * The test (POST /test) belongs to no tenant: it is recorded in the
 * installation audit chain and probes below the installation's own area of
 * the store (`installation/probes/`).
 */

export const DEFAULT_STORAGE_AUDIT_ACTIONS = {
  tested: "settings.default_storage.tested",
  saved: "settings.default_storage.saved",
  removed: "settings.default_storage.removed",
} as const;

const PROBLEM_PREFIX = "urn:restow:problem:settings-default-storage-";

/** Problem type when the default that applies is not usable. */
export const DEFAULT_STORAGE_MISCONFIGURED_PROBLEM = `${PROBLEM_PREFIX}misconfigured`;
/** Problem type of a change refused because tenants keep data on the current default. */
export const DEFAULT_STORAGE_IN_USE_PROBLEM = `${PROBLEM_PREFIX}in-use`;
/** Problem type of a change refused because the new location failed the probe. */
export const DEFAULT_STORAGE_UNREACHABLE_PROBLEM = `${PROBLEM_PREFIX}unreachable`;
/** Problem type of a removal refused because the environment describes no usable default. */
export const DEFAULT_STORAGE_ENVIRONMENT_INVALID_PROBLEM = `${PROBLEM_PREFIX}environment-invalid`;
/** Problem type of an S3 default saved without a key pair it can keep. */
export const DEFAULT_STORAGE_CREDENTIALS_REQUIRED_PROBLEM = `${PROBLEM_PREFIX}credentials-required`;

/** Serializes concurrent changes of the single default (transaction-scoped). */
const LOCK_KEY = "restow.settings.default_storage";

/** What a recorded test of the default says; the probe details stay in the audit entry. */
export interface DefaultStorageLastTest {
  ok: boolean;
  testedAt: string;
  /** Email of the provider admin who ran it. */
  testedBy: string;
  failedStep: string | null;
  errorCode: string | null;
}

/** Why a tenant keeps the current default from moving. */
export type DefaultStorageBlockReason =
  /** Backups (packs) or agent repositories on the default, no primary target of its own. */
  | "data"
  /** A retired default attached read-only as `previous` (a "keep" replacement). */
  | "previous"
  /** A storage migration off the default is still running. */
  | "migration"
  /** A job that writes to storage is queued or running while the tenant uses the default. */
  | "active_job";

export interface DefaultStorageBlocker {
  tenantId: string;
  tenantName: string;
  reasons: DefaultStorageBlockReason[];
}

/** The addressing of the saved default as the edit form needs it; never the secret. */
export interface SavedDefaultStorage {
  kind: StorageLocation["kind"];
  local: { basePath: string } | null;
  s3: {
    bucket: string;
    prefix: string | null;
    endpoint: string | null;
    region: string;
    forcePathStyle: boolean;
    hasCredentials: boolean;
    /** Last four characters of the access key id. */
    accessKeyIdHint: string | null;
  } | null;
  updatedAt: string;
  updatedBy: string;
}

export interface DefaultStorageView {
  /** False when the default that applies is not usable. */
  configured: boolean;
  /** Where the default that applies comes from. */
  source: "database" | "environment";
  kind: StorageLocation["kind"] | null;
  /** A path, or `s3://bucket/prefix (host)`; never credentials. */
  location: string | null;
  /** The environment configures a copy path (STORAGE_COPY_LOCAL_PATH). */
  copyLocation: string | null;
  /** Why the default is not usable (names variables or this page, never a credential). */
  problem: string | null;
  /** The default saved on this page, or null when the environment applies. */
  saved: SavedDefaultStorage | null;
  /** What the environment describes, shown next to a saved default (which wins). */
  environment: {
    configured: boolean;
    kind: StorageLocation["kind"] | null;
    location: string | null;
  };
  tenants: {
    total: number;
    /** Tenants without a primary target of their own, so their data is on this default. */
    usingDefault: number;
  };
  /** Tenants that keep the location from changing (a change that keeps it is always possible). */
  blockers: DefaultStorageBlocker[];
  lastTest: DefaultStorageLastTest | null;
}

export interface DefaultStorageTestResult {
  probe: StorageProbeResult;
  objectLock: ObjectLockCapability | null;
  view: DefaultStorageView;
}

export interface DefaultStorageChangeResult {
  /** The probe of the location that applies now; null when nothing changed. */
  probe: StorageProbeResult | null;
  objectLock: ObjectLockCapability | null;
  view: DefaultStorageView;
}

export interface DefaultStorageDeps {
  /**
   * Environment of the installation default (tests inject theirs; the saved
   * default is then read on `db` without a cache). Omitted, the process-wide
   * resolver applies (lib/installation-default.ts).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
  /** Opens a location for the probe (tests). */
  readonly open?: (
    location: StorageLocation,
    credentials: S3CredentialsSecret | undefined,
  ) => OpenedStorageTarget;
}

function resolverFor(db: DbExecutor, deps: DefaultStorageDeps): InstallationDefaultResolver {
  if (!deps.env) {
    return installationDefaultResolver();
  }
  return new InstallationDefaultResolver({
    env: deps.env,
    loadStored: () => findInstallationSecret(db, DEFAULT_STORAGE_SECRET_KIND),
    installationKey: installationSecretsKey,
    ttlMs: 0,
  });
}

/** The default as it is right now, read afresh (a change must never act on a stale answer). */
async function freshResolution(
  db: DbExecutor,
  deps: DefaultStorageDeps,
): Promise<InstallationDefaultResolution> {
  const resolver = resolverFor(db, deps);
  resolver.invalidate();
  return resolver.resolve();
}

function environmentDefault(deps: DefaultStorageDeps): InstallationDefaultStorage | null {
  try {
    return installationDefaultStorage(deps.env ?? process.env);
  } catch (error) {
    if (error instanceof StorageTargetError) {
      return null;
    }
    throw error;
  }
}

function misconfigured(detail: string | null): ProblemError {
  return new ProblemError(503, "Default storage not configured", {
    type: DEFAULT_STORAGE_MISCONFIGURED_PROBLEM,
    detail:
      detail ??
      "Neither the default storage saved here nor the storage settings in the environment (STORAGE_TARGET, S3_*) are usable.",
  });
}

function inUse(blockers: DefaultStorageBlocker[]): ProblemError {
  return new ProblemError(409, "Tenants keep data on the default storage", {
    type: DEFAULT_STORAGE_IN_USE_PROBLEM,
    detail:
      "Some tenants keep backups on the current default storage. Pointing the default elsewhere would leave that data behind. Move those tenants to a storage target of their own first (Replace the primary, move), or copy the data to the new location and keep its address unchanged.",
    extensions: { code: "default_storage_in_use", blockers },
  });
}

function unreachable(probe: StorageProbeResult): ProblemError {
  return new ProblemError(422, "Storage not reachable", {
    type: DEFAULT_STORAGE_UNREACHABLE_PROBLEM,
    detail:
      "The location could not be verified with a write, read, list and delete check, so it was not saved. Fix the location or the credentials and try again.",
    extensions: { code: "default_storage_unreachable", probe },
  });
}

function credentialsRequired(): ProblemError {
  return new ProblemError(422, "Credentials required", {
    type: DEFAULT_STORAGE_CREDENTIALS_REQUIRED_PROBLEM,
    detail:
      "Enter the access key pair. Stored credentials are only sent to the endpoint they were saved for.",
    extensions: { field: "credentials", reason: "required" },
  });
}

function environmentInvalid(): ProblemError {
  return new ProblemError(409, "The environment describes no usable storage", {
    type: DEFAULT_STORAGE_ENVIRONMENT_INVALID_PROBLEM,
    detail:
      "Without the default saved here, the storage settings in the environment (STORAGE_TARGET, STORAGE_LOCAL_PATH, S3_*) would apply, and they are not usable. Fix them first, or keep the saved default.",
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

/**
 * Every tenant whose data on the current default would be orphaned by moving
 * it. Read across tenants on the installation pool (or a transaction on it).
 */
export async function defaultStorageBlockers(db: DbExecutor): Promise<DefaultStorageBlocker[]> {
  const rows = await db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .orderBy(asc(tenants.name));
  if (rows.length === 0) {
    return [];
  }
  const [primaries, packOwners, repositoryOwners, placeholders, migrating, busy] =
    await Promise.all([
      db
        .selectDistinct({ tenantId: storageTargets.tenantId })
        .from(storageTargets)
        .where(eq(storageTargets.role, "primary")),
      // One indexed probe per tenant (packs_tenant_path_uq), not a scan of every pack.
      db
        .select({ tenantId: tenants.id })
        .from(tenants)
        .where(sql`exists (select 1 from ${packs} where ${packs.tenantId} = ${tenants.id})`),
      db
        .selectDistinct({ tenantId: endpoints.tenantId })
        .from(endpoints)
        .where(isNotNull(endpoints.repositorySecretId)),
      db
        .selectDistinct({ tenantId: storageTargets.tenantId })
        .from(storageTargets)
        .where(
          and(eq(storageTargets.kind, "installation_default"), eq(storageTargets.role, "previous")),
        ),
      db
        .selectDistinct({ tenantId: storageMigrations.tenantId })
        .from(storageMigrations)
        .where(
          and(
            isNull(storageMigrations.sourceTargetId),
            inArray(storageMigrations.status, [...UNFINISHED_MIGRATION_STATUSES]),
          ),
        ),
      db
        .selectDistinct({ tenantId: jobs.tenantId })
        .from(jobs)
        .where(
          and(
            inArray(jobs.queue, [...STORAGE_WRITING_QUEUES]),
            inArray(jobs.status, ["queued", "active"]),
          ),
        ),
    ]);
  const set = (list: { tenantId: string | null }[]) =>
    new Set(list.map((row) => row.tenantId).filter((id): id is string => id !== null));
  const withPrimary = set(primaries);
  const withPacks = set(packOwners);
  const withRepositories = set(repositoryOwners);
  const withPlaceholder = set(placeholders);
  const withMigration = set(migrating);
  const withJob = set(busy);

  const blockers: DefaultStorageBlocker[] = [];
  for (const tenant of rows) {
    const reasons: DefaultStorageBlockReason[] = [];
    const onDefault = !withPrimary.has(tenant.id);
    if (onDefault && (withPacks.has(tenant.id) || withRepositories.has(tenant.id))) {
      reasons.push("data");
    }
    if (withPlaceholder.has(tenant.id)) {
      reasons.push("previous");
    }
    if (withMigration.has(tenant.id)) {
      reasons.push("migration");
    }
    if (onDefault && withJob.has(tenant.id)) {
      reasons.push("active_job");
    }
    if (reasons.length > 0) {
      blockers.push({ tenantId: tenant.id, tenantName: tenant.name, reasons });
    }
  }
  return blockers;
}

/** The newest test of the default recorded in the installation chain (a save probes too), or null. */
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
      and(
        isNull(auditLog.tenantId),
        inArray(auditLog.action, [
          DEFAULT_STORAGE_AUDIT_ACTIONS.tested,
          DEFAULT_STORAGE_AUDIT_ACTIONS.saved,
        ]),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  if (!row || row.ok === null) {
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

function savedView(document: InstallationDefaultDocument | null): SavedDefaultStorage | null {
  if (!document) {
    return null;
  }
  const validation = validateStorageLocation(document.kind, document.config);
  const location = validation.ok ? validation.location : null;
  return {
    kind: document.kind,
    local: location?.kind === "local" ? { basePath: location.basePath } : null,
    s3:
      location?.kind === "s3"
        ? {
            bucket: location.bucket,
            prefix: location.prefix,
            endpoint: location.endpoint,
            region: location.region,
            forcePathStyle: location.forcePathStyle,
            hasCredentials: document.credentials !== null,
            accessKeyIdHint: document.credentials
              ? accessKeyIdHint(document.credentials.accessKeyId)
              : null,
          }
        : null,
    updatedAt: document.updatedAt,
    updatedBy: document.updatedBy,
  };
}

function viewOf(
  resolution: InstallationDefaultResolution,
  deps: DefaultStorageDeps,
  counts: DefaultStorageView["tenants"],
  blockers: DefaultStorageBlocker[],
  lastTest: DefaultStorageLastTest | null,
): DefaultStorageView {
  const ready = resolution.status === "ready" ? resolution : null;
  const environment = environmentDefault(deps);
  return {
    configured: ready !== null,
    source: resolution.source,
    kind: ready?.storage.primary.kind ?? null,
    location: ready ? describeStorageLocation(ready.storage.primary) : null,
    copyLocation: ready?.storage.copy ? describeStorageLocation(ready.storage.copy) : null,
    problem: resolution.status === "unusable" ? resolution.detail : null,
    saved: savedView(ready?.document ?? null),
    environment: {
      configured: environment !== null,
      kind: environment?.primary.kind ?? null,
      location: environment ? describeStorageLocation(environment.primary) : null,
    },
    tenants: counts,
    blockers,
    lastTest,
  };
}

/** Where the default lives and where that comes from, who uses it, and when it was last tested. */
export async function getDefaultStorage(
  db: DbExecutor,
  deps: DefaultStorageDeps = {},
): Promise<DefaultStorageView> {
  const resolution = await resolverFor(db, deps).resolve();
  const [counts, blockers, lastTest] = await Promise.all([
    tenantCounts(db),
    defaultStorageBlockers(db),
    lastTestOf(db),
  ]);
  return viewOf(resolution, deps, counts, blockers, lastTest);
}

function openFor(
  deps: DefaultStorageDeps,
  location: StorageLocation,
  credentials: S3CredentialsSecret | undefined,
): OpenedStorageTarget {
  return deps.open
    ? deps.open(location, credentials)
    : openStorageLocation(location, { credentials, purpose: "probe" });
}

/** Probe and Object Lock detection, as the test of the default and a tenant target's test run them. */
async function check(
  opened: OpenedStorageTarget,
  requireExistingPath: boolean,
  now: () => Date,
): Promise<{ probe: StorageProbeResult; objectLock: ObjectLockCapability | null }> {
  const probe = await opened.probe({
    keyPrefix: installationProbePrefix(),
    requireExistingPath,
    now,
  });
  const objectLock =
    opened.location.kind === "local" || probe.ok ? await opened.detectObjectLock(now) : null;
  return { probe, objectLock };
}

function probeDetails(probe: StorageProbeResult, objectLock: ObjectLockCapability | null) {
  return {
    ok: probe.ok,
    failedStep: probe.failedStep,
    errorCode: probe.errorCode,
    durationMs: probe.durationMs,
    warnings: probe.warnings,
    objectLock: objectLock?.status ?? null,
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
  const resolution = await resolverFor(db, deps).resolve();
  if (resolution.status !== "ready") {
    throw misconfigured(resolution.detail);
  }
  const opened = deps.open
    ? deps.open(resolution.storage.primary, resolution.storage.credentials)
    : openInstallationDefault(resolution.storage, "probe").primary;
  const { probe, objectLock } = await check(opened, false, now);

  await audit(db, {
    actor: actor.email,
    actorUserId: actor.id,
    action: DEFAULT_STORAGE_AUDIT_ACTIONS.tested,
    target: "installation_default",
    targetType: "storage_location",
    ip: actor.ip,
    details: probeDetails(probe, objectLock),
  });
  return { probe, objectLock, view: await getDefaultStorage(db, deps) };
}

/** Refuse moving the default away from `current` while tenants keep data there. */
async function assertMayMove(
  tx: DbExecutor,
  current: InstallationDefaultResolution,
  next: StorageLocation,
): Promise<void> {
  // An unusable default (an invalid environment, a document the master key no longer
  // opens) is being repaired: nothing can be read from or written to it as it stands.
  if (current.status !== "ready") {
    return;
  }
  if (!storageLocationMoves(current.storage.primary, next)) {
    return;
  }
  const blockers = await defaultStorageBlockers(tx);
  if (blockers.length > 0) {
    throw inUse(blockers);
  }
}

async function lock(tx: DbExecutor): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
}

/**
 * Save the default (Installation → Default storage). The location is probed
 * first and refused when it fails; a change that moves the location is refused
 * while tenants keep data on the current default. Without a new key pair, an
 * S3 default keeps the saved one as long as the endpoint stays the same.
 */
export async function saveDefaultStorage(
  db: DbExecutor,
  input: SaveDefaultStorageInput,
  actor: Actor,
  deps: DefaultStorageDeps = {},
): Promise<DefaultStorageChangeResult> {
  const now = deps.now ?? (() => new Date());
  const validation = validateStorageLocation(input.kind, input.config);
  if (!validation.ok) {
    throw invalidLocationProblem(validation.issues);
  }
  const location = validation.location;
  const current = await freshResolution(db, deps);
  // Refused before the probe: a change that cannot be saved should not write to the location.
  await assertMayMove(db, current, location);

  let credentials: S3CredentialsSecret | null = null;
  if (location.kind === "s3") {
    if (input.kind === "s3" && input.credentials) {
      credentials = {
        accessKeyId: input.credentials.accessKeyId,
        secretAccessKey: input.credentials.secretAccessKey,
      };
    } else {
      // The saved pair is kept, but only for the endpoint it was saved for.
      const saved = current.status === "ready" && current.source === "database" ? current : null;
      if (
        !saved?.storage.credentials ||
        credentialsBoundElsewhere(saved.storage.primary, location)
      ) {
        throw credentialsRequired();
      }
      credentials = saved.storage.credentials;
    }
  }

  const { probe, objectLock } = await check(
    openFor(deps, location, credentials ?? undefined),
    true,
    now,
  );
  if (!probe.ok) {
    throw unreachable(probe);
  }

  const document = installationDefaultDocument(location, credentials, actor.email, now());
  await db.transaction(async (tx) => {
    await lock(tx);
    // Again under the lock: a backup may have written its first pack meanwhile.
    await assertMayMove(tx, await freshResolution(tx, deps), location);
    const plaintext = serializeInstallationDefaultDocument(document);
    const ref = await findProviderSecret(tx, DEFAULT_STORAGE_SECRET_KIND);
    if (ref) {
      await replaceSecret(tx, ref, plaintext);
    } else {
      await storeSecret(tx, { kind: DEFAULT_STORAGE_SECRET_KIND, plaintext });
    }
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: DEFAULT_STORAGE_AUDIT_ACTIONS.saved,
      target: "installation_default",
      targetType: "storage_location",
      ip: actor.ip,
      details: {
        ...probeDetails(probe, objectLock),
        kind: location.kind,
        location: describeStorageLocation(location),
        previousSource: current.source,
        previousLocation:
          current.status === "ready" ? describeStorageLocation(current.storage.primary) : null,
        locationChanged:
          current.status !== "ready" || storageLocationMoves(current.storage.primary, location),
        credentialsChanged: input.kind === "s3" && input.credentials !== undefined,
      },
    });
  });
  invalidateInstallationDefault();
  return { probe, objectLock, view: await getDefaultStorage(db, deps) };
}

/**
 * Remove the saved default, so the environment applies again. Refused when
 * the environment describes no usable storage, when it fails the probe, and
 * (like a save) when it points elsewhere while tenants keep data on the
 * saved default.
 */
export async function removeDefaultStorage(
  db: DbExecutor,
  actor: Actor,
  deps: DefaultStorageDeps = {},
): Promise<DefaultStorageChangeResult> {
  const now = deps.now ?? (() => new Date());
  const environment = environmentDefault(deps);
  if (!environment) {
    throw environmentInvalid();
  }
  const current = await freshResolution(db, deps);
  if (current.source === "environment") {
    // Nothing saved, nothing to remove.
    return { probe: null, objectLock: null, view: await getDefaultStorage(db, deps) };
  }
  await assertMayMove(db, current, environment.primary);
  const { probe, objectLock } = await check(
    openFor(deps, environment.primary, environment.credentials),
    false,
    now,
  );
  if (!probe.ok) {
    throw unreachable(probe);
  }
  await db.transaction(async (tx) => {
    await lock(tx);
    await assertMayMove(tx, await freshResolution(tx, deps), environment.primary);
    await deleteProviderSecrets(tx, DEFAULT_STORAGE_SECRET_KIND);
    await audit(tx, {
      actor: actor.email,
      actorUserId: actor.id,
      action: DEFAULT_STORAGE_AUDIT_ACTIONS.removed,
      target: "installation_default",
      targetType: "storage_location",
      ip: actor.ip,
      details: {
        ...probeDetails(probe, objectLock),
        previousLocation:
          current.status === "ready" ? describeStorageLocation(current.storage.primary) : null,
        location: describeStorageLocation(environment.primary),
      },
    });
  });
  invalidateInstallationDefault();
  return { probe, objectLock, view: await getDefaultStorage(db, deps) };
}
