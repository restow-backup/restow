/**
 * The size and space guard of backup runs (#99, docs/STORAGE.md "Unusually large runs"): what
 * the api (restic runs through its REST endpoint) and the worker (runs into the chunk store) share.
 * The rule itself is @restow/core run-size; this module reads an object's history and settings,
 * keeps its holds and raises the alert, inside a transaction pinned to the tenant.
 *
 * {@link RunSizeGuard} is one run's guard: asked before every upload with its size, it says
 * whether the upload may go. The first question decides the run's limit (its object's history and
 * settings), and whether an open hold of the object holds this run too or an approval lets it
 * through once. A run that passes its size limit goes on with a notice when its object's size
 * check is in `warn` mode (the default): the event `backup.unusually_large_notice` once per run
 * (`run_size_runs.noticed_at`), no hold. In `hold` mode, and always for space, it is held: a
 * `run_size_holds` row, the event `backup.unusually_large` once, and every further upload of the
 * run is refused without asking the database again.
 */
import {
  describeRunSizeHold,
  describeRunSizeNotice,
  judgeRunSize,
  keepFreeBytes,
  parseRunSizeOverride,
  parseRunSpaceOverride,
  type RunSizeGuardOverride,
  type RunSizeGuardSettings,
  type RunSizeLimit,
  type RunSizeObjectKind,
  type RunSizeVerdict,
  type RunSpaceOverride,
  type RunSpaceRule,
  resolveRunSizeGuard,
  resolveRunSpaceRule,
  runSizeLimit,
  type StorageSpace,
} from "@restow/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type InstallationZoneInput, raiseReportEvents } from "./report-events.js";
import { endpoints } from "./schema/endpoints.js";
import { fileShares } from "./schema/file-shares.js";
import { pveGuests } from "./schema/pve.js";
import {
  type RunSizeHold,
  type RunSizeHoldResolution,
  type RunSizeRun,
  runSizeHolds,
  runSizeRuns,
  runSizeSettings,
} from "./schema/run-size.js";
import { protectedObjects } from "./schema/sources.js";
import { storageTargets } from "./schema/storage.js";
import { settings as installationSettings } from "./schema/system.js";

// biome-ignore lint/suspicious/noExplicitAny: any schema, a transaction or the pool itself
export type RunSizeTx = Pick<NodePgDatabase<any>, "select" | "insert" | "update" | "execute">;

export const RUN_SIZE_EVENT = "backup.unusually_large";
/** A run past its size limit that went on (`warn`, the default): not critical, no hold. */
export const RUN_SIZE_NOTICE_EVENT = "backup.unusually_large_notice";

/** How a run's object reads in a list and an alert, and the ids the alert's links need. */
export interface RunSizeObject {
  readonly name: string;
  /** For a mailbox, OneDrive, site or IMAP account: its kind (the bell names the service). */
  readonly protectedKind?: string;
  readonly ref: Record<string, string>;
}

/**
 * Bytes the object's newest successful backup runs added, newest first (its history for the
 * median), from the start of its current repository on: a new repository (a reset, a new chain,
 * a repository that was gone and was created again) starts empty, its first run adds everything
 * again, and comparing what follows with the old repository's runs would hold them all. Where the
 * current repository starts: the newest run the guard saw begin it (`run_size_runs` exempt as
 * `new_repository`, every kind), a file share's or a container's `repository_ready_at`, a
 * container's newest backup chain. restic runs count what they stored (packed where the run says,
 * else added); chunk store runs the new chunk bytes.
 */
export async function runSizeHistory(
  tx: Pick<RunSizeTx, "execute">,
  kind: RunSizeObjectKind,
  objectId: string,
  limit: number,
): Promise<number[]> {
  const restarted = sql`COALESCE((SELECT max(x.created_at) FROM run_size_runs x
    WHERE x.object_kind = ${kind} AND x.object_id = ${objectId}::uuid
      AND x.exemption = 'new_repository'), '-infinity'::timestamptz)`;
  const query = (() => {
    switch (kind) {
      case "endpoint":
        return sql`SELECT COALESCE((r.stats->>'dataAddedPacked')::numeric, (r.stats->>'dataAdded')::numeric) AS bytes
          FROM endpoint_runs r
          WHERE r.endpoint_id = ${objectId}::uuid AND r.kind = 'backup'
            AND r.status IN ('succeeded', 'partial') AND r.finished_at IS NOT NULL
            AND r.started_at >= ${restarted}
          ORDER BY r.finished_at DESC LIMIT ${limit}`;
      case "file_share":
        return sql`SELECT COALESCE((r.stats->>'dataAddedPacked')::numeric, (r.stats->>'dataAdded')::numeric) AS bytes
          FROM file_share_runs r JOIN file_shares s ON s.id = r.file_share_id
          WHERE r.file_share_id = ${objectId}::uuid AND r.kind = 'backup'
            AND r.status IN ('succeeded', 'warning') AND r.finished_at IS NOT NULL
            AND r.finished_at > COALESCE(s.repository_ready_at, '-infinity'::timestamptz)
            AND r.created_at >= ${restarted}
          ORDER BY r.finished_at DESC LIMIT ${limit}`;
      case "pve_guest":
        return sql`SELECT COALESCE((r.stats->>'resticBytesAddedPacked')::numeric, (r.stats->>'resticBytesAdded')::numeric, (r.stats->>'uploadedBytes')::numeric) AS bytes
          FROM pve_runs r JOIN pve_guests g ON g.id = r.guest_id
          WHERE r.guest_id = ${objectId}::uuid AND r.kind = 'backup' AND r.status = 'succeeded'
            AND r.finished_at IS NOT NULL
            AND r.finished_at > COALESCE((g.repository_chains->0->>'at')::timestamptz, '-infinity'::timestamptz)
            AND r.finished_at > COALESCE(g.repository_ready_at, '-infinity'::timestamptz)
            AND r.created_at >= ${restarted}
          ORDER BY r.finished_at DESC LIMIT ${limit}`;
      case "m365":
        // The chunk store counts the new chunks' plaintext, in history and in the guard alike.
        return sql`SELECT COALESCE((r.payload->'result'->'chunkStats'->>'bytesNew')::numeric, (r.payload->'result'->>'bytes')::numeric) AS bytes
          FROM jobs r
          WHERE r.protected_object_id = ${objectId}::uuid AND r.queue = 'backup'
            AND r.status = 'completed' AND r.completed_at IS NOT NULL
          ORDER BY r.completed_at DESC LIMIT ${limit}`;
    }
  })();
  const result = await tx.execute<{ bytes: string | number | null }>(query);
  return result.rows
    .map((row) => (row.bytes === null ? Number.NaN : Number(row.bytes)))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

/**
 * Whether the object still exists for the guard: a machine not removed, a share, a guest, an
 * account. A hold of an object that is gone holds nothing.
 */
export async function runSizeObjectExists(
  tx: Pick<RunSizeTx, "execute">,
  kind: RunSizeObjectKind,
  objectId: string,
): Promise<boolean> {
  const query = (() => {
    switch (kind) {
      case "endpoint":
        return sql`SELECT 1 FROM endpoints WHERE id = ${objectId}::uuid AND removed_at IS NULL`;
      case "file_share":
        return sql`SELECT 1 FROM file_shares WHERE id = ${objectId}::uuid`;
      case "pve_guest":
        return sql`SELECT 1 FROM pve_guests WHERE id = ${objectId}::uuid`;
      case "m365":
        return sql`SELECT 1 FROM protected_objects WHERE id = ${objectId}::uuid`;
    }
  })();
  return (await tx.execute(query)).rows.length > 0;
}

/**
 * The space rule of the tenant's current primary target (#99): its own override, the tenant's
 * (stored as `space` in the tenant's settings row) and whether the target is the installation's
 * default, which the tenants share (then the installation alone decides).
 */
export async function runSpaceOverrides(
  tx: Pick<RunSizeTx, "select">,
  tenantId: string,
): Promise<{
  tenant: RunSpaceOverride;
  target: RunSpaceOverride;
  targetId: string | null;
  sharedTarget: boolean;
}> {
  const [tenantRow] = await tx
    .select({ settings: runSizeSettings.settings })
    .from(runSizeSettings)
    .where(and(eq(runSizeSettings.tenantId, tenantId), isNull(runSizeSettings.objectKind)));
  const [primary] = await tx
    .select({ id: storageTargets.id, spaceRule: storageTargets.spaceRule })
    .from(storageTargets)
    .where(and(eq(storageTargets.tenantId, tenantId), eq(storageTargets.role, "primary")))
    .limit(1);
  return {
    tenant: parseRunSpaceOverride((tenantRow?.settings as { space?: unknown } | undefined)?.space),
    target: parseRunSpaceOverride(primary?.spaceRule),
    targetId: primary?.id ?? null,
    sharedTarget: !primary,
  };
}

/** The installation's space rule (`settings.run_space_rule`), on the installation pool. */
export async function loadInstallationSpaceRule(
  db: Pick<RunSizeTx, "select">,
): Promise<RunSpaceOverride> {
  const [row] = await db
    .select({ rule: installationSettings.runSpaceRule })
    .from(installationSettings)
    .limit(1);
  return parseRunSpaceOverride(row?.rule);
}

/** The tenant's and the object's overrides (empty when none is stored). */
export async function runSizeOverrides(
  tx: Pick<RunSizeTx, "select">,
  tenantId: string,
  kind: RunSizeObjectKind,
  objectId: string,
): Promise<{ tenant: RunSizeGuardOverride; object: RunSizeGuardOverride }> {
  const rows = await tx
    .select({
      objectKind: runSizeSettings.objectKind,
      objectId: runSizeSettings.objectId,
      settings: runSizeSettings.settings,
    })
    .from(runSizeSettings)
    .where(eq(runSizeSettings.tenantId, tenantId));
  const tenant = rows.find((row) => row.objectKind === null);
  const object = rows.find((row) => row.objectKind === kind && row.objectId === objectId);
  return {
    tenant: parseRunSizeOverride(tenant?.settings),
    object: parseRunSizeOverride(object?.settings),
  };
}

/** The object's open hold (`pending` or `approved`), if it has one. */
export async function openRunSizeHold(
  tx: Pick<RunSizeTx, "select">,
  kind: RunSizeObjectKind,
  objectId: string,
): Promise<RunSizeHold | null> {
  const [row] = await tx
    .select()
    .from(runSizeHolds)
    .where(
      and(
        eq(runSizeHolds.objectKind, kind),
        eq(runSizeHolds.objectId, objectId),
        inArray(runSizeHolds.status, ["pending", "approved"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The name an object reads with, and the ids of its links. */
export async function describeRunSizeObject(
  tx: Pick<RunSizeTx, "select">,
  kind: RunSizeObjectKind,
  objectId: string,
): Promise<RunSizeObject> {
  switch (kind) {
    case "endpoint": {
      const [row] = await tx
        .select({ displayName: endpoints.displayName, hostname: endpoints.hostname })
        .from(endpoints)
        .where(eq(endpoints.id, objectId));
      return { name: row?.displayName || row?.hostname || objectId, ref: { endpointId: objectId } };
    }
    case "file_share": {
      const [row] = await tx
        .select({ name: fileShares.name })
        .from(fileShares)
        .where(eq(fileShares.id, objectId));
      return { name: row?.name ?? objectId, ref: { fileShareId: objectId } };
    }
    case "pve_guest": {
      const [row] = await tx
        .select({ name: pveGuests.name, vmid: pveGuests.vmid, kind: pveGuests.kind })
        .from(pveGuests)
        .where(eq(pveGuests.id, objectId));
      const name = row ? (row.name ?? `${row.kind === "ct" ? "CT" : "VM"} ${row.vmid}`) : objectId;
      return { name, ref: { pveGuestId: objectId } };
    }
    case "m365": {
      const [row] = await tx
        .select({
          name: protectedObjects.displayName,
          externalId: protectedObjects.externalId,
          kind: protectedObjects.kind,
        })
        .from(protectedObjects)
        .where(eq(protectedObjects.id, objectId));
      return {
        name: row?.name || row?.externalId || objectId,
        ...(row?.kind ? { protectedKind: row.kind } : {}),
        ref: { protectedObjectId: objectId },
      };
    }
  }
}

export interface RunSizeGuardDeps {
  readonly tenantId: string;
  readonly kind: RunSizeObjectKind;
  readonly objectId: string;
  /** The run (endpoint_runs, file_share_runs, pve_runs, jobs); null when it cannot be told. */
  readonly runId: string | null;
  /** Runs `fn` in a transaction pinned to the tenant (Row Level Security). */
  readonly transaction: <T>(fn: (tx: RunSizeTx) => Promise<T>) => Promise<T>;
  /** The storage target's space, where it reports it ({@link StorageBackend.freeSpace}). */
  readonly space?: () => Promise<StorageSpace | null>;
  /** For the digest hour of the alert (raiseReportEvents). */
  readonly installationTimeZone?: InstallationZoneInput;
  /**
   * The installation's space rule (`settings.run_space_rule`, which the tenant role cannot read):
   * the caller reads it on the installation pool ({@link loadInstallationSpaceRule}).
   */
  readonly installationSpaceRule?: () => Promise<RunSpaceOverride | null>;
  readonly now?: () => Date;
  readonly log?: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
}

/** What an upload is, as far as the guard cares. */
export interface RunSizeUpload {
  /**
   * The upload begins a new repository (restic's `config`): the run is the first of it, not an
   * unusual one. It is exempt from the size rule and the object's history starts with it.
   */
  readonly startsRepository?: boolean;
  /**
   * A small upload that finishes what is stored (restic's index, snapshot, key, config): exempt
   * from the space rule, so a run whose data went in is not refused its snapshot.
   */
  readonly metadata?: boolean;
}

/** The answer to one upload. */
export type RunSizeAdmission =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The hold that holds the run (new, or the object's open one). */
      readonly holdId: string;
      readonly message: string;
    };

/**
 * What "continue once" lifts: the size rule only (maintainer decision, #99). A run held for space
 * goes ahead only once the target has room again, or the target's space rule is switched off.
 */
export const CONTINUE_ONCE_LIFTS = { size: true, space: false } as const;
/** A run that begins a new repository is no unusual run; the target still needs room for it. */
const NEW_REPOSITORY_LIFTS = { size: true, space: false } as const;

/**
 * A hold for space ends by itself once the target has this much of what it keeps free (half
 * again): just above the line, the next run would be held again at once, with another alert.
 */
const SPACE_RECOVERED_FACTOR = 1.5;
/** How long the target's free space is reused between uploads. */
const SPACE_TTL_MS = 30_000;
/** The run's bytes are written to `run_size_runs` at least this often (bytes or time). */
const FLUSH_BYTES = 256 * 1024 ** 2;
const FLUSH_MS = 30_000;

type Lifts = { size: boolean; space: boolean };

export class RunSizeGuard {
  /** Bytes known stored: from `run_size_runs` at the start plus what was recorded since. */
  private written = 0;
  /** Recorded but not yet written to `run_size_runs`. */
  private unflushed = 0;
  private flushedAt = 0;
  private state:
    | { phase: "new" }
    | {
        phase: "watching";
        settings: RunSizeGuardSettings;
        limit: RunSizeLimit;
        spaceRule: RunSpaceRule;
        lifts: Lifts;
      }
    | { phase: "held"; holdId: string; message: string } = { phase: "new" };
  private starting: Promise<void> | null = null;
  /** The target's space as last read, and the bytes admitted since. */
  private space: { at: number; value: StorageSpace | null; admittedSince: number } | null = null;

  constructor(private readonly deps: RunSizeGuardDeps) {}

  /** Bytes the run stored so far, as far as the guard knows. */
  get writtenBytes(): number {
    return this.written;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Count bytes the run stored (an upload that went through). */
  record(bytes: number): void {
    if (Number.isFinite(bytes) && bytes > 0) {
      this.written += bytes;
      this.unflushed += bytes;
    }
  }

  /**
   * Whether an upload of `nextBytes` may go. A failure to ask the database is thrown, never
   * remembered: the next upload asks again (restic retries a 5xx).
   */
  async admit(nextBytes: number, upload: RunSizeUpload = {}): Promise<RunSizeAdmission> {
    if (this.state.phase === "new") {
      this.starting ??= this.start().catch((error) => {
        this.starting = null;
        throw error;
      });
      await this.starting;
    }
    if (upload.startsRepository && this.state.phase === "watching") {
      await this.markNewRepository();
    }
    const state = this.state;
    if (state.phase === "held") {
      return { ok: false, holdId: state.holdId, message: state.message };
    }
    if (state.phase !== "watching") {
      return { ok: true };
    }
    await this.flush(false);
    const sizeOn = !state.lifts.size;
    const spaceOn = state.spaceRule.enabled && !state.lifts.space && !upload.metadata;
    const space = spaceOn ? await this.readSpace() : null;
    const judge = (limit: RunSizeLimit) =>
      judgeRunSize({
        settings: state.settings,
        limit,
        writtenBytes: this.written,
        nextBytes,
        space,
        keepBytes: spaceOn ? keepFreeBytes(state.spaceRule, space) : null,
      });
    let verdict = judge(sizeOn ? state.limit : { ...state.limit, limitBytes: null });
    if (verdict.hold && verdict.reason === "size" && state.settings.mode === "warn") {
      // `warn` (the default): a notice once, the run goes on; the target's space still counts.
      await this.notice(verdict, state.limit);
      verdict = judge({ ...state.limit, limitBytes: null });
    }
    if (verdict.hold) {
      return this.hold(verdict, state.limit);
    }
    if (spaceOn && this.space) {
      this.space.admittedSince += Math.max(0, nextBytes);
    }
    return { ok: true };
  }

  /**
   * The target's space as last read, less what was admitted since (parallel uploads must not
   * overshoot the rule between two readings).
   */
  private async readSpace(): Promise<StorageSpace | null> {
    const at = this.now().getTime();
    if (!this.space || at - this.space.at >= SPACE_TTL_MS) {
      const value = this.deps.space ? await this.deps.space().catch(() => null) : null;
      this.space = { at, value, admittedSince: 0 };
    }
    const { value, admittedSince } = this.space;
    return value
      ? { freeBytes: Math.max(0, value.freeBytes - admittedSince), totalBytes: value.totalBytes }
      : null;
  }

  /** Write the bytes recorded since the last time (`force`: whatever the amount). */
  private async flush(force: boolean): Promise<void> {
    const { kind, runId } = this.deps;
    if (runId === null || this.unflushed === 0) {
      return;
    }
    const at = this.now().getTime();
    if (!force && this.unflushed < FLUSH_BYTES && at - this.flushedAt < FLUSH_MS) {
      return;
    }
    const delta = this.unflushed;
    this.unflushed = 0;
    this.flushedAt = at;
    try {
      await this.deps.transaction((tx) =>
        tx
          .update(runSizeRuns)
          .set({ writtenBytes: sql`${runSizeRuns.writtenBytes} + ${delta}` })
          .where(and(eq(runSizeRuns.objectKind, kind), eq(runSizeRuns.runId, runId))),
      );
    } catch (error) {
      // Counted again with the next flush.
      this.unflushed += delta;
      throw error;
    }
  }

  /** The run begins a new repository: exempt from the size rule, recorded for the history. */
  private async markNewRepository(): Promise<void> {
    const state = this.state;
    if (state.phase !== "watching" || state.lifts.size) {
      return;
    }
    const { kind, runId } = this.deps;
    if (runId !== null) {
      await this.deps.transaction((tx) =>
        tx
          .update(runSizeRuns)
          .set({ exemption: "new_repository" })
          .where(
            and(
              eq(runSizeRuns.objectKind, kind),
              eq(runSizeRuns.runId, runId),
              isNull(runSizeRuns.exemption),
            ),
          ),
      );
    }
    this.state = { ...state, lifts: { ...NEW_REPOSITORY_LIFTS } };
  }

  /**
   * The first question of the run: what is known of it already (another process, an earlier
   * attempt), an open hold of the object (one for space ends by itself once the target has room
   * again), an approval, the limit.
   */
  private async start(): Promise<void> {
    const { tenantId, kind, objectId, runId } = this.deps;
    const state = await this.deps.transaction(async (tx) => {
      let run: RunSizeRun | null = null;
      if (runId !== null) {
        await tx
          .insert(runSizeRuns)
          .values({ tenantId, objectKind: kind, objectId, runId })
          .onConflictDoNothing();
        [run] = await tx
          .select()
          .from(runSizeRuns)
          .where(and(eq(runSizeRuns.objectKind, kind), eq(runSizeRuns.runId, runId)));
      }
      this.written = run?.writtenBytes ?? 0;
      const overrides = await runSizeOverrides(tx, tenantId, kind, objectId);
      const settings = resolveRunSizeGuard(overrides.tenant, overrides.object);
      const space = await runSpaceOverrides(tx, tenantId);
      const spaceRule = resolveRunSpaceRule({
        installation: this.deps.installationSpaceRule
          ? await this.deps.installationSpaceRule()
          : null,
        tenant: space.tenant,
        target: space.target,
        sharedTarget: space.sharedTarget,
      });
      let lifts: Lifts =
        run?.exemption === "continued"
          ? { ...CONTINUE_ONCE_LIFTS }
          : run?.exemption === "new_repository"
            ? { ...NEW_REPOSITORY_LIFTS }
            : { size: false, space: false };
      if (run?.noticedAt) {
        // The notice of this run went out already (another process, an earlier attempt).
        lifts = { ...lifts, size: true };
      }
      let open = await openRunSizeHold(tx, kind, objectId);
      if (open?.reason === "size" && open.status === "pending" && settings.mode === "warn") {
        // A hold for size made in `hold` mode; the object warns now: the hold ends.
        await tx
          .update(runSizeHolds)
          .set({ status: "resolved", resolution: "settings_changed", resolvedAt: this.now() })
          .where(and(eq(runSizeHolds.id, open.id), eq(runSizeHolds.status, "pending")));
        open = null;
      }
      if (open?.status === "approved") {
        // Continue once: this run uses the approval; recorded on the run, so a restart, a second
        // process or a retry of the run keeps it.
        await tx
          .update(runSizeHolds)
          .set({
            status: "resolved",
            resolution: "continued",
            resolvedAt: this.now(),
            consumedRunId: runId,
          })
          .where(and(eq(runSizeHolds.id, open.id), eq(runSizeHolds.status, "approved")));
        if (runId !== null) {
          await tx
            .update(runSizeRuns)
            .set({ exemption: "continued" })
            .where(and(eq(runSizeRuns.objectKind, kind), eq(runSizeRuns.runId, runId)));
        }
        this.deps.log?.("info", "a held backup continues once", { kind, objectId, runId });
        lifts = { ...CONTINUE_ONCE_LIFTS };
      } else if (open && !(await this.spaceFreed(tx, open, spaceRule))) {
        await tx
          .update(runSizeHolds)
          .set({
            refusedRuns: sql`${runSizeHolds.refusedRuns} + 1`,
            lastRefusedAt: this.now(),
          })
          .where(eq(runSizeHolds.id, open.id));
        return {
          phase: "held" as const,
          holdId: open.id,
          message: `The backup of ${open.objectName} waits for an administrator: an earlier run was held as unusually large (docs/STORAGE.md, "Unusually large runs").`,
        };
      }
      if (!settings.enabled) {
        // The object's (or tenant's) size check is off; the target's space rule still applies.
        lifts = { ...lifts, size: true };
      }
      const history = await runSizeHistory(tx, kind, objectId, settings.historyRuns);
      return {
        phase: "watching" as const,
        settings,
        limit: runSizeLimit(settings, history),
        spaceRule,
        lifts,
      };
    });
    this.flushedAt = this.now().getTime();
    this.state = state;
  }

  /**
   * A hold for space whose target has room again (half again what it keeps free), or whose
   * target's space rule was switched off: it ends (`space_freed`, `settings_changed`) and the run
   * is measured as any other.
   */
  private async spaceFreed(tx: RunSizeTx, open: RunSizeHold, rule: RunSpaceRule): Promise<boolean> {
    if (open.reason !== "space" || open.status !== "pending") {
      return false;
    }
    const space = rule.enabled ? await this.readSpace() : null;
    const keep = rule.enabled ? keepFreeBytes(rule, space) : null;
    if (keep === null) {
      await tx
        .update(runSizeHolds)
        .set({ status: "resolved", resolution: "settings_changed", resolvedAt: this.now() })
        .where(and(eq(runSizeHolds.id, open.id), eq(runSizeHolds.status, "pending")));
      return true;
    }
    if (space === null || space.freeBytes < SPACE_RECOVERED_FACTOR * keep) {
      return false;
    }
    await tx
      .update(runSizeHolds)
      .set({ status: "resolved", resolution: "space_freed", resolvedAt: this.now() })
      .where(and(eq(runSizeHolds.id, open.id), eq(runSizeHolds.status, "pending")));
    this.deps.log?.("info", "a backup held for space continues: the target has room again", {
      kind: this.deps.kind,
      objectId: this.deps.objectId,
      holdId: open.id,
    });
    return true;
  }

  /**
   * The run passed its size limit and its object warns (`warn`): the notice
   * `backup.unusually_large_notice` once per run (`run_size_runs.noticed_at`, so a restart or a
   * retry raises none again), and no further size check for the run.
   */
  private async notice(
    verdict: Extract<RunSizeVerdict, { reason: "size" }>,
    limit: RunSizeLimit,
  ): Promise<void> {
    const state = this.state;
    if (state.phase !== "watching" || state.lifts.size) {
      return;
    }
    // Lifted at once: parallel uploads of the run raise no second notice.
    this.state = { ...state, lifts: { ...state.lifts, size: true } };
    const { tenantId, kind, objectId, runId } = this.deps;
    const now = this.now();
    try {
      await this.flush(true).catch(() => undefined);
      await this.deps.transaction(async (tx) => {
        const object = await describeRunSizeObject(tx, kind, objectId);
        const medianBytes = limit.medianBytes === null ? null : Math.round(limit.medianBytes);
        const notice = {
          objectName: object.name,
          bytes: verdict.bytes,
          limitBytes: verdict.limitBytes,
          medianBytes,
        };
        if (runId !== null) {
          const marked = await tx
            .update(runSizeRuns)
            .set({ noticedAt: now, notice })
            .where(
              and(
                eq(runSizeRuns.objectKind, kind),
                eq(runSizeRuns.runId, runId),
                isNull(runSizeRuns.noticedAt),
              ),
            )
            .returning({ id: runSizeRuns.id });
          if (marked.length === 0) {
            return;
          }
        }
        await raiseReportEvents(
          tx,
          [
            {
              tenantId,
              level: "warning",
              event: RUN_SIZE_NOTICE_EVENT,
              message: describeRunSizeNotice(object.name, notice),
              details: {
                objectKind: object.protectedKind ?? null,
                guardObjectKind: kind,
                guardObjectId: objectId,
                objectName: object.name,
                runId,
                mode: "warn",
                bytes: verdict.bytes,
                limitBytes: verdict.limitBytes,
                medianBytes,
                ...object.ref,
              },
              createdAt: now,
            },
          ],
          now,
          { installationTimeZone: this.deps.installationTimeZone },
        );
      });
    } catch (error) {
      // Not recorded: the next upload asks again.
      this.state = state;
      throw error;
    }
    this.deps.log?.("warn", "a backup run is unusually large and goes on (warn mode)", {
      kind,
      objectId,
      runId,
      bytes: verdict.bytes,
      limitBytes: verdict.limitBytes,
    });
  }

  private async hold(
    verdict: Exclude<RunSizeVerdict, { hold: false }>,
    limit: RunSizeLimit,
  ): Promise<RunSizeAdmission> {
    const { tenantId, kind, objectId, runId } = this.deps;
    const now = this.now();
    await this.flush(true).catch(() => undefined);
    const held = await this.deps.transaction(async (tx) => {
      const object = await describeRunSizeObject(tx, kind, objectId);
      const message = describeRunSizeHold(object.name, verdict, limit.medianBytes);
      // Another run of the object may have been held a moment ago: one open hold per object.
      const existing = await openRunSizeHold(tx, kind, objectId);
      if (existing) {
        return { holdId: existing.id, message };
      }
      const [row] = await tx
        .insert(runSizeHolds)
        .values({
          tenantId,
          objectKind: kind,
          objectId,
          objectName: object.name,
          runId,
          reason: verdict.reason,
          bytes: verdict.bytes,
          limitBytes: verdict.reason === "size" ? verdict.limitBytes : null,
          medianBytes: limit.medianBytes === null ? null : Math.round(limit.medianBytes),
          historyRuns: limit.historyRuns,
          freeBytes: verdict.reason === "space" ? verdict.freeBytes : null,
          totalBytes: verdict.reason === "space" ? verdict.totalBytes : null,
          alertedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: runSizeHolds.id });
      if (!row) {
        const raced = await openRunSizeHold(tx, kind, objectId);
        return { holdId: raced?.id ?? "", message };
      }
      await raiseReportEvents(
        tx,
        [
          {
            tenantId,
            level: "warning",
            event: RUN_SIZE_EVENT,
            message,
            details: {
              holdId: row.id,
              objectKind: object.protectedKind ?? null,
              guardObjectKind: kind,
              objectName: object.name,
              runId,
              reason: verdict.reason,
              bytes: verdict.bytes,
              limitBytes: verdict.reason === "size" ? verdict.limitBytes : null,
              medianBytes: limit.medianBytes,
              freeBytes: verdict.reason === "space" ? verdict.freeBytes : null,
              totalBytes: verdict.reason === "space" ? verdict.totalBytes : null,
              ...object.ref,
            },
            createdAt: now,
          },
        ],
        now,
        { installationTimeZone: this.deps.installationTimeZone },
      );
      return { holdId: row.id, message };
    });
    this.deps.log?.("warn", "a backup run was held as unusually large", {
      kind,
      objectId,
      runId,
      reason: verdict.reason,
      bytes: verdict.bytes,
    });
    this.state = { phase: "held", ...held };
    return { ok: false, ...held };
  }
}

/** Ends the open hold of an object (the guard was switched off for it, or its limit raised). */
export async function resolveRunSizeHolds(
  tx: Pick<RunSizeTx, "update">,
  kind: RunSizeObjectKind,
  objectId: string,
  resolution: Exclude<RunSizeHoldResolution, "continued">,
  now: Date,
): Promise<number> {
  const rows = await tx
    .update(runSizeHolds)
    .set({ status: "resolved", resolution, resolvedAt: now })
    .where(
      and(
        eq(runSizeHolds.objectKind, kind),
        eq(runSizeHolds.objectId, objectId),
        inArray(runSizeHolds.status, ["pending", "approved"]),
        isNull(runSizeHolds.consumedRunId),
      ),
    )
    .returning({ id: runSizeHolds.id });
  return rows.length;
}

/**
 * The hold that held a run, if one did: the hold made for the run itself, or the object's open
 * hold that refused the run's uploads while it ran. Read when the run's failure is stored, so the
 * run says "held" instead of the refusal restic reported.
 */
export async function runSizeHoldOfRun(
  tx: Pick<RunSizeTx, "select">,
  kind: RunSizeObjectKind,
  objectId: string,
  runId: string,
  startedAt: Date,
): Promise<RunSizeHold | null> {
  const rows = await tx
    .select()
    .from(runSizeHolds)
    .where(and(eq(runSizeHolds.objectKind, kind), eq(runSizeHolds.objectId, objectId)))
    .orderBy(sql`${runSizeHolds.createdAt} DESC`)
    .limit(5);
  return (
    rows.find(
      (row) =>
        row.runId === runId ||
        (row.status === "pending" &&
          row.lastRefusedAt !== null &&
          row.lastRefusedAt.getTime() >= startedAt.getTime()),
    ) ?? null
  );
}
