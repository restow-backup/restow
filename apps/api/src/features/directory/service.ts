import {
  type AccountIssue,
  type AccountRow,
  type DirectoryLastRun,
  type GroupSummary,
  type ImapAccountInput,
  type ProtectionOverride,
  type ProtectionRulesDto,
  TokenAcquisitionError,
  isGraphError,
  normalizeAccounts,
  parseImapAccountsCsv,
  readDirectoryState,
  readProtection,
  rulesToRecord,
  searchGroups,
  writeDirectoryState,
  writeOverride,
  writeRules,
} from "@restow/core";
import {
  type CredentialStatus,
  type Database,
  type Job,
  type ProtectedObject,
  type Source,
  jobs,
  legalHolds,
  protectedObjects,
  snapshots,
  sources,
  users,
} from "@restow/db";
import { productName } from "@restow/i18n";
import { type SQL, and, asc, count, desc, eq, ilike, inArray, ne, not, or, sql } from "drizzle-orm";
import { config as processConfig } from "../../config.js";
import { audit } from "../../lib/audit.js";
import { deleteSecret, readSecret, replaceSecret, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { type FailureDto, causeToRecord, failureDto } from "../failures/dto.js";
import { causeOfImapProbe } from "../failures/probe.js";
import type { JobThrottleDto } from "../jobs/dto.js";
import { enqueueFirstBackups } from "../jobs/service.js";
import { graphClientFor } from "../sources/entra.js";
import { storedHostMayBePrivate } from "../sources/imap-host.js";
import {
  type ImapProbeFailure,
  type ImapProbeInput,
  type ImapProbeResult,
  probeImapConnection,
} from "../sources/imap.js";
import type { ImapAuthMode } from "../sources/schemas.js";
import { loadObjectVerifications } from "../verify/verification-state.js";
import { type EnqueueOutcome, enqueueDirectorySync, findPendingSync } from "./enqueue.js";
import {
  containsPattern,
  decideOverride,
  fullSyncPending,
  isNotSelected,
  rulesFromInput,
} from "./logic.js";
import {
  type BulkProtectionInput,
  MAX_BULK_OBJECTS,
  type ObjectCredentialInput,
  type ObjectsFilter,
  type ObjectsQuery,
  type PeopleQuery,
  type ProtectionOverrideInput,
  type RulesInput,
} from "./schemas.js";

/**
 * Directory service: the protected objects of a tenant, the rules that decide
 * them, per-object decisions, sync control for M365 sources and the account
 * list of IMAP sources. Everything runs inside the tenant's RLS context and
 * every change is audited.
 */

/** Audit actions of this feature. */
export const DIRECTORY_AUDIT_ACTIONS = {
  rulesUpdated: "directory.rules.updated",
  syncRequested: "directory.sync.requested",
  protectionChanged: "directory.protection.changed",
  bulkProtectionChanged: "directory.protection.bulk_changed",
  accountsImported: "directory.accounts.imported",
  accountDeleted: "directory.account.deleted",
  credentialSet: "directory.account.credential_set",
  credentialTested: "directory.account.credential_tested",
} as const;

/** Who acts: a signed-in person, or an API key on behalf of an integration. */
export interface Actor {
  /** better-auth user id; null for API keys. */
  userId: string | null;
  /** Audit label: an address or `api-key:<id>`. */
  label: string;
  ip: string | null;
}

export type ObjectKind = ProtectedObject["kind"];
export type ObjectStatus = ProtectedObject["status"];
export type RecoveryReadiness = "green" | "yellow" | "red";

export interface ObjectCounts {
  total: number;
  active: number;
  excluded: number;
  orphaned: number;
  mailbox: number;
  onedrive: number;
  imap: number;
}

export interface PendingSyncDto {
  id: string;
  status: "queued" | "active";
  startedAt: string | null;
  /** While Microsoft Graph makes the running sync wait (`jobs.payload.runtime.throttle`). */
  throttle: JobThrottleDto | null;
}

/** The last sync run as the client sees it: the stored run, its cause turned into a DTO. */
export type DirectoryLastRunDto = Omit<DirectoryLastRun, "failure"> & {
  /** Why the run failed and what to do; null for a green run or a run stored before causes existed. */
  failure: FailureDto | null;
};

export interface SourceSyncDto {
  lastRun: DirectoryLastRunDto | null;
  lastFullSyncAt: string | null;
  /** An admin asked for a full enumeration that has not run yet. */
  fullSyncPending: boolean;
  pendingJob: PendingSyncDto | null;
}

export interface DirectorySourceDto {
  id: string;
  name: string;
  kind: Source["kind"];
  status: Source["status"];
  errorMessage: string | null;
  /** The classified cause behind `errorMessage`; null for a healthy source or a text-only row. */
  failure: FailureDto | null;
  lastSyncAt: string | null;
  /** M365: admin consent was granted (the source knows its Entra tenant). */
  consentGranted: boolean;
  /** Null for IMAP sources: they have no directory to apply rules to. */
  rules: ProtectionRulesDto | null;
  overrideCount: number;
  /** Null for IMAP sources. */
  sync: SourceSyncDto | null;
  /** Null for M365 sources; `"shared"` when absent, same default as everywhere else (docs/IMAP.md). */
  imapAuthMode: ImapAuthMode | null;
  counts: ObjectCounts;
}

export interface ProtectedObjectDto {
  id: string;
  sourceId: string;
  sourceName: string;
  sourceKind: Source["kind"];
  kind: ObjectKind;
  origin: ProtectedObject["origin"];
  status: ObjectStatus;
  externalId: string;
  displayName: string | null;
  userId: string | null;
  email: string | null;
  upn: string | null;
  /** Sign-in disabled member with a mailbox: shared, resource or blocked. */
  sharedOrBlocked: boolean;
  /** Admin decision that beats the rules (M365 objects only). */
  override: ProtectionOverride | null;
  /**
   * `excluded` only because the source is in `selected` mode and nothing
   * chose this object — the mode's default, not a decision against it. Shown
   * as "Not selected" instead of "Excluded".
   */
  notSelected: boolean;
  lastBackupAt: string | null;
  snapshotCount: number;
  /** An active legal hold is placed on this object: it cannot be removed, and its backups are kept. */
  legalHold: boolean;
  latestBackupJob: {
    id: string;
    status: Job["status"];
    at: string;
    /** Why that backup failed, when it did and the cause is known. */
    failure: FailureDto | null;
  } | null;
  readiness: { rating: RecoveryReadiness; checkedAt: string } | null;
  /**
   * The IMAP account's own sealed password (`imapAuthMode: "per_mailbox"`) or a
   * master-user login test (docs/IMAP.md): whether one is set, and the result
   * of the last "test login". Null for every non-IMAP object.
   *
   * `authMode` is the parent source's `imapAuthMode` at read time, so the UI
   * can tell the cases apart: only `per_mailbox` needs, and ever shows, its
   * own password (`hasPassword`/"Set password"); `shared` and `master_user`
   * mailboxes never carry one of their own, so `hasPassword` there is not a
   * missing-credential signal, only the result of the last "test login" is.
   */
  credential: {
    authMode: ImapAuthMode;
    hasPassword: boolean;
    status: CredentialStatus | null;
    checkedAt: string | null;
    error: string | null;
    /** `error`'s reason, for a translated hint; the raw text is only ever secondary detail. */
    errorReason: ImapProbeFailure | null;
    /** The classified cause of a failed login test (why, what to do); null when it passed or was never tested. */
    failure: FailureDto | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectsPage {
  items: ProtectedObjectDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Why a sync that a change asked for was not queued. */
export type SyncNotQueuedReason = "source_disabled" | "consent_outstanding" | "queue_unavailable";

export type SyncQueueResult =
  | EnqueueOutcome
  | { status: "not_queued"; reason: SyncNotQueuedReason };

export interface RulesResult {
  rules: ProtectionRulesDto;
  sync: SyncQueueResult;
}

export interface ProtectionResult {
  object: ProtectedObjectDto;
  /** Set when the decision needs a sync to settle (a reset of an M365 object). */
  sync: SyncQueueResult | null;
}

export interface UserProtectionResult {
  userId: string;
  action: ProtectionOverrideInput["action"];
  objects: ProtectedObjectDto[];
  sync: SyncQueueResult | null;
}

export interface BulkProtectionResult {
  sourceId: string;
  action: ProtectionOverrideInput["action"];
  /** Objects named or matched by the filter, before applying to the source's own. */
  matched: number;
  /** Of those, how many actually belong to this source and were changed. */
  updated: number;
  sync: SyncQueueResult | null;
}

export type AccountState = "new" | "existing";

/** One imported account as reported back: never the password itself, only whether it had one. */
export type ImportedAccount = Omit<ImapAccountInput, "password"> & {
  state: AccountState;
  hasPassword: boolean;
};

export interface ImportOutcome {
  created: number;
  existing: number;
  accounts: ImportedAccount[];
  issues: AccountIssue[];
  dryRun: boolean;
}

export interface CsvImportOutcome extends ImportOutcome {
  hasHeader: boolean;
  delimiter: "," | ";" | "\t";
}

const iso = (value: Date | null | undefined): string | null => value?.toISOString() ?? null;

const EMPTY_COUNTS: ObjectCounts = {
  total: 0,
  active: 0,
  excluded: 0,
  orphaned: 0,
  mailbox: 0,
  onedrive: 0,
  imap: 0,
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function sourceNotFound(): ProblemError {
  return new ProblemError(404, "Source not found");
}

async function loadSource(
  tx: Transaction,
  tenantId: string,
  sourceId: string,
  options: { lock?: boolean } = {},
): Promise<Source> {
  const query = tx
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.id, sourceId)));
  const [row] = await (options.lock ? query.for("update") : query).limit(1);
  if (!row) {
    throw sourceNotFound();
  }
  return row;
}

function requireM365(source: Source): Source & { kind: "m365" } {
  if (source.kind !== "m365") {
    throw new ProblemError(409, "Not a Microsoft 365 source", {
      detail: "IMAP sources have no directory; their accounts are maintained by hand.",
    });
  }
  return source as Source & { kind: "m365" };
}

function requireImap(source: Source): void {
  if (source.kind !== "imap") {
    throw new ProblemError(409, "Not an IMAP source", {
      detail: "Accounts of a Microsoft 365 source come from the directory sync.",
    });
  }
}

/** Why the source cannot run a sync right now; null when it can. */
function syncBlocker(source: Source): Exclude<SyncNotQueuedReason, "queue_unavailable"> | null {
  if (source.status === "disabled") {
    return "source_disabled";
  }
  return source.entraTenantId ? null : "consent_outstanding";
}

/** Queue a sync after a change; report instead of failing when it cannot run. */
async function queueSyncAfterChange(
  db: Database,
  tenantId: string,
  source: Source,
): Promise<SyncQueueResult> {
  const blocker = syncBlocker(source);
  if (blocker) {
    return { status: "not_queued", reason: blocker };
  }
  try {
    return await enqueueDirectorySync(db, tenantId, source.id);
  } catch (error) {
    // The change itself is saved; the next scheduled sync applies it.
    if (error instanceof ProblemError && error.status === 503) {
      return { status: "not_queued", reason: "queue_unavailable" };
    }
    throw error;
  }
}

async function objectCounts(tx: Transaction, tenantId: string): Promise<Map<string, ObjectCounts>> {
  const rows = await tx
    .select({
      sourceId: protectedObjects.sourceId,
      kind: protectedObjects.kind,
      status: protectedObjects.status,
      n: count(),
    })
    .from(protectedObjects)
    .where(eq(protectedObjects.tenantId, tenantId))
    .groupBy(protectedObjects.sourceId, protectedObjects.kind, protectedObjects.status);
  const counts = new Map<string, ObjectCounts>();
  for (const row of rows) {
    const entry = counts.get(row.sourceId) ?? { ...EMPTY_COUNTS };
    entry.total += row.n;
    entry[row.status] += row.n;
    entry[row.kind] += row.n;
    counts.set(row.sourceId, entry);
  }
  return counts;
}

async function toSourceDto(
  tx: Transaction,
  source: Source,
  counts: ObjectCounts,
): Promise<DirectorySourceDto> {
  const { rules, overrides } = readProtection(source.config);
  const state = readDirectoryState(source.config);
  const pending =
    source.kind === "m365" ? await findPendingSync(tx, source.tenantId, source.id) : null;
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    status: source.status,
    errorMessage: source.errorMessage,
    failure: failureDto(source.failure),
    lastSyncAt: iso(source.lastSyncAt),
    consentGranted: source.entraTenantId !== null,
    rules: source.kind === "m365" ? rulesToRecord(rules) : null,
    overrideCount: source.kind === "m365" ? Object.keys(overrides).length : 0,
    sync:
      source.kind === "m365"
        ? {
            lastRun: state.lastRun
              ? { ...state.lastRun, failure: failureDto(state.lastRun.failure) }
              : null,
            lastFullSyncAt: state.lastFullSyncAt,
            fullSyncPending: fullSyncPending(state.fullSyncRequestedAt, state.lastFullSyncAt),
            pendingJob: pending
              ? {
                  id: pending.id,
                  status: pending.status,
                  startedAt: iso(pending.startedAt),
                  throttle: pending.throttle,
                }
              : null,
          }
        : null,
    imapAuthMode: source.kind === "imap" ? (source.config.imapAuthMode ?? "shared") : null,
    counts,
  };
}

/** A person of the protection directory (not a login account), for pickers. */
export interface DirectoryPersonDto {
  id: string;
  displayName: string | null;
  email: string;
}

/**
 * People of the tenant's protection directory whose name, address or UPN contains `search`, by
 * name; at most `limit` of them and whether there are more. The machine table assigns machines to
 * them (features/endpoints).
 */
export async function listPeople(
  db: Database,
  tenantId: string,
  query: PeopleQuery,
): Promise<{ items: DirectoryPersonDto[]; more: boolean }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const pattern = query.search ? containsPattern(query.search) : null;
    const rows = await tx
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(
        and(
          eq(users.tenantId, tenantId),
          pattern
            ? or(
                ilike(users.displayName, pattern),
                ilike(users.email, pattern),
                ilike(users.upn, pattern),
              )
            : undefined,
        ),
      )
      .orderBy(asc(sql`lower(coalesce(${users.displayName}, ${users.email}))`), asc(users.id))
      .limit(query.limit + 1);
    return { items: rows.slice(0, query.limit), more: rows.length > query.limit };
  });
}

/** Every source of the tenant with its rules, sync state and object counts. */
export async function listSources(db: Database, tenantId: string): Promise<DirectorySourceDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(sources)
      // The import source has no directory, rules or accounts; the Imports pages own it.
      .where(and(eq(sources.tenantId, tenantId), ne(sources.kind, "import")))
      .orderBy(asc(sources.name));
    const counts = await objectCounts(tx, tenantId);
    const result: DirectorySourceDto[] = [];
    for (const row of rows) {
      result.push(await toSourceDto(tx, row, counts.get(row.id) ?? { ...EMPTY_COUNTS }));
    }
    return result;
  });
}

/** Replace the rule set of an M365 source and queue a sync that applies it. */
export async function updateRules(
  db: Database,
  tenantId: string,
  sourceId: string,
  input: RulesInput,
  actor: Actor,
): Promise<RulesResult> {
  const { source, rules } = await withTenantTx(db, tenantId, async (tx) => {
    const current = requireM365(await loadSource(tx, tenantId, sourceId, { lock: true }));
    const next = rulesFromInput(input);
    await tx
      .update(sources)
      .set({ config: writeRules(current.config, next) })
      .where(eq(sources.id, sourceId));
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.rulesUpdated,
      target: sourceId,
      targetType: "source",
      ip: actor.ip,
      details: {
        rules: rulesToRecord(next),
        previous: rulesToRecord(readProtection(current.config).rules),
      },
    });
    return { source: current, rules: next };
  });
  return { rules: rulesToRecord(rules), sync: await queueSyncAfterChange(db, tenantId, source) };
}

/** Queue a sync now; `full` enumerates the whole directory instead of the changes. */
export async function requestSync(
  db: Database,
  tenantId: string,
  sourceId: string,
  options: { full: boolean },
  actor: Actor,
): Promise<EnqueueOutcome> {
  await withTenantTx(db, tenantId, async (tx) => {
    const source = requireM365(await loadSource(tx, tenantId, sourceId, { lock: true }));
    const blocker = syncBlocker(source);
    if (blocker === "source_disabled") {
      throw new ProblemError(409, "Source disabled", {
        detail: "Enable the source before running a directory sync.",
      });
    }
    if (blocker === "consent_outstanding") {
      throw new ProblemError(409, "Consent outstanding", {
        detail: "Admin consent for this Microsoft 365 tenant has not been granted yet.",
      });
    }
    if (options.full) {
      const state = readDirectoryState(source.config);
      await tx
        .update(sources)
        .set({
          config: writeDirectoryState(source.config, {
            ...state,
            fullSyncRequestedAt: new Date().toISOString(),
          }),
        })
        .where(eq(sources.id, sourceId));
    }
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.syncRequested,
      target: sourceId,
      targetType: "source",
      ip: actor.ip,
      details: { full: options.full },
    });
  });
  return enqueueDirectorySync(db, tenantId, sourceId);
}

/** Map Graph and sign-in failures of an interactive lookup onto problems. */
function graphProblem(error: unknown): unknown {
  if (error instanceof TokenAcquisitionError) {
    return new ProblemError(502, "Tenant sign-in failed", {
      type: "urn:restow:problem:graph-sign-in",
      detail: `${productName()} could not sign in to this Microsoft 365 tenant. Check the source's consent.`,
    });
  }
  if (isGraphError(error)) {
    return error.status === 401 || error.status === 403
      ? new ProblemError(502, "Permission missing", {
          type: "urn:restow:problem:graph-permission",
          detail:
            "Microsoft Graph refused to list groups. Grant admin consent again so the app holds Group.Read.All.",
          extensions: { graphStatus: error.status, graphCode: error.code ?? null },
        })
      : new ProblemError(502, "Microsoft Graph unavailable", {
          type: "urn:restow:problem:graph-unavailable",
          detail: "Microsoft Graph did not answer the group search. Try again in a moment.",
          extensions: { graphStatus: error.status, graphCode: error.code ?? null },
        });
  }
  return error;
}

/** Groups of the source's tenant for the rules editor's picker. */
export async function searchSourceGroups(
  db: Database,
  tenantId: string,
  sourceId: string,
  search: string,
): Promise<GroupSummary[]> {
  const source = requireM365(
    await withTenantTx(db, tenantId, (tx) => loadSource(tx, tenantId, sourceId)),
  );
  if (!source.entraTenantId) {
    throw new ProblemError(409, "Consent outstanding", {
      detail: "Admin consent for this Microsoft 365 tenant has not been granted yet.",
    });
  }
  try {
    return await searchGroups(graphClientFor(source.entraTenantId), search);
  } catch (error) {
    throw graphProblem(error);
  }
}

// ---------------------------------------------------------------------------
// Protected objects
// ---------------------------------------------------------------------------

type ObjectRow = {
  object: ProtectedObject;
  sourceName: string;
  sourceKind: Source["kind"];
  sourceConfig: unknown;
  email: string | null;
  upn: string | null;
  entraObjectId: string | null;
};

/**
 * True when the row is `excluded` only because its source is in `selected`
 * mode and never chose it (no `exclude` override on the object). Needs the
 * `sources` join, mirroring {@link isNotSelected} in SQL.
 */
// Both predicates are wrapped in coalesce: a config without the key yields
// NULL, and NOT NULL would silently drop the row from the opposite filter.
function notSelectedSql(): SQL {
  return sql`coalesce((
    ${sources.kind} = 'm365'
    and ${protectedObjects.status} = 'excluded'
    and (${sources.config}->'scope'->>'mode') = 'selected'
    and coalesce(${sources.config}->'protection'->'overrides'->>${protectedObjects.externalId}, '') <> 'exclude'
  ), false)`;
}

/** True when the mailbox is sign-in disabled with an address (shared, resource, blocked). */
function sharedOrBlockedSql(): SQL {
  return sql`coalesce((
    ${protectedObjects.kind} = 'mailbox'
    and ${sources.kind} = 'm365'
    and ${users.entraObjectId} is not null
    and (${sources.config}->'directory'->'sharedOrBlockedIds') @> to_jsonb(${users.entraObjectId}::text)
  ), false)`;
}

function objectFilters(tenantId: string, query: ObjectsFilter): SQL {
  const conditions: SQL[] = [eq(protectedObjects.tenantId, tenantId)];
  if (query.kind) {
    conditions.push(eq(protectedObjects.kind, query.kind));
  }
  if (query.status === "not_selected") {
    conditions.push(notSelectedSql());
  } else if (query.status === "excluded") {
    // Apart from `not_selected`: that one has its own filter value.
    conditions.push(and(eq(protectedObjects.status, "excluded"), not(notSelectedSql())) as SQL);
  } else if (query.status) {
    conditions.push(eq(protectedObjects.status, query.status));
  }
  if (query.sourceId) {
    conditions.push(eq(protectedObjects.sourceId, query.sourceId));
  }
  if (query.sharedOrBlocked !== undefined) {
    conditions.push(query.sharedOrBlocked ? sharedOrBlockedSql() : not(sharedOrBlockedSql()));
  }
  if (query.search) {
    const pattern = containsPattern(query.search);
    const match = or(
      ilike(protectedObjects.displayName, pattern),
      ilike(protectedObjects.externalId, pattern),
      ilike(users.email, pattern),
      ilike(users.upn, pattern),
    );
    if (match) {
      conditions.push(match);
    }
  }
  return and(...conditions) as SQL;
}

function orderFor(query: ObjectsQuery): SQL[] {
  const direction = query.order === "desc" ? sql.raw("DESC") : sql.raw("ASC");
  const column = {
    name: sql`lower(coalesce(${protectedObjects.displayName}, ${users.email}, ${protectedObjects.externalId}))`,
    kind: sql`${protectedObjects.kind}`,
    status: sql`${protectedObjects.status}`,
    createdAt: sql`${protectedObjects.createdAt}`,
    updatedAt: sql`${protectedObjects.updatedAt}`,
  }[query.sort];
  return [sql`${column} ${direction}`, sql`${protectedObjects.id} ASC`];
}

function baseObjectQuery(tx: Transaction) {
  return (
    tx
      .select({
        object: protectedObjects,
        sourceName: sources.name,
        sourceKind: sources.kind,
        sourceConfig: sources.config,
        email: users.email,
        upn: users.upn,
        entraObjectId: users.entraObjectId,
      })
      .from(protectedObjects)
      // Imported mailboxes (source kind `import`) have no protection scope; the
      // Imports pages list them, never the directory.
      .innerJoin(
        sources,
        and(eq(protectedObjects.sourceId, sources.id), ne(sources.kind, "import")),
      )
      .leftJoin(users, eq(protectedObjects.userId, users.id))
  );
}

interface BackupFacts {
  lastBackupAt: Date | null;
  snapshotCount: number;
  legalHold: boolean;
  latestJob: { id: string; status: Job["status"]; at: Date; failure: unknown } | null;
  readiness: { rating: RecoveryReadiness; checkedAt: Date } | null;
}

function emptyFacts(): BackupFacts {
  return {
    lastBackupAt: null,
    snapshotCount: 0,
    legalHold: false,
    latestJob: null,
    readiness: null,
  };
}

/** Last completed snapshot, latest backup job and the rating of that snapshot per object. */
async function backupFacts(
  tx: Transaction,
  tenantId: string,
  objectIds: string[],
): Promise<Map<string, BackupFacts>> {
  const facts = new Map<string, BackupFacts>();
  if (objectIds.length === 0) {
    return facts;
  }
  const factsOf = (id: string) => {
    const entry = facts.get(id) ?? emptyFacts();
    facts.set(id, entry);
    return entry;
  };

  const snapshotRows = await tx
    .select({
      objectId: snapshots.protectedObjectId,
      total: count(),
      lastBackupAt: sql<Date | null>`max(${snapshots.completedAt}) filter (where ${snapshots.status} = 'active' and ${snapshots.manifestPath} is not null)`,
    })
    .from(snapshots)
    .where(and(eq(snapshots.tenantId, tenantId), inArray(snapshots.protectedObjectId, objectIds)))
    .groupBy(snapshots.protectedObjectId);
  for (const row of snapshotRows) {
    const entry = factsOf(row.objectId);
    entry.snapshotCount = row.total;
    entry.lastBackupAt = row.lastBackupAt ? new Date(row.lastBackupAt) : null;
  }

  const holdRows = await tx
    .select({ objectId: legalHolds.protectedObjectId })
    .from(legalHolds)
    .where(
      and(
        eq(legalHolds.tenantId, tenantId),
        eq(legalHolds.active, true),
        inArray(legalHolds.protectedObjectId, objectIds),
      ),
    )
    .groupBy(legalHolds.protectedObjectId);
  for (const row of holdRows) {
    if (row.objectId) {
      factsOf(row.objectId).legalHold = true;
    }
  }

  const jobRows = await tx
    .selectDistinctOn([jobs.protectedObjectId], {
      objectId: jobs.protectedObjectId,
      id: jobs.id,
      status: jobs.status,
      at: sql<Date>`coalesce(${jobs.completedAt}, ${jobs.startedAt}, ${jobs.createdAt})`,
      failure: jobs.failure,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, tenantId),
        eq(jobs.queue, "backup"),
        inArray(jobs.protectedObjectId, objectIds),
      ),
    )
    .orderBy(jobs.protectedObjectId, desc(jobs.createdAt));
  for (const row of jobRows) {
    if (row.objectId) {
      factsOf(row.objectId).latestJob = {
        id: row.id,
        status: row.status,
        at: new Date(row.at),
        failure: row.failure,
      };
    }
  }

  // The rating of the newest backup only: after a new backup the object has
  // no rating until a check has read that backup back.
  const verifications = await loadObjectVerifications(tx, tenantId, objectIds);
  for (const [objectId, { verification }] of verifications) {
    const report = verification.report;
    if (report) {
      factsOf(objectId).readiness = { rating: report.readiness, checkedAt: report.checkedAt };
    }
  }
  return facts;
}

async function toObjectDtos(
  tx: Transaction,
  tenantId: string,
  rows: readonly ObjectRow[],
): Promise<ProtectedObjectDto[]> {
  const facts = await backupFacts(
    tx,
    tenantId,
    rows.map((row) => row.object.id),
  );
  // One parse of each source's config per page, not per row.
  const configs = new Map<
    string,
    {
      mode: ProtectionRulesDto["mode"];
      overrides: Record<string, ProtectionOverride>;
      shared: Set<string>;
      imapAuthMode: ImapAuthMode;
    }
  >();
  const configOf = (row: ObjectRow) => {
    let entry = configs.get(row.object.sourceId);
    if (!entry) {
      const { rules, overrides } = readProtection(row.sourceConfig);
      const raw = row.sourceConfig as { imapAuthMode?: ImapAuthMode } | null | undefined;
      entry = {
        mode: rules.mode,
        overrides: { ...overrides },
        shared: new Set(readDirectoryState(row.sourceConfig).sharedOrBlockedIds),
        imapAuthMode: raw?.imapAuthMode ?? "shared",
      };
      configs.set(row.object.sourceId, entry);
    }
    return entry;
  };

  return rows.map((row) => {
    const fact = facts.get(row.object.id) ?? emptyFacts();
    const config = configOf(row);
    const m365 = row.sourceKind === "m365";
    const override = m365 ? (config.overrides[row.object.externalId] ?? null) : null;
    return {
      id: row.object.id,
      sourceId: row.object.sourceId,
      sourceName: row.sourceName,
      sourceKind: row.sourceKind,
      kind: row.object.kind,
      origin: row.object.origin,
      status: row.object.status,
      externalId: row.object.externalId,
      displayName: row.object.displayName,
      userId: row.object.userId,
      email: row.email,
      upn: row.upn,
      sharedOrBlocked:
        m365 && row.object.kind === "mailbox" && row.entraObjectId !== null
          ? config.shared.has(row.entraObjectId)
          : false,
      override,
      notSelected: isNotSelected(row.sourceKind, config.mode, row.object.status, override),
      lastBackupAt: iso(fact.lastBackupAt),
      snapshotCount: fact.snapshotCount,
      legalHold: fact.legalHold,
      latestBackupJob: fact.latestJob
        ? {
            id: fact.latestJob.id,
            status: fact.latestJob.status,
            at: fact.latestJob.at.toISOString(),
            failure:
              fact.latestJob.status === "completed" ? null : failureDto(fact.latestJob.failure),
          }
        : null,
      readiness: fact.readiness
        ? { rating: fact.readiness.rating, checkedAt: fact.readiness.checkedAt.toISOString() }
        : null,
      credential:
        row.object.kind === "imap"
          ? {
              authMode: config.imapAuthMode,
              hasPassword: row.object.secretRef !== null,
              status: row.object.credentialStatus,
              checkedAt: iso(row.object.credentialCheckedAt),
              error: row.object.credentialError,
              errorReason: parseCredentialErrorReason(row.object.credentialError),
              failure: failureDto(row.object.credentialFailure),
            }
          : null,
      createdAt: row.object.createdAt.toISOString(),
      updatedAt: row.object.updatedAt.toISOString(),
    };
  });
}

/** Filtered, searched, paged protected objects with their backup facts. */
export async function listObjects(
  db: Database,
  tenantId: string,
  query: ObjectsQuery,
): Promise<ObjectsPage> {
  return withTenantTx(db, tenantId, async (tx) => {
    const where = objectFilters(tenantId, query);
    const [total] = await tx
      .select({ n: count() })
      .from(protectedObjects)
      // The same join as the rows below: imported mailboxes are listed by the Imports pages only.
      .innerJoin(
        sources,
        and(eq(protectedObjects.sourceId, sources.id), ne(sources.kind, "import")),
      )
      .leftJoin(users, eq(protectedObjects.userId, users.id))
      .where(where);
    const rows = await baseObjectQuery(tx)
      .where(where)
      .orderBy(...orderFor(query))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      items: await toObjectDtos(tx, tenantId, rows),
      total: total?.n ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  });
}

async function loadObjectRow(
  tx: Transaction,
  tenantId: string,
  objectId: string,
): Promise<ObjectRow> {
  const [row] = await baseObjectQuery(tx)
    .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)))
    .limit(1);
  if (!row) {
    throw new ProblemError(404, "Protected object not found");
  }
  return row;
}

/** What one applied decision did, for the caller to act on afterwards. */
interface ApplyProtectionOutcome {
  /** True when only a directory sync can settle the status (rules may need Graph). */
  readonly needsSync: boolean;
  /** True when this decision is what made the object `active` (it was not before). */
  readonly becameActive: boolean;
}

/**
 * Apply one decision to one object, inside the caller's transaction. Callers
 * re-read the rows afterwards, so several decisions on one source are all
 * reflected in the answer.
 */
async function applyProtection(
  tx: Transaction,
  tenantId: string,
  row: ObjectRow,
  input: ProtectionOverrideInput,
  actor: Actor,
): Promise<ApplyProtectionOutcome> {
  const decision = decideOverride(input.action, row.object.status, row.sourceKind);
  if (row.sourceKind === "m365") {
    // The lock also makes a running sync re-plan (its commit sees a new version).
    const source = await loadSource(tx, tenantId, row.object.sourceId, { lock: true });
    await tx
      .update(sources)
      .set({ config: writeOverride(source.config, row.object.externalId, decision.override) })
      .where(eq(sources.id, source.id));
  }
  if (decision.status !== row.object.status) {
    await tx
      .update(protectedObjects)
      .set({
        status: decision.status,
        // Protection (re-)starts now: the readiness view's first-backup
        // grace period counts from here, not from when the row was created.
        ...(decision.status === "active" ? { activeSince: new Date() } : {}),
      })
      .where(eq(protectedObjects.id, row.object.id));
  }
  await audit(tx, {
    tenantId,
    actorUserId: actor.userId,
    actor: actor.label,
    action: DIRECTORY_AUDIT_ACTIONS.protectionChanged,
    target: row.object.id,
    targetType: row.object.kind,
    onBehalfOf: row.email,
    ip: actor.ip,
    details: {
      action: input.action,
      reason: input.reason ?? null,
      externalId: row.object.externalId,
      previousStatus: row.object.status,
      status: decision.status,
    },
  });
  return {
    needsSync: decision.needsSync,
    becameActive: decision.status === "active" && row.object.status !== "active",
  };
}

/** The current rows of the given objects, as the caller's transaction sees them. */
async function reloadObjects(
  tx: Transaction,
  tenantId: string,
  objectIds: readonly string[],
): Promise<ProtectedObjectDto[]> {
  if (objectIds.length === 0) {
    return [];
  }
  const rows = await baseObjectQuery(tx)
    .where(
      and(eq(protectedObjects.tenantId, tenantId), inArray(protectedObjects.id, [...objectIds])),
    )
    .orderBy(asc(protectedObjects.kind), asc(protectedObjects.externalId));
  return toObjectDtos(tx, tenantId, rows);
}

/** Queue one sync per source that needs one, reporting the first outcome. */
async function syncSources(
  db: Database,
  tenantId: string,
  sourceIds: ReadonlySet<string>,
): Promise<SyncQueueResult | null> {
  let first: SyncQueueResult | null = null;
  for (const sourceId of sourceIds) {
    const source = await withTenantTx(db, tenantId, (tx) => loadSource(tx, tenantId, sourceId));
    const result = await queueSyncAfterChange(db, tenantId, source);
    first ??= result;
  }
  return first;
}

/** Include, exclude or reset one protected object. */
export async function setObjectProtection(
  db: Database,
  tenantId: string,
  objectId: string,
  input: ProtectionOverrideInput,
  actor: Actor,
): Promise<ProtectionResult> {
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadObjectRow(tx, tenantId, objectId);
    const outcome = await applyProtection(tx, tenantId, row, input, actor);
    const [object] = await reloadObjects(tx, tenantId, [objectId]);
    if (!object) {
      throw new ProblemError(404, "Protected object not found");
    }
    return { object, ...outcome, sourceId: row.object.sourceId };
  });
  const sync = result.needsSync
    ? await syncSources(db, tenantId, new Set([result.sourceId]))
    : null;
  if (result.becameActive) {
    await enqueueFirstBackups(db, tenantId, [objectId]);
  }
  return { object: result.object, sync };
}

/** Audit detail keeps at most this many ids; the count above always tells the full story. */
const MAX_AUDITED_BULK_IDS = 200;

/** The object ids a bulk decision applies to: given outright, or matched by a filter. */
async function resolveBulkObjectIds(
  tx: Transaction,
  tenantId: string,
  sourceId: string,
  input: BulkProtectionInput,
): Promise<string[]> {
  if (input.objectIds) {
    return [...new Set(input.objectIds)];
  }
  const where = objectFilters(tenantId, { ...(input.filter ?? {}), sourceId });
  const [total] = await tx
    .select({ n: count() })
    .from(protectedObjects)
    .innerJoin(sources, eq(protectedObjects.sourceId, sources.id))
    .leftJoin(users, eq(protectedObjects.userId, users.id))
    .where(where);
  const matched = total?.n ?? 0;
  if (matched > MAX_BULK_OBJECTS) {
    throw new ProblemError(409, "Too many objects match", {
      type: "urn:restow:problem:bulk-selection-too-large",
      detail: `The filter matches ${matched} objects; narrow it to ${MAX_BULK_OBJECTS} or fewer, or apply the change in smaller batches.`,
      extensions: { matched, max: MAX_BULK_OBJECTS },
    });
  }
  const rows = await tx
    .select({ id: protectedObjects.id })
    .from(protectedObjects)
    .innerJoin(sources, eq(protectedObjects.sourceId, sources.id))
    .leftJoin(users, eq(protectedObjects.userId, users.id))
    .where(where);
  return rows.map((row) => row.id);
}

/**
 * Include, exclude or reset every object an admin selected on one source, in
 * one request: the bulk contract behind `POST
 * /sources/:sourceId/protection/bulk`. Objects are given outright (checked
 * boxes) or matched by the same filter the objects list uses ("select all N
 * matching"); either way this reuses {@link applyProtection}, the per-object
 * logic, so a bulk change behaves exactly like the same decisions made one at
 * a time. Ids outside this source are silently dropped rather than failing
 * the whole batch.
 */
export async function bulkSetProtection(
  db: Database,
  tenantId: string,
  sourceId: string,
  input: BulkProtectionInput,
  actor: Actor,
): Promise<BulkProtectionResult> {
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const source = await loadSource(tx, tenantId, sourceId);
    if (input.action === "reset" && source.kind === "imap") {
      // IMAP accounts have no rules to fall back to (see `decideOverride`):
      // "reset" would silently re-protect an account an admin deliberately
      // excluded. The per-object menu already hides this action for IMAP.
      throw new ProblemError(409, "IMAP accounts have no rules to reset to", {
        detail:
          "IMAP accounts are not covered by protection rules; use include or exclude instead.",
      });
    }
    const ids = await resolveBulkObjectIds(tx, tenantId, sourceId, input);
    if (ids.length === 0) {
      return { matched: 0, updated: 0, needsSync: false, sourceId, becameActiveIds: [] };
    }
    const rows = await baseObjectQuery(tx).where(
      and(
        eq(protectedObjects.tenantId, tenantId),
        eq(protectedObjects.sourceId, sourceId),
        inArray(protectedObjects.id, ids),
      ),
    );
    let needsSync = false;
    const becameActiveIds: string[] = [];
    for (const row of rows) {
      const outcome = await applyProtection(
        tx,
        tenantId,
        row,
        { action: input.action, reason: input.reason },
        actor,
      );
      if (outcome.needsSync) {
        needsSync = true;
      }
      if (outcome.becameActive) {
        becameActiveIds.push(row.object.id);
      }
    }
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.bulkProtectionChanged,
      target: sourceId,
      targetType: "source",
      ip: actor.ip,
      details: {
        action: input.action,
        reason: input.reason ?? null,
        selection: input.objectIds ? "ids" : "filter",
        matched: ids.length,
        updated: rows.length,
        objectIds: rows.map((row) => row.object.id).slice(0, MAX_AUDITED_BULK_IDS),
        truncated: rows.length > MAX_AUDITED_BULK_IDS,
      },
    });
    return { matched: ids.length, updated: rows.length, needsSync, sourceId, becameActiveIds };
  });
  const sync = result.needsSync
    ? await syncSources(db, tenantId, new Set([result.sourceId]))
    : null;
  if (result.becameActiveIds.length > 0) {
    await enqueueFirstBackups(db, tenantId, result.becameActiveIds);
  }
  return {
    sourceId: result.sourceId,
    action: input.action,
    matched: result.matched,
    updated: result.updated,
    sync,
  };
}

/**
 * Include, exclude or reset every protected object of a directory user: the
 * on-/offboarding contract behind `POST /api/v1/users/:id/protection`.
 */
export async function setUserProtection(
  db: Database,
  tenantId: string,
  userId: string,
  input: ProtectionOverrideInput,
  actor: Actor,
): Promise<UserProtectionResult> {
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    if (!user) {
      throw new ProblemError(404, "User not found");
    }
    const rows = await baseObjectQuery(tx).where(
      and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.userId, userId)),
    );
    const needSync = new Set<string>();
    const becameActiveIds: string[] = [];
    for (const row of rows) {
      const outcome = await applyProtection(tx, tenantId, row, input, actor);
      if (outcome.needsSync) {
        needSync.add(row.object.sourceId);
      }
      if (outcome.becameActive) {
        becameActiveIds.push(row.object.id);
      }
    }
    const objects = await reloadObjects(
      tx,
      tenantId,
      rows.map((row) => row.object.id),
    );
    return { objects, needSync, becameActiveIds };
  });
  const sync = result.needSync.size > 0 ? await syncSources(db, tenantId, result.needSync) : null;
  if (result.becameActiveIds.length > 0) {
    await enqueueFirstBackups(db, tenantId, result.becameActiveIds);
  }
  return {
    userId,
    action: input.action,
    objects: result.objects,
    sync,
  };
}

/**
 * Remove an IMAP account from the list. Only accounts without backups or
 * holds: the snapshot index and legal holds hang off the object, and deleting
 * it would silently drop them. Such accounts are excluded instead.
 */
export async function deleteAccount(
  db: Database,
  tenantId: string,
  objectId: string,
  actor: Actor,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadObjectRow(tx, tenantId, objectId);
    if (row.object.origin !== "manual") {
      throw new ProblemError(409, "Managed by the directory", {
        type: "urn:restow:problem:directory-managed",
        detail: "This object comes from the directory sync. Exclude it instead of removing it.",
      });
    }
    const [snapshotRow] = await tx
      .select({ n: count() })
      .from(snapshots)
      .where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.protectedObjectId, objectId)));
    const [holdRow] = await tx
      .select({ n: count() })
      .from(legalHolds)
      .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.protectedObjectId, objectId)));
    if ((snapshotRow?.n ?? 0) > 0 || (holdRow?.n ?? 0) > 0) {
      throw new ProblemError(409, "Account has backups", {
        type: "urn:restow:problem:account-has-backups",
        detail:
          "Backups or legal holds exist for this account. Exclude it instead; retention removes the backups when they expire.",
      });
    }
    await tx.delete(protectedObjects).where(eq(protectedObjects.id, objectId));
    if (row.object.secretRef) {
      // The object row is gone; its sealed per-mailbox password (docs/IMAP.md)
      // has no `secret_ref` pointing at it any more (ON DELETE SET NULL runs
      // the other way, on the secret), so it would otherwise sit in `secrets`
      // forever as an unreferenced, still-decryptable credential.
      await deleteSecret(tx, { id: row.object.secretRef, tenantId });
    }
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.accountDeleted,
      target: objectId,
      targetType: row.object.kind,
      ip: actor.ip,
      details: { externalId: row.object.externalId, sourceId: row.object.sourceId },
    });
  });
}

// ---------------------------------------------------------------------------
// IMAP accounts (manual list, CSV import)
// ---------------------------------------------------------------------------

/** Add entered accounts (a manual list); see {@link storeAccounts}. */
export async function importAccounts(
  db: Database,
  tenantId: string,
  sourceId: string,
  rows: readonly AccountRow[],
  actor: Actor,
  options: { dryRun: boolean },
): Promise<ImportOutcome> {
  const { accounts, issues } = normalizeAccounts(rows);
  return storeAccounts(db, tenantId, sourceId, { accounts, issues }, actor, options);
}

/**
 * Add validated IMAP accounts to a source: one `users` row per address and
 * one `imap` protected object per login. Logins compare case-insensitively;
 * a login already listed keeps its status and history, only name and address
 * are refreshed. `dryRun` reports without writing.
 */
async function storeAccounts(
  db: Database,
  tenantId: string,
  sourceId: string,
  input: { accounts: readonly ImapAccountInput[]; issues: readonly AccountIssue[] },
  actor: Actor,
  options: { dryRun: boolean },
): Promise<ImportOutcome> {
  const { accounts } = input;
  const newlyActiveIds: string[] = [];
  const result = await withTenantTx(db, tenantId, async (tx) => {
    const source = await loadSource(tx, tenantId, sourceId);
    requireImap(source);
    // Only per_mailbox mailboxes ever have a password of their own
    // (docs/IMAP.md); a shared or master_user source authenticates every
    // mailbox with the source's own stored credential, so a password
    // column or field there is accepted but never sealed.
    const sealsPasswords = (source.config.imapAuthMode ?? "shared") === "per_mailbox";
    const known = new Map<string, { id: string; secretRef: string | null }>();
    for (let i = 0; i < accounts.length; i += 500) {
      const logins = accounts.slice(i, i + 500).map((account) => account.login.toLowerCase());
      const existing = await tx
        .select({
          id: protectedObjects.id,
          externalId: protectedObjects.externalId,
          secretRef: protectedObjects.secretRef,
        })
        .from(protectedObjects)
        .where(
          and(
            eq(protectedObjects.tenantId, tenantId),
            eq(protectedObjects.sourceId, sourceId),
            inArray(sql`lower(${protectedObjects.externalId})`, logins),
          ),
        );
      for (const row of existing) {
        known.set(row.externalId.toLowerCase(), { id: row.id, secretRef: row.secretRef });
      }
    }
    const listed = accounts.map((account) => ({
      ...account,
      state: (known.has(account.login.toLowerCase()) ? "existing" : "new") as AccountState,
    }));
    const outcome: ImportOutcome = {
      created: listed.filter((account) => account.state === "new").length,
      existing: listed.filter((account) => account.state === "existing").length,
      // Never the password itself, only whether it was actually sealed onto
      // the row (never true outside per_mailbox mode, see `sealsPasswords`).
      accounts: listed.map(({ password, ...rest }) => ({
        ...rest,
        hasPassword: sealsPasswords && password !== undefined,
      })),
      issues: [...input.issues],
      dryRun: options.dryRun,
    };
    if (options.dryRun || listed.length === 0) {
      return outcome;
    }

    for (const account of listed) {
      const [user] = await tx
        .insert(users)
        .values({ tenantId, email: account.email, displayName: account.displayName })
        .onConflictDoUpdate({
          target: [users.tenantId, users.email],
          set: { displayName: sql`coalesce(${account.displayName}, ${users.displayName})` },
        })
        .returning({ id: users.id });
      const existingRow = known.get(account.login.toLowerCase());
      const displayName = account.displayName ?? account.email;
      let objectId = existingRow?.id;
      let currentSecretRef = existingRow?.secretRef ?? null;
      if (objectId) {
        await tx
          .update(protectedObjects)
          .set({ userId: user?.id ?? null, displayName })
          .where(eq(protectedObjects.id, objectId));
      } else {
        const [inserted] = await tx
          .insert(protectedObjects)
          .values({
            tenantId,
            sourceId,
            userId: user?.id ?? null,
            kind: "imap",
            origin: "manual",
            status: "active",
            externalId: account.login,
            displayName,
            activeSince: new Date(),
          })
          .returning({ id: protectedObjects.id });
        if (inserted) {
          objectId = inserted.id;
          // Newly added: always `active` (IMAP accounts have no rules to fall
          // back to), so it is always its first backup - unless this is a
          // per_mailbox row with no password yet. Queuing that one now would
          // only produce a first job certain to fail with "no password set"
          // (and a job.failed webhook/ticket for every such mailbox before
          // the admin could reach it); `setObjectCredential` queues it once a
          // password actually exists.
          if (!(sealsPasswords && !account.password)) {
            newlyActiveIds.push(inserted.id);
          }
        }
      }
      // A row's own password (per_mailbox auth mode; docs/IMAP.md), sealed the
      // same way a source's own password is. A shared or master_user source
      // never seals one, whatever the row carries (see `sealsPasswords`).
      if (sealsPasswords && account.password && objectId) {
        if (currentSecretRef) {
          await replaceSecret(tx, { id: currentSecretRef, tenantId }, account.password);
        } else {
          const secret = await storeSecret(tx, {
            tenantId,
            kind: "imap_password",
            plaintext: account.password,
          });
          currentSecretRef = secret.id;
        }
        await tx
          .update(protectedObjects)
          .set({
            secretRef: currentSecretRef,
            credentialStatus: "untested",
            credentialCheckedAt: null,
            credentialError: null,
            credentialFailure: null,
          })
          .where(eq(protectedObjects.id, objectId));
      }
    }
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.accountsImported,
      target: sourceId,
      targetType: "source",
      ip: actor.ip,
      details: {
        created: outcome.created,
        existing: outcome.existing,
        skipped: outcome.issues.length,
      },
    });
    return outcome;
  });
  if (newlyActiveIds.length > 0) {
    await enqueueFirstBackups(db, tenantId, newlyActiveIds);
  }
  return result;
}

/** Parse a CSV and import it, or only preview it with `dryRun`. */
export async function importAccountsCsv(
  db: Database,
  tenantId: string,
  sourceId: string,
  csv: string,
  actor: Actor,
  options: { dryRun: boolean },
): Promise<CsvImportOutcome> {
  const preview = parseImapAccountsCsv(csv);
  const outcome = await storeAccounts(db, tenantId, sourceId, preview, actor, options);
  return { ...outcome, hasHeader: preview.hasHeader, delimiter: preview.delimiter };
}

// ---------------------------------------------------------------------------
// Per-mailbox credentials (imapAuthMode "per_mailbox" and "master_user", docs/IMAP.md)
// ---------------------------------------------------------------------------

function requireImapObject(row: ObjectRow): void {
  if (row.object.kind !== "imap") {
    throw new ProblemError(409, "Not an IMAP account", {
      detail: "Only IMAP accounts have a login that can be set or tested.",
    });
  }
}

/** The source's IMAP auth mode, default `"shared"` when absent (docs/IMAP.md). */
function imapAuthModeOf(row: ObjectRow): ImapAuthMode {
  const config = row.sourceConfig as { imapAuthMode?: ImapAuthMode } | null | undefined;
  return config?.imapAuthMode ?? "shared";
}

/**
 * Only a `per_mailbox` account has a password of its own to set: on `shared`
 * or `master_user`, every mailbox authenticates with the source's own stored
 * credential, and nothing ever reads an object's `secret_ref` there (the CSV
 * import applies the same rule and never seals a password outside
 * `per_mailbox` either). Sealing one anyway would store a secret that sits
 * unused and unaudited by anyone who could later change the source back.
 */
function requirePerMailboxObject(row: ObjectRow): void {
  requireImapObject(row);
  if (imapAuthModeOf(row) !== "per_mailbox") {
    throw new ProblemError(409, "Source has no per-mailbox credentials", {
      type: "urn:restow:problem:imap-not-per-mailbox",
      detail:
        "This account's source authenticates every mailbox with its own stored credential; it has no password of its own to set.",
    });
  }
}

function credentialConfigProblem(detail: string): ProblemError {
  return new ProblemError(409, "IMAP source not ready to test", {
    type: "urn:restow:problem:imap-credential-not-configured",
    detail,
  });
}

/**
 * The login a backup, restore or "test login" would use for this object,
 * mirroring the worker's `imapAccountFor` (apps/worker/src/handlers/backup.ts)
 * without depending on worker code: the API and the worker each resolve it
 * against the same `sources`/`protected_objects` columns, by `imapAuthMode`.
 */
async function resolveImapProbeInput(
  tx: Transaction,
  tenantId: string,
  row: ObjectRow,
): Promise<{ probe: ImapProbeInput; allowPrivateNetworks: boolean }> {
  const source = await loadSource(tx, tenantId, row.object.sourceId);
  if (source.kind !== "imap" || !source.host || !source.port || !source.security) {
    throw credentialConfigProblem("The source has no IMAP server configured yet.");
  }
  // Mirrors testSource and the worker's imapAccountFor: the installation-wide
  // flag counts the same as a per-source approval, so "test login" resolves
  // an internal host exactly like a backup or restore would (docs/IMAP.md).
  const allowPrivateNetworks = storedHostMayBePrivate(
    source.config,
    processConfig.imapAllowPrivateNetworks,
  );
  const server = { host: source.host, port: source.port, security: source.security };
  const mode = source.config.imapAuthMode ?? "shared";

  if (mode === "per_mailbox") {
    if (!row.object.secretRef) {
      throw credentialConfigProblem("This mailbox has no password yet; set one before testing.");
    }
    const password = await readSecret(tx, { id: row.object.secretRef, tenantId });
    if (!password) {
      throw credentialConfigProblem("The stored password could not be read.");
    }
    return {
      probe: { ...server, username: row.object.externalId, password },
      allowPrivateNetworks,
    };
  }

  if (mode === "master_user") {
    if (!source.secretRef) {
      throw credentialConfigProblem("The source has no master credential stored.");
    }
    const masterUser = source.config.masterUser;
    if (!masterUser?.username) {
      throw credentialConfigProblem("The source has no master user configured.");
    }
    const password = await readSecret(tx, { id: source.secretRef, tenantId });
    if (!password) {
      throw credentialConfigProblem("The stored master password could not be read.");
    }
    if (masterUser.style === "sasl_authzid") {
      return {
        probe: {
          ...server,
          username: masterUser.username,
          authzid: row.object.externalId,
          password,
        },
        allowPrivateNetworks,
      };
    }
    const separator = masterUser.separator ?? "*";
    return {
      probe: {
        ...server,
        username: `${masterUser.username}${separator}${row.object.externalId}`,
        password,
      },
      allowPrivateNetworks,
    };
  }

  // shared (default)
  if (!source.secretRef) {
    throw credentialConfigProblem("The source has no stored credential.");
  }
  const password = await readSecret(tx, { id: source.secretRef, tenantId });
  if (!password) {
    throw credentialConfigProblem("The stored password could not be read.");
  }
  return { probe: { ...server, username: row.object.externalId, password }, allowPrivateNetworks };
}

/**
 * `credentialErrorMessage`'s reason, read back out of the stored string: the
 * schema has no separate column for it this iteration, only the composed
 * text (`protected_objects.credential_error`), so the reason travels as the
 * known, stable prefix this same function writes. The DTO exposes it
 * separately (`credential.errorReason`) so the UI can show a translated
 * reason instead of this raw, always-English text (docs/IMAP.md).
 */
function parseCredentialErrorReason(error: string | null): ImapProbeFailure | null {
  const reason = error ? /^IMAP (\w+)/.exec(error)?.[1] : null;
  return reason && (PROBE_FAILURE_REASONS as readonly string[]).includes(reason)
    ? (reason as ImapProbeFailure)
    : null;
}

const PROBE_FAILURE_REASONS: readonly ImapProbeFailure[] = [
  "blocked_address",
  "auth",
  "timeout",
  "tls",
  "starttls_unavailable",
  "dns",
  "refused",
  "unknown",
];

/** A short, non-secret description of a failed probe, for `credential_error`. */
function credentialErrorMessage(probe: ImapProbeResult): string | null {
  if (probe.ok) {
    return null;
  }
  return `IMAP ${probe.reason}${probe.code ? ` (${probe.code})` : ""}: ${probe.message}`;
}

/**
 * Set or replace one IMAP account's own password (`imapAuthMode:
 * "per_mailbox"`): sealed the same way a source's own password is, resets the
 * credential check to `untested`. Rejected with 409 for `shared` or
 * `master_user` sources, which have no password of their own to set (same
 * rule the CSV import applies: {@link requirePerMailboxObject}).
 */
export async function setObjectCredential(
  db: Database,
  tenantId: string,
  objectId: string,
  input: ObjectCredentialInput,
  actor: Actor,
): Promise<ProtectedObjectDto> {
  const object = await withTenantTx(db, tenantId, async (tx) => {
    const row = await loadObjectRow(tx, tenantId, objectId);
    requirePerMailboxObject(row);
    if (row.object.secretRef) {
      await replaceSecret(tx, { id: row.object.secretRef, tenantId }, input.password);
    } else {
      const secret = await storeSecret(tx, {
        tenantId,
        kind: "imap_password",
        plaintext: input.password,
      });
      await tx
        .update(protectedObjects)
        .set({ secretRef: secret.id })
        .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)));
    }
    await tx
      .update(protectedObjects)
      .set({
        credentialStatus: "untested",
        credentialCheckedAt: null,
        credentialError: null,
        credentialFailure: null,
      })
      .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)));
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.credentialSet,
      target: objectId,
      targetType: "imap",
      ip: actor.ip,
      // The value itself never appears here or anywhere else.
      details: { externalId: row.object.externalId, sourceId: row.object.sourceId },
    });
    const [reloaded] = await reloadObjects(tx, tenantId, [objectId]);
    if (!reloaded) {
      throw new ProblemError(404, "Protected object not found");
    }
    return reloaded;
  });
  // Import skips a per_mailbox mailbox's first backup until it has a password
  // (see storeAccounts); once one is set here, that first backup is due. A
  // no-op for an object that already has a snapshot or is mid-run.
  await enqueueFirstBackups(db, tenantId, [objectId]);
  return object;
}

/** Result of a "test login": whether it worked, and the object as it now stands. */
export interface CredentialTestResult {
  object: ProtectedObjectDto;
  probe: ImapProbeResult;
}

/**
 * Try the login this object would use for a backup or restore right now
 * (docs/IMAP.md), without writing anything but the result: `credential_status`,
 * `credential_checked_at` and, on failure, `credential_error` (never the
 * password). tenant_admin only, same as every other directory write.
 *
 * Resolving the login and probing it run outside any transaction: the probe
 * is external I/O bounded by its own timeout (imap.ts), and holding a pooled
 * connection and an open transaction for that long starves the pool the same
 * way `testSource` deliberately avoids (apps/features/sources/service.ts).
 * The result is written in a second, short transaction.
 */
export async function testObjectCredential(
  db: Database,
  tenantId: string,
  objectId: string,
  actor: Actor,
): Promise<CredentialTestResult> {
  const row = await withTenantTx(db, tenantId, async (tx) => {
    const loaded = await loadObjectRow(tx, tenantId, objectId);
    requireImapObject(loaded);
    return loaded;
  });
  const { probe: probeInput, allowPrivateNetworks } = await withTenantTx(db, tenantId, (tx) =>
    resolveImapProbeInput(tx, tenantId, row),
  );
  const probe = await probeImapConnection(probeInput, { allowPrivateNetworks });

  return withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(protectedObjects)
      .set({
        credentialStatus: probe.ok ? "ok" : "failed",
        credentialCheckedAt: new Date(probe.checkedAt),
        credentialError: credentialErrorMessage(probe),
        credentialFailure: causeToRecord(
          causeOfImapProbe(probe, { host: probeInput.host, port: probeInput.port }),
          new Date(probe.checkedAt),
        ),
      })
      .where(and(eq(protectedObjects.tenantId, tenantId), eq(protectedObjects.id, objectId)));
    await audit(tx, {
      tenantId,
      actorUserId: actor.userId,
      actor: actor.label,
      action: DIRECTORY_AUDIT_ACTIONS.credentialTested,
      target: objectId,
      targetType: "imap",
      ip: actor.ip,
      details: {
        externalId: row.object.externalId,
        sourceId: row.object.sourceId,
        ok: probe.ok,
        reason: probe.ok ? null : probe.reason,
      },
    });
    const [object] = await reloadObjects(tx, tenantId, [objectId]);
    if (!object) {
      throw new ProblemError(404, "Protected object not found");
    }
    return { object, probe };
  });
}
