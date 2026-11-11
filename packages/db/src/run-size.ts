/**
 * The size and space guard of backup runs (#99, docs/STORAGE.md "Unusually large runs"): what
 * the api (restic runs through its REST endpoint) and the worker (runs into the chunk store) share.
 * The rule itself is @restow/core run-size; this module reads an object's history and settings,
 * keeps its holds and raises the alert, inside a transaction pinned to the tenant.
 *
 * {@link RunSizeGuard} is one run's guard: asked before every upload with its size, it says
 * whether the upload may go. The first question decides the run's limit (its object's history and
 * settings), and whether an open hold of the object holds this run too or an approval lets it
 * through once. A run that passes its limit is held: a `run_size_holds` row, the event
 * `backup.unusually_large` once, and every further upload of the run is refused without asking
 * the database again.
 */
import {
  describeRunSizeHold,
  judgeRunSize,
  parseRunSizeOverride,
  type RunSizeGuardOverride,
  type RunSizeGuardSettings,
  type RunSizeLimit,
  type RunSizeObjectKind,
  type RunSizeVerdict,
  resolveRunSizeGuard,
  runSizeLimit,
  type StorageSpace,
} from "@restow/core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { type InstallationZoneInput, raiseReportEvents } from "./report-events.js";
import { endpoints } from "./schema/endpoints.js";
import { fileShares } from "./schema/file-shares.js";
import { pveGuests } from "./schema/pve.js";
import { type RunSizeHold, runSizeHolds, runSizeSettings } from "./schema/run-size.js";
import { protectedObjects } from "./schema/sources.js";

// biome-ignore lint/suspicious/noExplicitAny: any schema, a transaction or the pool itself
export type RunSizeTx = Pick<NodePgDatabase<any>, "select" | "insert" | "update" | "execute">;

export const RUN_SIZE_EVENT = "backup.unusually_large";

/** How a run's object reads in a list and an alert, and the ids the alert's links need. */
export interface RunSizeObject {
  readonly name: string;
  /** For a mailbox, OneDrive, site or IMAP account: its kind (the bell names the service). */
  readonly protectedKind?: string;
  readonly ref: Record<string, string>;
}

/**
 * Bytes the object's newest successful backup runs added, newest first (its history for the
 * median). restic runs count what they stored (packed where the run says, else added); chunk store
 * runs the new chunk bytes. A Proxmox VE container counts from its newest backup chain on: a new
 * chain starts an empty repository, whose first run adds everything again.
 */
export async function runSizeHistory(
  tx: Pick<RunSizeTx, "execute">,
  kind: RunSizeObjectKind,
  objectId: string,
  limit: number,
): Promise<number[]> {
  const query = (() => {
    switch (kind) {
      case "endpoint":
        return sql`SELECT COALESCE((r.stats->>'dataAddedPacked')::numeric, (r.stats->>'dataAdded')::numeric) AS bytes
          FROM endpoint_runs r
          WHERE r.endpoint_id = ${objectId}::uuid AND r.kind = 'backup'
            AND r.status IN ('succeeded', 'partial') AND r.finished_at IS NOT NULL
          ORDER BY r.finished_at DESC LIMIT ${limit}`;
      case "file_share":
        return sql`SELECT COALESCE((r.stats->>'dataAddedPacked')::numeric, (r.stats->>'dataAdded')::numeric) AS bytes
          FROM file_share_runs r
          WHERE r.file_share_id = ${objectId}::uuid AND r.kind = 'backup'
            AND r.status IN ('succeeded', 'warning') AND r.finished_at IS NOT NULL
          ORDER BY r.finished_at DESC LIMIT ${limit}`;
      case "pve_guest":
        return sql`SELECT COALESCE((r.stats->>'resticBytesAddedPacked')::numeric, (r.stats->>'resticBytesAdded')::numeric, (r.stats->>'uploadedBytes')::numeric) AS bytes
          FROM pve_runs r JOIN pve_guests g ON g.id = r.guest_id
          WHERE r.guest_id = ${objectId}::uuid AND r.kind = 'backup' AND r.status = 'succeeded'
            AND r.finished_at IS NOT NULL
            AND r.finished_at > COALESCE((g.repository_chains->0->>'at')::timestamptz, '-infinity'::timestamptz)
          ORDER BY r.finished_at DESC LIMIT ${limit}`;
      case "m365":
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
  readonly now?: () => Date;
  readonly log?: (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;
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

/** How long the target's free space is reused between uploads. */
const SPACE_TTL_MS = 30_000;

export class RunSizeGuard {
  private written = 0;
  private state:
    | { phase: "new" }
    | { phase: "exempt" }
    | {
        phase: "watching";
        settings: RunSizeGuardSettings;
        limit: RunSizeLimit;
        object: RunSizeObject | null;
      }
    | { phase: "held"; holdId: string; message: string } = { phase: "new" };
  private starting: Promise<void> | null = null;
  private space: { at: number; value: StorageSpace | null } | null = null;

  constructor(private readonly deps: RunSizeGuardDeps) {}

  /** Bytes the run stored so far, as {@link record} was told. */
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
    }
  }

  /** Whether an upload of `nextBytes` may go. */
  async admit(nextBytes: number): Promise<RunSizeAdmission> {
    if (this.state.phase === "new") {
      this.starting ??= this.start();
      await this.starting;
    }
    const state = this.state;
    if (state.phase === "held") {
      return { ok: false, holdId: state.holdId, message: state.message };
    }
    if (state.phase !== "watching") {
      return { ok: true };
    }
    const verdict = judgeRunSize({
      settings: state.settings,
      limit: state.limit,
      writtenBytes: this.written,
      nextBytes,
      space: state.settings.minFreePercent > 0 ? await this.readSpace() : null,
    });
    if (!verdict.hold) {
      return { ok: true };
    }
    return this.hold(verdict, state.limit, state.object);
  }

  private async readSpace(): Promise<StorageSpace | null> {
    const at = this.now().getTime();
    if (this.space && at - this.space.at < SPACE_TTL_MS) {
      return this.space.value;
    }
    const value = this.deps.space ? await this.deps.space().catch(() => null) : null;
    this.space = { at, value };
    return value;
  }

  /** The first question of the run: an open hold, an approval, the limit. */
  private async start(): Promise<void> {
    const { tenantId, kind, objectId, runId } = this.deps;
    this.state = await this.deps.transaction(async (tx) => {
      const open = await openRunSizeHold(tx, kind, objectId);
      if (open?.status === "approved") {
        // Continue once: this run uses the approval, whatever it adds.
        await tx
          .update(runSizeHolds)
          .set({
            status: "resolved",
            resolution: "continued",
            resolvedAt: this.now(),
            consumedRunId: runId,
          })
          .where(and(eq(runSizeHolds.id, open.id), eq(runSizeHolds.status, "approved")));
        this.deps.log?.("info", "a held backup continues once", { kind, objectId, runId });
        return { phase: "exempt" as const };
      }
      if (open) {
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
      const overrides = await runSizeOverrides(tx, tenantId, kind, objectId);
      const settings = resolveRunSizeGuard(overrides.tenant, overrides.object);
      if (!settings.enabled) {
        return { phase: "exempt" as const };
      }
      const history = await runSizeHistory(tx, kind, objectId, settings.historyRuns);
      return {
        phase: "watching" as const,
        settings,
        limit: runSizeLimit(settings, history),
        object: null,
      };
    });
  }

  private async hold(
    verdict: Exclude<RunSizeVerdict, { hold: false }>,
    limit: RunSizeLimit,
    known: RunSizeObject | null,
  ): Promise<RunSizeAdmission> {
    const { tenantId, kind, objectId, runId } = this.deps;
    const now = this.now();
    const held = await this.deps.transaction(async (tx) => {
      const object = known ?? (await describeRunSizeObject(tx, kind, objectId));
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
  resolution: "limit_raised" | "guard_off",
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
