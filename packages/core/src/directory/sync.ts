/**
 * Directory sync for an M365 source.
 *
 * One run walks `users/delta` (a full enumeration, or only the changes since
 * the stored delta link), completes partial entries, probes which of the
 * reported users have a mailbox and a OneDrive, resolves the rule group,
 * plans the row changes (./plan.ts) and commits them through a
 * {@link DirectoryRepository}.
 *
 * Two guarantees shape the flow:
 *   - The new delta link is committed together with the rows it describes.
 *     The delta stream writes into an in-memory store; if anything fails
 *     before the commit, the next run starts from the old link again and no
 *     change is lost.
 *   - A commit carries the version of the rules and overrides it was planned
 *     against. When an admin changed either while the run was in flight, the
 *     repository refuses ({@link DirectoryConflictError}) and the run plans
 *     again from the fresh state, without asking Graph for the users again.
 *
 * Nothing here depends on Postgres: the worker implements the repository over
 * Drizzle, tests use {@link MemoryDirectoryRepository} and the fake Graph.
 */
import { JobAbortedError } from "../engine/chunkstore.js";
import { noopLogger } from "../engine/logger.js";
import type { Logger, ProgressReporter } from "../engine/types.js";
import {
  type BatchRequest,
  type BatchResponse,
  type GraphClient,
  chunkIntoBatches,
} from "../graph/client.js";
import { type DeltaMode, InMemoryDeltaTokenStore } from "../graph/delta.js";
import { GraphError, isGraphError, isMailboxUnavailable } from "../graph/errors.js";
import { query, userPath } from "../graph/resources/common.js";
import {
  USER_SELECT,
  type UserDeltaEntry,
  listGroupMemberIds,
  usersDelta,
} from "../graph/resources/users.js";
import type { ProtectionConfig } from "./config.js";
import {
  type DirectoryObjectKind,
  type DirectoryPlan,
  type DirectoryUserRecord,
  type KnownObject,
  type UserProbe,
  isPartialEntry,
  isRemovedEntry,
  planDirectory,
  probeTargets,
  toDirectoryUser,
} from "./plan.js";

/** Delta stream key of a source's user directory. */
export const USERS_DELTA_KEY = "directory:users";

/** Probe requests handed to one `client.batch` call (it splits them into $batch calls of 20). */
const PROBE_CHUNK = 100;

/** How often a run plans again after a concurrent rule or override change. */
const MAX_COMMIT_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Repository seam
// ---------------------------------------------------------------------------

/** What earlier runs and admins left behind, loaded at the start of a run. */
export interface DirectorySnapshot {
  readonly deltaLink: string | null;
  readonly known: readonly KnownObject[];
  readonly sharedOrBlockedIds: ReadonlySet<string>;
  readonly protection: ProtectionConfig;
  /** Opaque version of `protection`; see {@link DirectoryRepository.commit}. */
  readonly version: string;
}

/** Everything one run writes, in one transaction. */
export interface DirectoryCommit {
  readonly plan: DirectoryPlan;
  readonly deltaLink: string;
  /** Start of this run when it enumerated the whole directory, else null. */
  readonly fullSyncAt: string | null;
}

/** The rules or overrides changed after the snapshot was loaded. */
export class DirectoryConflictError extends Error {
  constructor() {
    super("protection rules or overrides changed during the directory sync");
    this.name = "DirectoryConflictError";
  }
}

/** Persistence seam of the sync. */
export interface DirectoryRepository {
  load(): Promise<DirectorySnapshot>;
  /**
   * Apply users, objects, orphans, the delta link and the shared/blocked set
   * atomically. Throws {@link DirectoryConflictError} when the protection
   * version no longer equals `expectedVersion`.
   */
  commit(commit: DirectoryCommit, expectedVersion: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Warnings and results
// ---------------------------------------------------------------------------

interface GraphFailure {
  readonly status: number;
  readonly code: string | null;
  /** Graph's message, trimmed; never contains tokens. */
  readonly message: string;
}

/** Problems a run reports without failing; shown next to the sync state. */
export type SyncWarning =
  | (GraphFailure & { readonly kind: "group_unresolved"; readonly groupId: string })
  | (GraphFailure & {
      readonly kind: "mailbox_probe_failed" | "drive_probe_failed" | "user_fetch_failed";
      readonly userId: string;
      /** Address or UPN of the user when known, for a readable message. */
      readonly user: string | null;
    });

/** An object this run made active that was not active before (new, or re-included). */
export interface NewlyActiveObject {
  readonly externalId: string;
  readonly kind: DirectoryObjectKind;
}

export interface DirectorySyncResult {
  readonly mode: DeltaMode;
  readonly startedAt: string;
  readonly deltaLink: string;
  readonly counts: DirectoryPlan["counts"];
  readonly warnings: readonly SyncWarning[];
  /** Delta pages read from Graph. */
  readonly pages: number;
  /**
   * Objects this run made `active` that were not active before it (absent, or
   * `excluded`/`orphaned`): every object whose first backup is now due. The
   * worker enqueues it right after the commit instead of waiting for the
   * tenant's backup schedule.
   */
  readonly newlyActive: readonly NewlyActiveObject[];
}

export interface DirectorySyncOptions {
  readonly client: GraphClient;
  readonly repository: DirectoryRepository;
  /** Ignore the stored delta link and enumerate the whole directory. */
  readonly full?: boolean;
  readonly logger?: Logger;
  readonly progress?: ProgressReporter;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new JobAbortedError();
  }
}

function failureOf(response: Pick<BatchResponse, "status" | "body">): GraphFailure {
  const error = (response.body as { error?: { code?: unknown; message?: unknown } } | undefined)
    ?.error;
  return {
    status: response.status,
    code: typeof error?.code === "string" ? error.code : null,
    message: (typeof error?.message === "string" ? error.message : `HTTP ${response.status}`).slice(
      0,
      300,
    ),
  };
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Objects the plan makes `active` that were not `active` in `known` before it. */
function newlyActiveObjects(
  known: readonly KnownObject[],
  plan: DirectoryPlan,
): NewlyActiveObject[] {
  const priorStatus = new Map(known.map((object) => [object.externalId, object.status]));
  return plan.objects
    .filter(
      (object) => object.status === "active" && priorStatus.get(object.externalId) !== "active",
    )
    .map((object) => ({ externalId: object.externalId, kind: object.kind }));
}

// ---------------------------------------------------------------------------
// Graph steps
// ---------------------------------------------------------------------------

/**
 * Complete partial delta entries with batched user reads. Users that cannot
 * be read are reported and skipped for this run; the next change to them, or
 * the next full enumeration, picks them up.
 */
export async function fetchUsersById(
  client: GraphClient,
  userIds: readonly string[],
  onWarning: (warning: SyncWarning) => void,
  signal?: AbortSignal,
): Promise<DirectoryUserRecord[]> {
  const users: DirectoryUserRecord[] = [];
  const select = query({ $select: USER_SELECT.join(",") });
  for (const chunk of chunkIntoBatches([...userIds], PROBE_CHUNK)) {
    throwIfAborted(signal);
    const requests: BatchRequest[] = chunk.map((id) => ({
      id,
      method: "GET",
      url: `${userPath(id)}${select}`,
    }));
    for (const response of await client.batch(requests)) {
      const user = isOk(response.status)
        ? toDirectoryUser({ ...(response.body as UserDeltaEntry), id: response.id })
        : null;
      if (user) {
        users.push(user);
      } else {
        onWarning({
          kind: "user_fetch_failed",
          userId: response.id,
          user: null,
          ...failureOf(response),
        });
      }
    }
  }
  return users;
}

type ProbeKind = "mailbox" | "drive";

function probeRequest(kind: ProbeKind, userId: string): BatchRequest {
  return kind === "mailbox"
    ? { id: `mailbox:${userId}`, method: "GET", url: `${userPath(userId)}/mailboxSettings` }
    : {
        id: `drive:${userId}`,
        method: "GET",
        url: `${userPath(userId)}/drive${query({ $select: "id" })}`,
      };
}

/** True when a mailbox probe answer means "no Exchange Online mailbox". */
function isNoMailbox(response: BatchResponse, url: string): boolean {
  if (response.status === 404) {
    return true;
  }
  return isMailboxUnavailable(
    new GraphError({ status: response.status, method: "GET", url, payload: response.body }),
  );
}

/**
 * Ask Graph which users have a mailbox and a OneDrive, in batched reads.
 * 404 answers are definite ("none"); any other failure is reported and leaves
 * the answer unknown, so the plan keeps what it knew instead of guessing.
 */
export async function probeUsers(
  client: GraphClient,
  users: readonly DirectoryUserRecord[],
  onWarning: (warning: SyncWarning) => void,
  signal?: AbortSignal,
): Promise<Map<string, UserProbe>> {
  const targets = probeTargets(users);
  const names = new Map(users.map((user) => [user.entraObjectId, user.email]));
  const requests = [
    ...targets.mailbox.map((id) => probeRequest("mailbox", id)),
    ...targets.drive.map((id) => probeRequest("drive", id)),
  ];
  const urls = new Map(requests.map((request) => [request.id, request.url]));
  const probes = new Map<string, { mailbox?: boolean; driveId?: string | null }>();
  const probeOf = (userId: string) => {
    const probe = probes.get(userId) ?? {};
    probes.set(userId, probe);
    return probe;
  };

  for (const chunk of chunkIntoBatches(requests, PROBE_CHUNK)) {
    throwIfAborted(signal);
    for (const response of await client.batch(chunk)) {
      const separator = response.id.indexOf(":");
      const kind = response.id.slice(0, separator) as ProbeKind;
      const userId = response.id.slice(separator + 1);
      const probe = probeOf(userId);
      if (kind === "mailbox") {
        if (isOk(response.status)) {
          probe.mailbox = true;
          continue;
        }
        if (isNoMailbox(response, urls.get(response.id) ?? "")) {
          probe.mailbox = false;
          continue;
        }
      } else {
        const driveId = (response.body as { id?: unknown } | undefined)?.id;
        if (isOk(response.status) && typeof driveId === "string" && driveId.length > 0) {
          probe.driveId = driveId;
          continue;
        }
        if (response.status === 404) {
          probe.driveId = null;
          continue;
        }
      }
      onWarning({
        kind: kind === "mailbox" ? "mailbox_probe_failed" : "drive_probe_failed",
        userId,
        user: names.get(userId) ?? null,
        ...failureOf(response),
      });
    }
  }
  return probes;
}

/** Enumerate the delta stream fully, honouring a mid-run resync (`reset`). */
async function collectUsersDelta(
  client: GraphClient,
  deltaLink: string | null,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<{ entries: UserDeltaEntry[]; mode: DeltaMode; deltaLink: string; pages: number }> {
  // Staged in memory: the link reaches the database only with the committed rows.
  const staging = new InMemoryDeltaTokenStore();
  if (deltaLink) {
    await staging.set(USERS_DELTA_KEY, deltaLink);
  }
  let entries: UserDeltaEntry[] = [];
  const generator = usersDelta(client, staging, {
    key: USERS_DELTA_KEY,
    onResync: () => logger.warn("users delta link expired, enumerating the directory again"),
  });
  for (;;) {
    throwIfAborted(signal);
    const next = await generator.next();
    if (next.done) {
      return {
        entries,
        mode: next.value.mode,
        deltaLink: next.value.deltaLink,
        pages: next.value.pages,
      };
    }
    if (next.value.reset) {
      entries = [];
    }
    entries.push(...next.value.items);
  }
}

/** Last entry per user wins; a change merges into an earlier change of the same run. */
export function latestPerUser(entries: readonly UserDeltaEntry[]): Map<string, UserDeltaEntry> {
  const latest = new Map<string, UserDeltaEntry>();
  for (const entry of entries) {
    const previous = latest.get(entry.id);
    const mergeable = previous && !isRemovedEntry(previous) && !isRemovedEntry(entry);
    latest.set(entry.id, mergeable ? { ...previous, ...entry } : entry);
  }
  return latest;
}

/** Group membership per group id for one run, with the unresolved case reported once. */
function groupResolver(client: GraphClient, warn: (warning: SyncWarning) => void) {
  const cache = new Map<string, ReadonlySet<string> | null>();
  return async (groupId: string): Promise<ReadonlySet<string> | null> => {
    if (cache.has(groupId)) {
      return cache.get(groupId) ?? null;
    }
    let members: ReadonlySet<string> | null = null;
    try {
      members = await listGroupMemberIds(client, groupId);
    } catch (error) {
      // Server-side failures fail the run (it is retried); a group that does not
      // exist or cannot be read is an admin problem, reported and excluded.
      if (!isGraphError(error) || error.status >= 500 || error.status === 429) {
        throw error;
      }
      warn({
        kind: "group_unresolved",
        groupId,
        status: error.status,
        code: error.code ?? null,
        message: error.message.slice(0, 300),
      });
    }
    cache.set(groupId, members);
    return members;
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** Run one directory sync. Throws on failures the run cannot work around. */
export async function syncDirectory(options: DirectorySyncOptions): Promise<DirectorySyncResult> {
  const logger = options.logger ?? noopLogger;
  const progress = options.progress;
  const signal = options.signal;
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  const warnings: SyncWarning[] = [];
  const warn = (warning: SyncWarning) => {
    warnings.push(warning);
    logger.warn(`directory sync: ${warning.kind}`, {
      status: warning.status,
      code: warning.code ?? undefined,
    });
    if (warning.kind !== "group_unresolved") {
      progress?.fail(warning.user ?? warning.userId, `${warning.kind}: ${warning.message}`);
    }
  };

  throwIfAborted(signal);
  progress?.phase("load");
  let snapshot = await options.repository.load();

  progress?.phase("enumerate");
  const delta = await collectUsersDelta(
    options.client,
    options.full ? null : snapshot.deltaLink,
    logger,
    signal,
  );

  const removedUserIds: string[] = [];
  const users: DirectoryUserRecord[] = [];
  const partialIds: string[] = [];
  for (const entry of latestPerUser(delta.entries).values()) {
    if (isRemovedEntry(entry)) {
      removedUserIds.push(entry.id);
      continue;
    }
    const user = toDirectoryUser(entry);
    if (user) {
      users.push(user);
    } else if (isPartialEntry(entry)) {
      partialIds.push(entry.id);
    }
    // A complete entry without any address or UPN cannot be a mailbox owner; skip it.
  }
  if (partialIds.length > 0) {
    progress?.phase("complete");
    users.push(...(await fetchUsersById(options.client, partialIds, warn, signal)));
  }
  progress?.total(users.length);

  progress?.phase("probe");
  const probes = await probeUsers(options.client, users, warn, signal);

  const resolveGroup = groupResolver(options.client, warn);
  let plan: DirectoryPlan | null = null;
  for (let attempt = 1; plan === null; attempt += 1) {
    throwIfAborted(signal);
    const { rules, overrides } = snapshot.protection;
    progress?.phase("plan");
    const groupMemberIds =
      rules.mode === "group" && rules.groupId ? await resolveGroup(rules.groupId) : null;
    const candidate = planDirectory({
      mode: delta.mode,
      users,
      removedUserIds,
      known: snapshot.known,
      sharedOrBlockedIds: snapshot.sharedOrBlockedIds,
      probes,
      rules,
      overrides,
      groupMemberIds,
    });

    throwIfAborted(signal);
    progress?.phase("persist");
    try {
      await options.repository.commit(
        {
          plan: candidate,
          deltaLink: delta.deltaLink,
          fullSyncAt: delta.mode === "incremental" ? null : startedAt,
        },
        snapshot.version,
      );
      plan = candidate;
    } catch (error) {
      if (!(error instanceof DirectoryConflictError) || attempt >= MAX_COMMIT_ATTEMPTS) {
        throw error;
      }
      logger.info("protection rules changed during the sync; planning again", { attempt });
      snapshot = await options.repository.load();
    }
  }
  progress?.advance(users.length);

  logger.info("directory sync finished", {
    mode: delta.mode,
    pages: delta.pages,
    ...plan.counts,
    warnings: warnings.length,
  });
  return {
    mode: delta.mode,
    startedAt,
    deltaLink: delta.deltaLink,
    counts: plan.counts,
    warnings,
    pages: delta.pages,
    newlyActive: newlyActiveObjects(snapshot.known, plan),
  };
}

// ---------------------------------------------------------------------------
// In-memory repository (tests, dry runs)
// ---------------------------------------------------------------------------

/** Keeps the directory in memory with the same commit semantics as the database. */
export class MemoryDirectoryRepository implements DirectoryRepository {
  readonly users = new Map<string, DirectoryUserRecord>();
  readonly objects = new Map<string, KnownObject>();
  readonly commits: DirectoryCommit[] = [];
  deltaLink: string | null = null;
  lastFullSyncAt: string | null = null;
  sharedOrBlockedIds = new Set<string>();
  protection: ProtectionConfig;
  /** Called at the start of every commit, before the version check (tests use it to race). */
  beforeCommit: (() => void) | null = null;

  constructor(protection: ProtectionConfig) {
    this.protection = protection;
  }

  private version(): string {
    return JSON.stringify(this.protection);
  }

  async load(): Promise<DirectorySnapshot> {
    return {
      deltaLink: this.deltaLink,
      known: [...this.objects.values()],
      sharedOrBlockedIds: new Set(this.sharedOrBlockedIds),
      protection: this.protection,
      version: this.version(),
    };
  }

  async commit(commit: DirectoryCommit, expectedVersion: string): Promise<void> {
    this.beforeCommit?.();
    if (this.version() !== expectedVersion) {
      throw new DirectoryConflictError();
    }
    const { plan } = commit;
    this.commits.push(commit);
    for (const user of plan.users) {
      this.users.set(user.entraObjectId, user);
    }
    for (const object of plan.objects) {
      const user = this.users.get(object.ownerId);
      const existing = this.objects.get(object.externalId);
      this.objects.set(object.externalId, {
        externalId: object.externalId,
        kind: object.kind,
        status: object.status,
        origin: "directory_sync",
        displayName: object.displayName,
        owner: user
          ? { entraObjectId: user.entraObjectId, upn: user.upn, email: user.email }
          : (existing?.owner ?? null),
      });
    }
    for (const externalId of plan.orphanExternalIds) {
      const existing = this.objects.get(externalId);
      if (existing) {
        this.objects.set(externalId, { ...existing, status: "orphaned" });
      }
    }
    this.deltaLink = commit.deltaLink;
    this.sharedOrBlockedIds = new Set(plan.sharedOrBlockedIds);
    this.lastFullSyncAt = commit.fullSyncAt ?? this.lastFullSyncAt;
  }
}
