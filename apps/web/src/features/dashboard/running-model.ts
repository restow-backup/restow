import type { PveRunning, Run, SamplePoint } from "@/features/history/api";
import { rateSteps } from "@/features/history/samples";

/**
 * The maths behind "Running now" on the start page, free of React: what a run of any kind looks
 * like to the widget ({@link RunningItem}), which runs belong in it, the throughput history the
 * graphs draw and the total over all runs. Mail, machine and file share runs arrive as the
 * `Run` History and the live channel carry; Proxmox VE guests as their own, smaller shape.
 *
 * The graphs buffer on the client: a run that carries its newest measurements (cumulative bytes
 * at a time) gives its speed per step directly, every other run (a Proxmox VE guest, whose node
 * reports a speed now and then) is sampled by the page every few seconds. A run that ended stays
 * in the total's history until it ages out of the window, so the total does not rewrite the past.
 */

/** What the graphs show: the last five minutes. */
export const RUNNING_WINDOW_MS = 5 * 60_000;
/** How often the page samples the runs that carry no measurements; never faster than the live channel's poll. */
export const SAMPLE_EVERY_MS = 3000;
/** The total is drawn with one point per this long. */
export const TOTAL_STEP_MS = 5000;
/** A run's last speed counts this long after its last measurement; then it has stopped or ended. */
export const HOLD_MS = 20_000;

/** The kind of thing that is being copied. */
export type RunningObject =
  | "mailbox"
  | "onedrive"
  | "site"
  | "group"
  | "imap"
  | "server"
  | "client"
  | "file_share"
  | "vm"
  | "ct";

export type RunningCategory = "backup" | "restore" | "check";

export interface RunningItem {
  /** Unique over the page: `<source>:<run id>`. */
  key: string;
  /** The run's own id. */
  id: string;
  source: "mail" | "endpoint" | "file_share" | "pve";
  object: RunningObject | null;
  category: RunningCategory;
  /** The object's name; null for a run of the whole tenant. */
  name: string | null;
  /** A mailbox's address, a machine's system, a share's location. */
  detail: string | null;
  jobName: string | null;
  /** The tenant, on the "All tenants" view. */
  tenant: { id: string; name: string } | null;
  startedAt: number | null;
  itemsDone: number | null;
  itemsTotal: number | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  /** 0 to 100; null while the size is not known. */
  percent: number | null;
  /**
   * Bytes per second as the source last said it; null where nothing says. It is current only
   * while its report is ({@link currentBps}).
   */
  bps: number | null;
  /**
   * When the source measured the figures (a Proxmox VE node's last report); null where it does
   * not say. A figure keeps being repeated until the next report, so this, not the moment the
   * page looked, is the time of the figure.
   */
  reportedAt: number | null;
  /** The newest measurements, cumulative bytes at a time. */
  samples: readonly SamplePoint[] | null;
  /** A stop was asked for and the run has not ended yet. */
  cancelling: boolean;
  /** Microsoft asked the run to wait. */
  throttled: boolean;
  /** Where the run opens: its page, or the guest's. */
  link: { kind: "run" | "guest"; id: string };
}

export interface TenantRef {
  id: string;
  name: string;
}

const RUN_OBJECTS: ReadonlySet<string> = new Set([
  "mailbox",
  "onedrive",
  "site",
  "group",
  "imap",
  "server",
  "client",
  "file_share",
]);

function epoch(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

function categoryOfRun(kind: Run["kind"]): RunningCategory | null {
  switch (kind) {
    case "backup":
      return "backup";
    case "restore":
      return "restore";
    case "restore_check":
      return "check";
    default:
      // Exports, imports and maintenance are not what the widget is about.
      return null;
  }
}

/** The item of a run that goes on now; null for any other state and for kinds the widget leaves out. */
export function itemFromRun(run: Run, tenant: TenantRef | null = null): RunningItem | null {
  const category = categoryOfRun(run.kind);
  if (run.state !== "running" || category === null) {
    return null;
  }
  const subjectKind = run.subject?.kind;
  const progress = run.progress;
  return {
    key: `${run.source}:${run.id}`,
    id: run.id,
    source: run.source,
    object: subjectKind && RUN_OBJECTS.has(subjectKind) ? (subjectKind as RunningObject) : null,
    category,
    name: run.subject?.name ?? null,
    detail: run.subject?.detail ?? null,
    jobName: run.job?.name ?? null,
    tenant,
    startedAt: epoch(run.startedAt ?? run.createdAt),
    itemsDone: progress ? progress.itemsDone : null,
    itemsTotal: progress?.itemsTotal ?? null,
    bytesDone: progress ? progress.bytesProcessed : null,
    bytesTotal: progress?.bytesTotal ?? null,
    percent: progress?.percent ?? null,
    bps: run.throughput ? run.throughput.processedBps : null,
    reportedAt: null,
    samples: run.samples,
    cancelling: run.cancelling === true,
    throttled: run.throttle !== null && run.throttle !== undefined,
    link: { kind: "run", id: run.id },
  };
}

function categoryOfPve(kind: PveRunning["kind"]): RunningCategory {
  switch (kind) {
    case "backup":
      return "backup";
    case "restore":
      return "restore";
    default:
      return "check";
  }
}

/** The item of a Proxmox VE guest's run. */
export function itemFromPve(run: PveRunning, tenant: TenantRef | null = null): RunningItem {
  const progress = run.progress;
  const total = progress?.bytesTotal ?? null;
  return {
    key: `pve:${run.id}`,
    id: run.id,
    source: "pve",
    object: run.guest.kind,
    category: categoryOfPve(run.kind),
    name: run.guest.name?.trim() || String(run.guest.vmid),
    detail: run.guest.name?.trim() ? `VMID ${run.guest.vmid}` : null,
    jobName: run.jobName,
    tenant,
    startedAt: epoch(run.startedAt),
    itemsDone: null,
    itemsTotal: null,
    bytesDone: progress ? progress.bytesDone : null,
    bytesTotal: total,
    percent:
      progress && total !== null && total > 0
        ? Math.min(100, Math.max(0, Math.floor((progress.bytesDone / total) * 100)))
        : null,
    bps: progress?.bytesPerSecond ?? null,
    reportedAt: epoch(progress?.at),
    samples: null,
    cancelling: run.cancelling,
    throttled: false,
    link: { kind: "guest", id: run.guest.id },
  };
}

/** Most Proxmox VE runs a page lists: the API's `RUNNING_LIMIT` (features/running/dto.ts). */
export const PVE_RUNS_LISTED = 50;

/**
 * The newest {@link PVE_RUNS_LISTED} Proxmox VE runs of the live channel, and whether it holds
 * more: the channel carries one run beyond the limit, which is how the page learns that some are
 * left out. Ordered as the API reads them (newest start first, then by id).
 */
export function limitPve(runs: readonly PveRunning[]): { runs: PveRunning[]; truncated: boolean } {
  const newestFirst = [...runs].sort(
    (a, b) => (epoch(b.startedAt) ?? 0) - (epoch(a.startedAt) ?? 0) || (a.id < b.id ? 1 : -1),
  );
  return {
    runs: newestFirst.slice(0, PVE_RUNS_LISTED),
    truncated: newestFirst.length > PVE_RUNS_LISTED,
  };
}

/** The runs that have gone on longest first, then by name: a stable order while figures move. */
export function sortRunning(items: readonly RunningItem[]): RunningItem[] {
  return [...items].sort((a, b) => {
    const tenant = (a.tenant?.name ?? "").localeCompare(b.tenant?.name ?? "");
    if (tenant !== 0) {
      return tenant;
    }
    const started =
      (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY);
    if (started !== 0 && Number.isFinite(started)) {
      return started;
    }
    return (a.name ?? "").localeCompare(b.name ?? "") || a.key.localeCompare(b.key);
  });
}

/** Everything that goes on, from the runs and Proxmox VE runs of one tenant. */
export function itemsOf(
  runs: readonly Run[],
  pve: readonly PveRunning[],
  tenant: TenantRef | null = null,
): RunningItem[] {
  const items: RunningItem[] = [];
  for (const run of runs) {
    const item = itemFromRun(run, tenant);
    if (item) {
      items.push(item);
    }
  }
  for (const run of pve) {
    items.push(itemFromPve(run, tenant));
  }
  return sortRunning(items);
}

/** Milliseconds a run has gone on; null without a start. */
export function elapsedMs(item: Pick<RunningItem, "startedAt">, now: number): number | null {
  return item.startedAt === null ? null : Math.max(0, now - item.startedAt);
}

/**
 * The speed a run has at `now`: the figure it reported, while the report is recent. A node that
 * went quiet (it crashed, the network is cut, the run is stuck) leaves its run "running" with
 * the last figure, which is no speed any more after {@link HOLD_MS}.
 */
export function currentBps(
  item: Pick<RunningItem, "bps" | "reportedAt">,
  now: number,
): number | null {
  if (item.bps !== null && item.reportedAt !== null && now - item.reportedAt > HOLD_MS) {
    return null;
  }
  return item.bps;
}

// --- Throughput history ------------------------------------------------------------------------

export interface RatePoint {
  /** Epoch ms. */
  at: number;
  /** Bytes per second. */
  bps: number;
}

/** The speed of every step of a run's measurements. */
export function pointsFromSamples(samples: readonly SamplePoint[]): RatePoint[] {
  return rateSteps(samples).map((step) => ({ at: step.at, bps: step.processed }));
}

/** `fresh` replaces what `older` has from its first moment on; everything before stays. */
export function mergePoints(older: readonly RatePoint[], fresh: readonly RatePoint[]): RatePoint[] {
  const first = fresh[0];
  if (!first) {
    return [...older];
  }
  return [...older.filter((point) => point.at < first.at), ...fresh];
}

/**
 * The speed history of the runs on the page. Runs with measurements are read from them; the
 * others are sampled ({@link RateHistory.sample}). Points older than the window are dropped, a
 * run with none left is forgotten.
 */
export class RateHistory {
  private readonly series = new Map<string, RatePoint[]>();
  /** The bytes a run had when its figures last changed, and when that was. */
  private readonly lastBytes = new Map<string, { at: number; bytes: number }>();
  /** The newest report of a run that says when it measured, so a repeated one adds nothing. */
  private readonly lastReport = new Map<string, number>();

  constructor(private readonly windowMs: number = RUNNING_WINDOW_MS) {}

  /**
   * Take in what a run says now (`at`: the moment the page looks). A run with measurements is
   * read from them. Any other adds a point only when it has something new to say: a report
   * newer than the last one (its point is dated by the report, not by the page's beat) or, where
   * the source gives no time, bytes that moved since the last look. The figures arrive slower
   * than the page looks, and the same figure again would draw a flat line and, from the bytes, a
   * sawtooth. It adds none while its state is not current (`derive`: a stale one would draw a
   * line that never was) nor for a report older than {@link HOLD_MS}: that node has gone quiet.
   */
  sample(item: RunningItem, at: number, derive = true): void {
    const known = this.series.get(item.key) ?? [];
    if (item.samples && item.samples.length >= 2) {
      this.series.set(item.key, mergePoints(known, pointsFromSamples(item.samples)));
      return;
    }
    if (!derive) {
      return;
    }
    const reported = item.reportedAt;
    const before = this.lastBytes.get(item.key);
    let when = at;
    if (reported !== null) {
      if (at - reported > HOLD_MS) {
        return;
      }
      const seen = this.lastReport.get(item.key);
      if (seen !== undefined && reported <= seen) {
        return;
      }
      this.lastReport.set(item.key, reported);
      // A clock that runs ahead of the server's must not date a point in the future.
      when = Math.min(reported, at);
    } else if (item.bytesDone !== null && before && item.bytesDone === before.bytes) {
      return;
    }
    let bps = item.bps;
    if (item.bytesDone !== null) {
      if (bps === null && before && when > before.at) {
        bps = Math.max(0, item.bytesDone - before.bytes) / ((when - before.at) / 1000);
      }
      this.lastBytes.set(item.key, { at: when, bytes: item.bytesDone });
    }
    if (bps === null) {
      return;
    }
    const last = known[known.length - 1];
    if (last && last.at >= when) {
      return;
    }
    this.series.set(item.key, [...known, { at: when, bps }]);
  }

  /** Drop what is older than the window. */
  prune(now: number): void {
    const from = now - this.windowMs;
    for (const [key, points] of this.series) {
      const kept = points.filter((point) => point.at >= from);
      if (kept.length === 0) {
        this.series.delete(key);
      } else if (kept.length !== points.length) {
        this.series.set(key, kept);
      }
    }
    for (const [key, last] of this.lastBytes) {
      if (last.at < from) {
        this.lastBytes.delete(key);
      }
    }
    for (const [key, at] of this.lastReport) {
      if (at < from) {
        this.lastReport.delete(key);
      }
    }
  }

  /** One run's points, oldest first. */
  points(key: string): readonly RatePoint[] {
    return this.series.get(key) ?? [];
  }

  /** Every run's points, those of runs that ended included while they are in the window. */
  all(): RatePoint[][] {
    return [...this.series.values()];
  }

  clear(): void {
    this.series.clear();
    this.lastBytes.clear();
    this.lastReport.clear();
  }
}

/** The speed a run's points say at a moment: the last one at or before it, while it still holds. */
export function valueAt(
  points: readonly RatePoint[],
  at: number,
  holdMs: number = HOLD_MS,
): number {
  let value = 0;
  for (const point of points) {
    if (point.at > at) {
      break;
    }
    value = at - point.at <= holdMs ? point.bps : 0;
  }
  return value;
}

/**
 * The total speed over all runs, one point per `stepMs` over the last `windowMs` up to `now`. A
 * run counts from its first point on and for `holdMs` after its last, so one that ended drops out
 * from then on without erasing what it did.
 */
export function totalSeries(
  all: readonly (readonly RatePoint[])[],
  now: number,
  windowMs: number = RUNNING_WINDOW_MS,
  stepMs: number = TOTAL_STEP_MS,
): RatePoint[] {
  const total: RatePoint[] = [];
  const start = now - windowMs;
  for (let at = start; at <= now; at += stepMs) {
    let sum = 0;
    for (const points of all) {
      sum += valueAt(points, at);
    }
    total.push({ at, bps: sum });
  }
  if (total.length === 0 || (total[total.length - 1] as RatePoint).at < now) {
    let sum = 0;
    for (const points of all) {
      sum += valueAt(points, now);
    }
    total.push({ at: now, bps: sum });
  }
  return total;
}

/** The total speed of the runs at `now`; null when no run says its speed. */
export function currentTotal(items: readonly RunningItem[], now: number): number | null {
  let known = false;
  let sum = 0;
  for (const item of items) {
    const bps = currentBps(item, now);
    if (bps !== null) {
      known = true;
      sum += bps;
    }
  }
  return known ? sum : null;
}

export interface TotalSummary {
  current: number;
  average: number;
  peak: number;
}

/** The numbers a text for the total graph names. */
export function summarizeTotal(points: readonly RatePoint[]): TotalSummary {
  if (points.length === 0) {
    return { current: 0, average: 0, peak: 0 };
  }
  const values = points.map((point) => point.bps);
  return {
    current: values[values.length - 1] as number,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
  };
}

/** The bytes the runs have read together, where each knows. */
export function totalBytes(items: readonly RunningItem[]): number {
  return items.reduce((sum, item) => sum + (item.bytesDone ?? 0), 0);
}

// --- Small line --------------------------------------------------------------------------------

export interface SparkPath {
  /** `x,y x,y ...` for a polyline. */
  line: string;
  /** The same closed down to the axis, for the fill. */
  area: string;
  last: { x: number; y: number } | null;
}

const fixed = (value: number) => Number(value.toFixed(1));

/**
 * A run's speed as a small line in a box of `width` x `height`, on the time axis `from`..`to`
 * (the same for every row, so runs line up). A single point has no line to draw; the dot
 * is its mark. The scale is the run's own peak, so a slow run is not flattened by a fast one.
 */
export function sparkPath(
  points: readonly RatePoint[],
  width: number,
  height: number,
  from: number,
  to: number,
): SparkPath {
  const visible = points.filter((point) => point.at >= from && point.at <= to);
  if (visible.length === 0) {
    return { line: "", area: "", last: null };
  }
  const pad = 2;
  const peak = Math.max(...visible.map((point) => point.bps), 1) * 1.1;
  const span = Math.max(1, to - from);
  const x = (at: number) => fixed(pad / 2 + ((at - from) / span) * (width - pad));
  const y = (value: number) => fixed(height - pad / 2 - (value / peak) * (height - pad));
  const coordinates = visible.map((point) => ({ x: x(point.at), y: y(point.bps) }));
  const line = coordinates.map((c) => `${c.x},${c.y}`).join(" ");
  const first = coordinates[0] as { x: number; y: number };
  const last = coordinates[coordinates.length - 1] as { x: number; y: number };
  return { line, area: `${first.x},${height} ${line} ${last.x},${height}`, last };
}
