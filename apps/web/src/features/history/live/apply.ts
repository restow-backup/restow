import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import { type BackupJob, type BackupJobList, backupJobKeys } from "@/features/backup-jobs/api";
import {
  type EndpointDetail,
  type RunSummary as EndpointRunSummary,
  type EndpointSummary,
  type RunStatus,
  endpointKeys,
} from "@/features/endpoints/api";
import { type BackupTarget, type Job, jobKeys } from "@/features/jobs/api";
import { withLatestJob } from "@/features/jobs/presenters";
import type { ServerEvent } from "@/features/jobs/sse";
import { verifyKeys } from "@/features/verify/api";

import {
  type BackupJobLive,
  type HistoryFilters,
  type HistoryPage,
  type LiveSnapshot,
  type MachineLive,
  type Run,
  type RunCategory,
  type RunDetail,
  type RunState,
  historyKeys,
} from "../api";

/**
 * What an event of the live channel does to the data the pages already hold. Every page keeps
 * reading its own query; the channel writes into those queries' caches (`setQueryData`), so job
 * pages, History, the overview and the machine pages move without a request of their own.
 *
 *   `run`         the live map of runs (rows and the drawer read it), the History lists that
 *                 hold the run, its detail, and the machine it ran on
 *   `definition`  the backup jobs' lists and details: state, last and next run, restore checks
 *   `machine`     the machines' lists and details: connection, next run
 *   `job`         the older shape of a mail run, for the protected-objects table
 *
 * A change the cache cannot take in place (a run no list holds yet, a job somebody edited, a new
 * machine) refetches the query once, shortly after the last such change. A run that ends also
 * refreshes what its end changes (the overview, the readiness).
 */

type TenantKey = string | null;

/** Runs of the live map are dropped this long after they ended. */
export const LIVE_KEEP_MS = 10 * 60_000;

/** Delay that coalesces a burst of changes into one refetch. */
export const REFETCH_DELAY_MS = 400;

/** How a channel handler asks for a refetch: debounced by `key`. */
export type Refetch = (key: readonly unknown[]) => void;

export interface LiveContext {
  client: QueryClient;
  tenantId: TenantKey;
  refetch: Refetch;
  /** What this connection knows exists, so a newcomer can be told from an old acquaintance. */
  known: { definitions: Set<string>; machines: Set<string> };
  now?: () => number;
}

export function newKnown(): LiveContext["known"] {
  return { definitions: new Set(), machines: new Set() };
}

/** A debouncer over `client.invalidateQueries`; `cancel` stops everything pending (unmount). */
export function createRefetcher(
  client: QueryClient,
  delayMs = REFETCH_DELAY_MS,
): { refetch: Refetch; cancel: () => void } {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    refetch: (key) => {
      const id = JSON.stringify(key);
      const pending = timers.get(id);
      if (pending) {
        clearTimeout(pending);
      }
      timers.set(
        id,
        setTimeout(() => {
          timers.delete(id);
          void client.invalidateQueries({ queryKey: key });
        }, delayMs),
      );
    },
    cancel: () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}

const TERMINAL: ReadonlySet<RunState> = new Set(["succeeded", "partial", "failed", "cancelled"]);

export function isTerminalState(state: RunState): boolean {
  return TERMINAL.has(state);
}

// --- Runs ----------------------------------------------------------------------------------------

export type LiveRuns = Record<string, Run>;

/** The live map after `incoming` joined it, without runs that ended long ago. */
export function mergeLiveRuns(
  current: LiveRuns | undefined,
  incoming: readonly Run[],
  now: number,
  replace = false,
): LiveRuns {
  const next: LiveRuns = replace ? {} : { ...current };
  for (const run of incoming) {
    next[run.id] = run;
  }
  for (const [id, run] of Object.entries(next)) {
    const ended = run.finishedAt ? Date.parse(run.finishedAt) : Number.NaN;
    if (isTerminalState(run.state) && Number.isFinite(ended) && now - ended > LIVE_KEEP_MS) {
      delete next[id];
    }
  }
  return next;
}

function listFilters(key: readonly unknown[]): HistoryFilters {
  // ["tenant", id, "history", "list", type, job]
  const type = key[4];
  const job = key[5];
  return {
    type: type === "all" || typeof type !== "string" ? null : (type as RunCategory),
    job: job === "all" || typeof job !== "string" ? null : job,
  };
}

/** Whether a run belongs in a list that is filtered like this (the job filter needs the run's own job). */
function belongsIn(run: Run, filters: HistoryFilters): "yes" | "no" | "unknown" {
  if (filters.type && run.kind !== filters.type) {
    return "no";
  }
  if (filters.job) {
    // A mail check of the job's objects carries no job of its own: only the server can say.
    return run.job?.id === filters.job ? "yes" : "unknown";
  }
  return "yes";
}

/**
 * Put a run into the pages of a History list. Returns the pages unchanged (same reference) when
 * the run is not in them and does not belong at their head.
 */
export function placeRun(
  data: InfiniteData<HistoryPage, string | null> | undefined,
  run: Run,
): {
  data: InfiniteData<HistoryPage, string | null> | undefined;
  found: boolean;
  inserted: boolean;
} {
  if (!data) {
    return { data, found: false, inserted: false };
  }
  let found = false;
  const pages = data.pages.map((page) => ({
    ...page,
    items: page.items.map((item) => {
      if (item.id !== run.id) {
        return item;
      }
      found = true;
      return run;
    }),
  }));
  if (found) {
    return { data: { ...data, pages }, found: true, inserted: false };
  }
  // A run newer than the newest row of the list belongs at its head: that is where a new run goes.
  const head = data.pages[0]?.items[0];
  if (data.pages.length > 0 && (!head || run.createdAt >= head.createdAt)) {
    const [first, ...rest] = data.pages;
    return {
      data: {
        ...data,
        pages: [
          { ...(first as HistoryPage), items: [run, ...((first as HistoryPage).items ?? [])] },
          ...rest,
        ],
      },
      found: false,
      inserted: true,
    };
  }
  return { data, found: false, inserted: false };
}

/** The status the machine pages use for a run of an agent. */
export function endpointStatusOf(state: RunState): RunStatus {
  switch (state) {
    case "running":
    case "queued":
      return "running";
    case "succeeded":
      return "succeeded";
    case "partial":
      return "partial";
    default:
      return "failed";
  }
}

/** A machine page's run summary with what the live run knows: its state, its end, its progress. */
function patchEndpointRun(previous: EndpointRunSummary, run: Run): EndpointRunSummary {
  const progress = run.state === "running" ? run.progress : null;
  return {
    ...previous,
    status: endpointStatusOf(run.state),
    finishedAt: run.finishedAt,
    checkIncomplete: run.checkIncomplete,
    failure: run.failure ?? previous.failure,
    errorCount: run.progress?.itemsFailed ?? previous.errorCount,
    totalBytesProcessed:
      run.state === "running"
        ? previous.totalBytesProcessed
        : (run.progress?.bytesProcessed ?? previous.totalBytesProcessed),
    progress:
      progress && run.progress
        ? {
            filesDone: run.progress.itemsDone,
            bytesDone: run.progress.bytesProcessed,
            ...(run.progress.itemsTotal !== null ? { totalFiles: run.progress.itemsTotal } : {}),
            ...(run.progress.bytesTotal !== null ? { totalBytes: run.progress.bytesTotal } : {}),
            ...(run.progress.currentPath ? { currentPath: run.progress.currentPath } : {}),
            updatedAt: run.progress.updatedAt ?? run.updatedAt,
          }
        : null,
  };
}

function applyEndpointRun(context: LiveContext, run: Run): void {
  const machineId = run.subject?.id;
  if (run.source !== "endpoint" || !machineId) {
    return;
  }
  const { client, tenantId, refetch } = context;
  let unknown = false;
  const patchSummary = <T extends EndpointSummary>(summary: T): T => {
    if (summary.id !== machineId) {
      return summary;
    }
    const latest = summary.latestRun;
    if (!latest) {
      unknown = true;
      return summary;
    }
    if (latest.id === run.id) {
      return { ...summary, latestRun: patchEndpointRun(latest, run) };
    }
    // A run that started after the one the page shows is the machine's latest now.
    if (run.startedAt && Date.parse(run.startedAt) > Date.parse(latest.startedAt)) {
      unknown = true;
    }
    return summary;
  };
  client.setQueriesData<EndpointSummary[]>({ queryKey: endpointKeys.lists(tenantId) }, (list) =>
    list ? list.map(patchSummary) : list,
  );
  client.setQueryData<EndpointDetail>(endpointKeys.detail(tenantId, machineId), (detail) => {
    if (!detail) {
      return detail;
    }
    const patched = patchSummary(detail);
    const runs = detail.runs.map((entry) =>
      entry.id === run.id ? patchEndpointRun(entry, run) : entry,
    );
    if (!detail.runs.some((entry) => entry.id === run.id)) {
      unknown = true;
    }
    return { ...patched, runs };
  });
  client.setQueryData<EndpointRunSummary>(
    endpointKeys.run(tenantId, machineId, run.id),
    (previous) => (previous ? { ...previous, ...patchEndpointRun(previous, run) } : previous),
  );
  if (unknown) {
    // A new run: the machine's pages carry numbers (readiness, attention) only the server can derive.
    refetch(endpointKeys.all(tenantId));
  }
}

/** What a run that ended changes beyond its own row: the overview and the readiness. */
function applyEnd(context: LiveContext, run: Run): void {
  const { tenantId, refetch } = context;
  refetch(historyKeys.detail(tenantId, run.id));
  if (run.source === "mail") {
    // The run's own page also lists its failed items.
    refetch(jobKeys.detail(tenantId, run.id));
  }
  // The overview (and the Start checklist) read what runs changed.
  refetch(["tenant", tenantId, "dashboard"]);
  refetch(verifyKeys.all(tenantId));
  refetch(jobKeys.objects(tenantId));
  if (run.source === "endpoint") {
    refetch(endpointKeys.all(tenantId));
  }
}

export function applyRun(context: LiveContext, run: Run): void {
  const { client, tenantId, refetch } = context;
  const now = context.now?.() ?? Date.now();
  const previous = client.getQueryData<LiveRuns>(historyKeys.live(tenantId))?.[run.id];
  client.setQueryData<LiveRuns>(historyKeys.live(tenantId), (current) =>
    mergeLiveRuns(current, [run], now),
  );

  // The lists of History.
  for (const query of client.getQueryCache().findAll({ queryKey: historyKeys.lists(tenantId) })) {
    const filters = listFilters(query.queryKey);
    const fit = belongsIn(run, filters);
    const data = query.state.data as InfiniteData<HistoryPage, string | null> | undefined;
    if (!data) {
      continue;
    }
    const placed = placeRun(data, run);
    if (placed.found || (placed.inserted && fit === "yes")) {
      client.setQueryData(query.queryKey, placed.data);
    } else if (fit !== "no" && !placed.found) {
      // New to this list but not at its head, or a job filter the browser cannot decide: ask.
      refetch(query.queryKey);
    }
  }

  // The detail, if it is loaded: the live fields move, the rest follows when the run ends.
  client.setQueryData<RunDetail>(historyKeys.detail(tenantId, run.id), (detail) =>
    detail ? { ...detail, ...run } : detail,
  );

  applyEndpointRun(context, run);

  if (isTerminalState(run.state) && (!previous || !isTerminalState(previous.state))) {
    applyEnd(context, run);
  }
}

// --- The older job event ------------------------------------------------------------------------

export function applyLegacyJob(context: LiveContext, job: Job): void {
  const { client, tenantId, refetch } = context;
  client.setQueryData<BackupTarget[]>(jobKeys.objects(tenantId), (targets) =>
    targets ? (withLatestJob(targets, job) ?? targets) : targets,
  );
  if (job.status === "completed") {
    refetch(jobKeys.objects(tenantId));
  }
}

// --- Backup jobs ----------------------------------------------------------------------------------

function mergeDefinition<T extends BackupJob>(job: T, live: BackupJobLive): T {
  return {
    ...job,
    enabled: live.enabled,
    state: live.state,
    scope: live.scope,
    lastRun: live.lastRun,
    nextRunAt: live.nextRunAt,
    restoreCheck: live.restoreCheck,
    updatedAt: live.updatedAt,
  };
}

export function applyDefinition(context: LiveContext, live: BackupJobLive): void {
  const { client, tenantId, refetch, known } = context;
  const isNew = !known.definitions.has(live.id);
  known.definitions.add(live.id);
  let stale = isNew;
  let moved = false;
  const merge = (job: BackupJob): BackupJob => {
    if (job.id !== live.id) {
      return job;
    }
    // Somebody changed the definition itself (a schedule, a name, the scope): REST has the new text.
    if (job.updatedAt !== live.updatedAt) {
      stale = true;
      return job;
    }
    // Its runs moved: the members' last backups and checks, and the runs tab, moved with them.
    if (job.lastRun.at !== live.lastRun.at || job.lastRun.running !== live.lastRun.running) {
      moved = true;
    }
    return mergeDefinition(job, live);
  };
  client.setQueriesData<BackupJobList>({ queryKey: backupJobKeys.lists(tenantId) }, (list) =>
    list ? { ...list, items: list.items.map(merge) } : list,
  );
  client.setQueryData<BackupJob>(backupJobKeys.detail(tenantId, live.id), (job) =>
    job ? merge(job) : job,
  );
  if (stale) {
    refetch(backupJobKeys.all(tenantId));
  } else if (moved) {
    const detail = backupJobKeys.detail(tenantId, live.id);
    refetch([...detail, "members"]);
    refetch([...detail, "runs"]);
  }
}

export function applyGone(context: LiveContext, kind: "definition" | "machine", id: string): void {
  const { client, tenantId, refetch, known } = context;
  if (kind === "definition") {
    known.definitions.delete(id);
    client.setQueriesData<BackupJobList>({ queryKey: backupJobKeys.lists(tenantId) }, (list) =>
      list ? { ...list, items: list.items.filter((job) => job.id !== id) } : list,
    );
    // What no job covers changed with it.
    refetch(backupJobKeys.lists(tenantId));
    return;
  }
  known.machines.delete(id);
  client.setQueriesData<EndpointSummary[]>({ queryKey: endpointKeys.lists(tenantId) }, (list) =>
    list ? list.filter((machine) => machine.id !== id) : list,
  );
}

// --- Machines ---------------------------------------------------------------------------------------

function mergeMachine<T extends EndpointSummary>(summary: T, live: MachineLive): T {
  return {
    ...summary,
    status: live.status,
    connection: live.connection,
    agentState: live.agentState,
    lastSeenAt: live.lastSeenAt,
    lastBackupAt: live.lastBackupAt,
    lastSuccessAt: live.lastSuccessAt,
    nextRunAt: live.nextRunAt,
  };
}

export function applyMachine(context: LiveContext, live: MachineLive): void {
  const { client, tenantId, refetch, known } = context;
  const isNew = !known.machines.has(live.id);
  known.machines.add(live.id);
  client.setQueriesData<EndpointSummary[]>({ queryKey: endpointKeys.lists(tenantId) }, (list) =>
    list
      ? list.map((machine) => (machine.id === live.id ? mergeMachine(machine, live) : machine))
      : list,
  );
  client.setQueryData<EndpointDetail>(endpointKeys.detail(tenantId, live.id), (detail) =>
    detail ? mergeMachine(detail, live) : detail,
  );
  if (isNew) {
    // A machine that enrolled since the page was read.
    refetch(endpointKeys.lists(tenantId));
  }
}

// --- Dispatch ------------------------------------------------------------------------------------------

function parse<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/** The snapshot a connection opens with: the live map, and what each family contains. */
export function applySnapshot(context: LiveContext, snapshot: LiveSnapshot): void {
  const { client, tenantId, known } = context;
  const now = context.now?.() ?? Date.now();
  client.setQueryData<LiveRuns>(historyKeys.live(tenantId), (current) =>
    mergeLiveRuns(current, snapshot.runs, now, true),
  );
  // The runs of the snapshot update the lists and details like any other change.
  for (const run of snapshot.runs) {
    applyRunToViews(context, run);
  }
  known.definitions = new Set(snapshot.definitions.map((job) => job.id));
  known.machines = new Set(snapshot.machines.map((machine) => machine.id));
  for (const definition of snapshot.definitions) {
    applyDefinitionQuietly(context, definition);
  }
  for (const machine of snapshot.machines) {
    applyMachineQuietly(context, machine);
  }
}

// The snapshot is not news: it must not refetch because a job "is new" (everything is, to a new connection).
function applyRunToViews(context: LiveContext, run: Run): void {
  const { client, tenantId } = context;
  for (const query of client.getQueryCache().findAll({ queryKey: historyKeys.lists(tenantId) })) {
    const data = query.state.data as InfiniteData<HistoryPage, string | null> | undefined;
    const placed = placeRun(data, run);
    if (placed.found) {
      client.setQueryData(query.queryKey, placed.data);
    }
  }
  client.setQueryData<RunDetail>(historyKeys.detail(tenantId, run.id), (detail) =>
    detail ? { ...detail, ...run } : detail,
  );
}

function applyDefinitionQuietly(context: LiveContext, live: BackupJobLive): void {
  const { client, tenantId } = context;
  const merge = (job: BackupJob): BackupJob =>
    job.id === live.id && job.updatedAt === live.updatedAt ? mergeDefinition(job, live) : job;
  client.setQueriesData<BackupJobList>({ queryKey: backupJobKeys.lists(tenantId) }, (list) =>
    list ? { ...list, items: list.items.map(merge) } : list,
  );
  client.setQueryData<BackupJob>(backupJobKeys.detail(tenantId, live.id), (job) =>
    job ? merge(job) : job,
  );
}

function applyMachineQuietly(context: LiveContext, live: MachineLive): void {
  const { client, tenantId } = context;
  client.setQueriesData<EndpointSummary[]>({ queryKey: endpointKeys.lists(tenantId) }, (list) =>
    list
      ? list.map((machine) => (machine.id === live.id ? mergeMachine(machine, live) : machine))
      : list,
  );
  client.setQueryData<EndpointDetail>(endpointKeys.detail(tenantId, live.id), (detail) =>
    detail ? mergeMachine(detail, live) : detail,
  );
}

/** Route one event of the channel to what it changes. Anything unknown or malformed is ignored. */
export function applyEvent(context: LiveContext, event: ServerEvent): void {
  switch (event.event) {
    case "snapshot": {
      const snapshot = parse<LiveSnapshot>(event.data);
      if (snapshot) applySnapshot(context, snapshot);
      return;
    }
    case "run": {
      const run = parse<Run>(event.data);
      if (run?.id) applyRun(context, run);
      return;
    }
    case "definition": {
      const live = parse<BackupJobLive>(event.data);
      if (live?.id) applyDefinition(context, live);
      return;
    }
    case "machine": {
      const live = parse<MachineLive>(event.data);
      if (live?.id) applyMachine(context, live);
      return;
    }
    case "gone": {
      const gone = parse<{ kind?: string; id?: string }>(event.data);
      if (gone?.id && (gone.kind === "definition" || gone.kind === "machine")) {
        applyGone(context, gone.kind, gone.id);
      }
      return;
    }
    case "job": {
      const job = parse<Job>(event.data);
      if (job?.id) applyLegacyJob(context, job);
      return;
    }
    case "jobs": {
      const items = parse<{ items?: Job[] }>(event.data)?.items ?? [];
      for (const job of items) applyLegacyJob(context, job);
      return;
    }
    default:
      return;
  }
}
