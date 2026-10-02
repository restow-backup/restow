import { connectionOf } from "@restow/core";
import { type Database, endpoints } from "@restow/db";
import { eq } from "drizzle-orm";
import { withTenantTx } from "../../lib/tenant-context.js";
import type { BackupJobDto } from "../backup-jobs/dto.js";
import { listBackupJobs } from "../backup-jobs/read.js";
import type { JobDto } from "../jobs/dto.js";
import {
  LIVE_LOOKBACK_MS,
  RECONNECT_MS,
  type SseMessage,
  type StreamStep,
  jobMessage,
  jobsMessage,
} from "../jobs/events.js";
import type { RunDto, RunState } from "./dto.js";
import { liveRuns } from "./read.js";

/**
 * The live channel: one stream per browser tab with everything the pages show moving.
 *
 * The same pattern as the job stream before it: the server reads the tenant's rows every
 * `POLL_INTERVAL_MS` (events.ts), remembers what it sent, and sends only what changed. What it
 * carries, in three families:
 *
 *   runs         every run in flight or finished lately, mail and agent alike, in one DTO
 *                (progress, throughput, the newest measurements)        `run`
 *   definitions  each backup job's state, last and next run, restore check   `definition`
 *   machines     each machine's connection state and its next run          `machine`
 *
 * plus the legacy `jobs` and `job` events, the mail runs in the shape `/api/v1/jobs/events` has
 * always sent, for the pages that were written against them. The first message is a `snapshot`
 * of all three families, so a client that (re)connects needs no other request. Runs are read
 * every poll; machines every third and definitions every fifth (or right after a run changed
 * its state, the moment a job's "last run" can have moved). A definition or machine that
 * disappeared is announced with `gone`. A comment line keeps the connection open between
 * messages (events.ts).
 *
 * Everything here is pure except {@link databaseSources}, so the shaping, the change detection
 * and the cadence are tested without a database or a socket.
 */

/** Machines are re-read every this many polls. */
export const MACHINES_EVERY = 3;
/** Definitions are re-read every this many polls (and after any run changed its state). */
export const DEFINITIONS_EVERY = 5;

/** What a job's row needs to stay current; the editable parts (schedule, settings) are left to REST. */
export type BackupJobLiveDto = Pick<
  BackupJobDto,
  | "id"
  | "kind"
  | "enabled"
  | "state"
  | "scope"
  | "lastRun"
  | "nextRunAt"
  | "restoreCheck"
  | "updatedAt"
>;

export interface MachineLiveDto {
  id: string;
  status: "active" | "revoked";
  connection: "online" | "offline" | "never";
  agentState: "idle" | "running" | null;
  lastSeenAt: string | null;
  lastBackupAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
}

export function liveDefinition(job: BackupJobDto): BackupJobLiveDto {
  return {
    id: job.id,
    kind: job.kind,
    enabled: job.enabled,
    state: job.state,
    scope: job.scope,
    lastRun: job.lastRun,
    nextRunAt: job.nextRunAt,
    restoreCheck: job.restoreCheck,
    updatedAt: job.updatedAt,
  };
}

export interface LiveSnapshot {
  runs: RunDto[];
  definitions: BackupJobLiveDto[];
  machines: MachineLiveDto[];
  /** The server's clock, so the client can tell how far its own is off before it ticks countdowns. */
  serverTime: string;
}

export function snapshotMessage(snapshot: LiveSnapshot): SseMessage {
  return { event: "snapshot", data: JSON.stringify(snapshot), retry: RECONNECT_MS };
}

/** A changed run. The id lets a reconnecting browser tell where it was. */
export function runMessage(run: RunDto): SseMessage {
  return { event: "run", data: JSON.stringify(run), id: `${run.id}:${run.updatedAt}` };
}

export function definitionMessage(definition: BackupJobLiveDto): SseMessage {
  return { event: "definition", data: JSON.stringify(definition) };
}

export function machineMessage(machine: MachineLiveDto): SseMessage {
  return { event: "machine", data: JSON.stringify(machine) };
}

export function goneMessage(kind: "definition" | "machine", id: string): SseMessage {
  return { event: "gone", data: JSON.stringify({ kind, id }) };
}

/**
 * Remembers what each item looked like when it was last sent and reports only what changed
 * since, and what is no longer there. Bounded by the size of what it follows.
 */
export class KeyedTracker<T> {
  private readonly seen = new Map<string, string>();

  constructor(private readonly idOf: (item: T) => string) {}

  /** Record `items` as sent without reporting them (after the snapshot). */
  prime(items: readonly T[]): void {
    this.seen.clear();
    for (const item of items) {
      this.seen.set(this.idOf(item), JSON.stringify(item));
    }
  }

  /** The items that are new or differ from what was last sent, and the ids that are gone. */
  changes(current: readonly T[]): { changed: T[]; gone: string[] } {
    const changed: T[] = [];
    const present = new Set<string>();
    for (const item of current) {
      const id = this.idOf(item);
      present.add(id);
      const print = JSON.stringify(item);
      if (this.seen.get(id) !== print) {
        this.seen.set(id, print);
        changed.push(item);
      }
    }
    const gone: string[] = [];
    for (const id of [...this.seen.keys()]) {
      if (!present.has(id)) {
        this.seen.delete(id);
        gone.push(id);
      }
    }
    return { changed, gone };
  }
}

/** Where the stream reads from; the database in production, canned data in tests. */
export interface LiveSources {
  runs(): Promise<{ runs: RunDto[]; jobs: JobDto[] }>;
  definitions(): Promise<BackupJobLiveDto[]>;
  machines(): Promise<MachineLiveDto[]>;
}

export interface LiveStepOptions {
  readonly machinesEvery?: number;
  readonly definitionsEvery?: number;
  readonly now?: () => Date;
}

/**
 * The step of one stream: the snapshot on the first poll, changes after it. Create one per
 * connection (it holds what that client has been sent).
 */
export function createLiveStep(
  sources: LiveSources,
  options: LiveStepOptions = {},
): () => Promise<StreamStep> {
  const machinesEvery = options.machinesEvery ?? MACHINES_EVERY;
  const definitionsEvery = options.definitionsEvery ?? DEFINITIONS_EVERY;
  const now = options.now ?? (() => new Date());
  const runs = new KeyedTracker<RunDto>((run) => run.id);
  const legacy = new KeyedTracker<JobDto>((job) => job.id);
  const definitions = new KeyedTracker<BackupJobLiveDto>((item) => item.id);
  const machines = new KeyedTracker<MachineLiveDto>((item) => item.id);
  const states = new Map<string, RunState>();
  let tick = 0;

  return async () => {
    const current = tick++;
    if (current === 0) {
      const [live, defs, macs] = await Promise.all([
        sources.runs(),
        sources.definitions(),
        sources.machines(),
      ]);
      runs.prime(live.runs);
      legacy.prime(live.jobs);
      definitions.prime(defs);
      machines.prime(macs);
      for (const run of live.runs) {
        states.set(run.id, run.state);
      }
      return {
        messages: [
          snapshotMessage({
            runs: live.runs,
            definitions: defs,
            machines: macs,
            serverTime: now().toISOString(),
          }),
          jobsMessage(live.jobs),
        ],
        done: false,
      };
    }

    const messages: SseMessage[] = [];
    const live = await sources.runs();
    let stateChanged = false;
    for (const run of runs.changes(live.runs).changed) {
      if (states.get(run.id) !== run.state) {
        states.set(run.id, run.state);
        stateChanged = true;
      }
      messages.push(runMessage(run));
    }
    for (const job of legacy.changes(live.jobs).changed) {
      messages.push(jobMessage(job));
    }
    if (current % machinesEvery === 0) {
      const { changed, gone } = machines.changes(await sources.machines());
      for (const machine of changed) messages.push(machineMessage(machine));
      for (const id of gone) messages.push(goneMessage("machine", id));
    }
    if (stateChanged || current % definitionsEvery === 0) {
      const { changed, gone } = definitions.changes(await sources.definitions());
      for (const definition of changed) messages.push(definitionMessage(definition));
      for (const id of gone) messages.push(goneMessage("definition", id));
    }
    return { messages, done: false };
  };
}

/** The live window opens this long before the stream does (the same minute as the job stream's). */
export function liveWindowStart(now: Date, lookbackMs: number = LIVE_LOOKBACK_MS): Date {
  return new Date(now.getTime() - lookbackMs);
}

/** The sources over the database, for one tenant. `since` is fixed when the stream opens. */
export function databaseSources(db: Database, tenantId: string, since: Date): LiveSources {
  return {
    runs: () => withTenantTx(db, tenantId, (tx) => liveRuns(tx, tenantId, since)),
    definitions: async () => {
      // The hook texts stay masked: the stream carries no settings, only what moves.
      const { items } = await listBackupJobs(db, tenantId, {}, { revealHooks: false });
      return items.map(liveDefinition);
    },
    machines: () =>
      withTenantTx(db, tenantId, async (tx) => {
        const rows = await tx
          .select({
            id: endpoints.id,
            status: endpoints.status,
            agentState: endpoints.agentState,
            lastSeenAt: endpoints.lastSeenAt,
            lastBackupAt: endpoints.lastBackupAt,
            lastSuccessAt: endpoints.lastSuccessAt,
            nextRunAt: endpoints.nextRunAt,
          })
          .from(endpoints)
          .where(eq(endpoints.tenantId, tenantId));
        const at = new Date();
        return rows.map(
          (row): MachineLiveDto => ({
            id: row.id,
            status: row.status,
            connection: connectionOf(row.lastSeenAt, at),
            agentState: row.agentState,
            lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
            lastBackupAt: row.lastBackupAt?.toISOString() ?? null,
            lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
            nextRunAt: row.nextRunAt?.toISOString() ?? null,
          }),
        );
      }),
  };
}
