import {
  type Database,
  type DiskAlertEntry,
  type DiskAlertState,
  type DiskReserveAlertEntry,
  settings,
} from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { type DatabaseService, type DiskKind, type DiskStatus, diskStatus } from "./database.js";
import type { DiskReserve, ReserveStatus } from "./disk-reserve.js";
import { raiseInstallationEvent } from "./notify.js";

/**
 * The low disk space warning (docs/DATABASE.md, "Disk space"). Every quarter of an hour
 * the api looks at the two disks a full one hurts most:
 *
 *   database    the file system under PostgreSQL's data: from the opt-in updater, which
 *               can see it; without the updater (0.5.0, #98), while the database is in its
 *               named volume (`pgdata`, RESTOW_POSTGRES_DATA_TYPE unset or `volume`), read on
 *               the volume `restow-data` next to it, which is on the same disk. A database
 *               moved to a directory of the host is watched only through the updater.
 *   repository  the file system under the installation's local default repository
 *               (STORAGE_LOCAL_PATH or the saved local default)
 *   system      the disk under the operating system and Docker's data directory, read as `/`
 *               from inside the api container (0.4.5; storage/system-disk.ts). Its free space
 *               is also kept once an hour for two weeks (`samples`): the trend the dashboard
 *               shows next to a repository on that disk.
 *
 * A disk is low below a tenth of its size, and always below 5 GiB (a quarter of a disk
 * smaller than 20 GiB). When a disk becomes low, the warning goes out once: a
 * notification in the bell of the provider administrators and, for every event rule that
 * lists `installation.disk_low`, its e-mails and webhooks. It goes out again only after
 * the disk recovered to a fifth above the threshold in between, so a disk hovering around
 * the line does not raise one warning after the other. The state is kept in
 * `settings.disk_alerts`, so an api restart does not repeat the warning.
 *
 * The emergency disk reserve (disk-reserve.ts, #98): every check compares the reserve's marker
 * with what was announced and raises `installation.disk_reserve_released` for a release (also one
 * made while the database was down, by the entrypoint before the migrations) and
 * `installation.disk_reserve_restored` once it is written again. {@link DiskWatch.startReserve}
 * frees and recreates it, every 30 seconds, without the database.
 */

export const DISK_LOW_EVENT = "installation.disk_low";
export const DISK_RESERVE_RELEASED_EVENT = "installation.disk_reserve_released";
export const DISK_RESERVE_RESTORED_EVENT = "installation.disk_reserve_restored";
/** How often the reserve is checked against the floor (statfs only, no database). */
export const RESERVE_CHECK_INTERVAL_MS = 30_000;
/** The first check after the start: soon, a full disk is what it is for. */
const FIRST_RESERVE_CHECK_MS = 5_000;
/** The reserve is written only after this long (the installer writes it on a new server first). */
const RESERVE_CREATE_AFTER_MS = 120_000;
/** After a failed write, the next attempt waits this long. */
const RESERVE_RETRY_MS = 15 * 60_000;
export const DISK_WATCH_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_MS = 90_000;
/** A low disk counts as recovered only this far above its threshold. */
export const DISK_RECOVERED_FACTOR = 1.2;
/** The system disk's free space is kept this often, this long. */
export const SAMPLE_EVERY_MS = 55 * 60_000;
export const SAMPLES_KEPT_MS = 14 * 24 * 60 * 60_000;

export interface DiskWatchDeps {
  db: Database;
  service: Pick<DatabaseService, "disks">;
  /** The system disk (`/`); omitted, it is not watched. */
  systemDisk?: () => Promise<{ freeBytes: number; totalBytes: number } | null>;
  /** The emergency disk reserve (disk-reserve.ts); omitted, there is none. */
  reserve?: DiskReserve;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string, fields?: object) => void;
}

export type DiskWatchOutcome = Record<
  DiskKind,
  "raised" | "low" | "recovered" | "ok" | "unknown"
> & {
  /** What was announced about the reserve; only with a reserve. */
  reserve?: ReserveOutcome;
};

export type ReserveOutcome = "released" | "restored" | "released_restored" | "none";

export class DiskWatch {
  constructor(private readonly deps: DiskWatchDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One check of both disks; raises what became low. */
  async checkOnce(): Promise<DiskWatchOutcome> {
    const [watched, system, reserve] = await Promise.all([
      this.deps.service.disks(),
      this.deps.systemDisk ? this.deps.systemDisk().catch(() => null) : Promise.resolve(null),
      this.deps.reserve ? this.deps.reserve.status().catch(() => null) : Promise.resolve(null),
    ]);
    const disks: Record<DiskKind, DiskStatus | null> = {
      ...watched,
      system: system
        ? { ...diskStatus("system", "/", system.freeBytes, system.totalBytes), device: "system" }
        : null,
    };
    const now = this.now();
    return this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: settings.id, alerts: settings.diskAlerts })
        .from(settings)
        .limit(1)
        .for("update");
      const outcome: DiskWatchOutcome = {
        database: "unknown",
        repository: "unknown",
        system: "unknown",
      };
      if (!row) {
        return outcome;
      }
      const next: DiskAlertState = { ...(row.alerts ?? {}) };
      if (reserve) {
        const decided = decideReserve(next.reserve, reserve);
        next.reserve = decided.entry;
        outcome.reserve = decided.outcome;
        for (const event of decided.raise) {
          await raiseInstallationEvent(tx, reserveEvent(event, reserve, now));
          this.deps.log?.(event === "released" ? "error" : "info", `disk reserve ${event}`, {
            path: reserve.path,
            freeBytes: reserve.freeBytes,
          });
        }
      }
      const decidedKinds: { kind: DiskKind; status: DiskStatus; outcome: string }[] = [];
      for (const kind of DISK_ORDER) {
        const status = disks[kind];
        if (!status) {
          continue;
        }
        const previous = next[kind];
        const decided = decide(previous, status, now);
        next[kind] =
          kind === "system"
            ? { ...decided.entry, samples: withSample(previous?.samples, status, now) }
            : decided.entry;
        outcome[kind] = decided.outcome;
        decidedKinds.push({ kind, status, outcome: decided.outcome });
      }
      // One disk, one warning: the places that lie on the same device are announced together,
      // and not again while one of them is still low from before.
      for (const group of groupByDevice(decidedKinds)) {
        const raised = group.filter((member) => member.outcome === "raised");
        if (raised.length === 0 || group.some((member) => member.outcome === "low")) {
          continue;
        }
        const lead = group[0] as (typeof group)[number];
        const places = group.map((member) => member.kind);
        const status = lead.status;
        await raiseInstallationEvent(tx, {
          event: DISK_LOW_EVENT,
          level: "warning",
          message: `Low disk space ${placesText(places)}: ${formatGib(status.freeBytes)} of ${formatGib(status.totalBytes)} free.${reserveSentence(reserve)}`,
          details: {
            disk: lead.kind,
            // Every place on this disk (0.5.0): the database's, the repository's, the system's.
            disks: places,
            locations: Object.fromEntries(
              group.map((member) => [member.kind, member.status.location]),
            ),
            location: status.location,
            freeBytes: status.freeBytes,
            totalBytes: status.totalBytes,
            thresholdBytes: status.thresholdBytes,
            // The subject line of the alert mail names the disk's place.
            objectName: status.location ?? lead.kind,
            ...reserveDetails(reserve),
          },
          now,
        });
        this.deps.log?.("warn", "disk space is low", {
          disks: places,
          freeBytes: status.freeBytes,
          totalBytes: status.totalBytes,
        });
      }
      await tx
        .update(settings)
        .set({ diskAlerts: next, updatedAt: sql`${settings.updatedAt}` })
        .where(eq(settings.id, row.id));
      return outcome;
    });
  }

  /** Check now and then; `close` stops it. */
  start(): { close(): void } {
    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    const loop = (delay: number) => {
      timer = setTimeout(() => {
        if (closed) {
          return;
        }
        this.checkOnce()
          .catch((error) =>
            this.deps.log?.("warn", "the disk space check failed", {
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          .finally(() => {
            if (!closed) {
              loop(DISK_WATCH_INTERVAL_MS);
            }
          });
      }, delay);
      timer.unref();
    };
    loop(FIRST_CHECK_MS);
    return {
      close() {
        closed = true;
        if (timer) {
          clearTimeout(timer);
        }
      },
    };
  }
}

/**
 * The reserve's own loop (disk-reserve.ts): every {@link RESERVE_CHECK_INTERVAL_MS} it frees the
 * reserve below the floor and, from {@link RESERVE_CREATE_AFTER_MS} after the start on, writes it
 * (again) once there is room; a change is announced at once through {@link DiskWatch.checkOnce},
 * which fails quietly while the database is down (the marker stays, the next check announces it).
 */
export function startReserveGuard(
  watch: Pick<DiskWatch, "checkOnce">,
  reserve: DiskReserve,
  options: {
    log?: DiskWatchDeps["log"];
    now?: () => number;
    intervalMs?: number;
    firstMs?: number;
    createAfterMs?: number;
  } = {},
): { close(): void; tick(): Promise<void> } {
  const now = options.now ?? Date.now;
  const createFrom = now() + (options.createAfterMs ?? RESERVE_CREATE_AFTER_MS);
  let retryFrom = 0;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    const at = now();
    const { action, status } = await reserve.check({
      create: at >= createFrom && at >= retryFrom,
    });
    if (action === "failed") {
      retryFrom = at + RESERVE_RETRY_MS;
      options.log?.("warn", "the disk reserve could not be written", { path: status.path });
    }
    if (action === "released") {
      options.log?.("error", "the disk reserve was freed: the disk is almost full", {
        path: status.path,
        freeBytes: status.freeBytes,
      });
    }
    if (action === "released" || action === "created") {
      await watch.checkOnce().catch((error) =>
        options.log?.("warn", "the disk reserve change could not be announced yet", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  const loop = (delay: number) => {
    timer = setTimeout(() => {
      if (closed) {
        return;
      }
      tick()
        .catch((error) =>
          options.log?.("warn", "the disk reserve check failed", {
            error: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => {
          if (!closed) {
            loop(options.intervalMs ?? RESERVE_CHECK_INTERVAL_MS);
          }
        });
    }, delay);
    timer.unref();
  };
  loop(options.firstMs ?? FIRST_RESERVE_CHECK_MS);
  return {
    tick,
    close() {
      closed = true;
      if (timer) {
        clearTimeout(timer);
      }
    },
  };
}

/** What changed about the reserve since the last announcement, and what to announce. */
export function decideReserve(
  previous: DiskReserveAlertEntry | undefined,
  status: ReserveStatus,
): {
  entry: DiskReserveAlertEntry;
  outcome: ReserveOutcome;
  raise: ("released" | "restored")[];
} {
  const entry: DiskReserveAlertEntry = {
    releasedAt: previous?.releasedAt ?? null,
    restoredAt: previous?.restoredAt ?? null,
  };
  const marker = status.marker;
  const raise: ("released" | "restored")[] = [];
  if (marker && marker.releasedAt !== entry.releasedAt) {
    raise.push("released");
    entry.releasedAt = marker.releasedAt;
  }
  if (marker?.restoredAt && marker.restoredAt !== entry.restoredAt && status.state === "present") {
    raise.push("restored");
    entry.restoredAt = marker.restoredAt;
  }
  const outcome: ReserveOutcome = raise.length === 2 ? "released_restored" : (raise[0] ?? "none");
  return { entry, outcome, raise };
}

function reserveEvent(
  kind: "released" | "restored",
  reserve: ReserveStatus,
  now: Date,
): Parameters<typeof raiseInstallationEvent>[1] {
  const marker = reserve.marker;
  const details = {
    path: reserve.path,
    reserveBytes: reserve.bytes,
    floorBytes: reserve.floorBytes,
    // Free space now, and when it was freed.
    freeBytes: reserve.freeBytes,
    totalBytes: reserve.totalBytes,
    createAtBytes: reserve.createAtBytes,
    releasedAt: marker?.releasedAt ?? null,
    releaseReason: marker?.reason ?? null,
    freeAtReleaseBytes: marker?.freeBytes ?? null,
    restoredAt: marker?.restoredAt ?? null,
    objectName: reserve.path,
  };
  if (kind === "released") {
    const at = marker?.freeBytes != null ? ` with ${formatGib(marker.freeBytes)} left` : "";
    return {
      event: DISK_RESERVE_RELEASED_EVENT,
      level: "error",
      message: `The emergency disk reserve (${formatGib(reserve.bytes)} at ${reserve.path}) was freed${at}: the disk under the data volume was almost full. Free up space now (docs/DATABASE.md, "Disk full"); the reserve is written again once ${reserve.createAtBytes !== null ? formatGib(reserve.createAtBytes) : "enough"} are free.`,
      details,
      now,
    };
  }
  return {
    event: DISK_RESERVE_RESTORED_EVENT,
    level: "info",
    message: `The emergency disk reserve (${formatGib(reserve.bytes)} at ${reserve.path}) was written again${reserve.freeBytes !== null ? `; ${formatGib(reserve.freeBytes)} are free` : ""}.`,
    details,
    now,
  };
}

/** The reserve in a low-space warning: where it is and how it is freed. */
function reserveSentence(reserve: ReserveStatus | null): string {
  if (reserve?.state !== "present") {
    return "";
  }
  return ` An emergency reserve of ${formatGib(reserve.presentBytes)} is kept at ${reserve.path} on the disk of the data volume: it is freed by itself below ${formatGib(reserve.floorBytes)} free, or by hand with "docker compose exec api restow disk-reserve release".`;
}

function reserveDetails(reserve: ReserveStatus | null): Record<string, unknown> {
  if (!reserve || reserve.state === "off" || reserve.state === "unavailable") {
    return {};
  }
  return {
    reservePath: reserve.path,
    reserveBytes: reserve.state === "present" ? reserve.presentBytes : 0,
    reserveState: reserve.state,
    reserveFloorBytes: reserve.floorBytes,
    reserveCommand: "docker compose exec api restow disk-reserve release",
  };
}

/** The order places are named in: the system disk first, it holds everything else in the default setup. */
const DISK_ORDER: readonly DiskKind[] = ["system", "database", "repository"];

/**
 * The checked disks grouped by device ({@link DiskStatus.device}), in {@link DISK_ORDER}: one group
 * per device, a disk whose device cannot be told a group of its own.
 */
export function groupByDevice<T extends { kind: DiskKind; status: Pick<DiskStatus, "device"> }>(
  disks: readonly T[],
): T[][] {
  const groups = new Map<string, T[]>();
  const sorted = [...disks].sort((a, b) => DISK_ORDER.indexOf(a.kind) - DISK_ORDER.indexOf(b.kind));
  for (const disk of sorted) {
    const key = disk.status.device ?? `own:${disk.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), disk]);
  }
  return [...groups.values()];
}

/** "under the database" or "on the system disk of the server, under the database and ...". */
function placesText(places: readonly DiskKind[]): string {
  const [first, ...rest] = places;
  if (!first) {
    return "";
  }
  if (rest.length === 0) {
    return DISK_PLACES[first];
  }
  const others = rest.map((kind) => DISK_PLACES[kind]);
  const tail =
    others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`;
  return `${DISK_PLACES[first]}, which is also the disk ${tail}`;
}

const DISK_PLACES: Record<DiskKind, string> = {
  database: "under the database",
  repository: "under the local repository",
  system: "on the system disk of the server",
};

/** The samples with this check's free space, at most one per {@link SAMPLE_EVERY_MS}. */
export function withSample(
  samples: readonly { at: string; freeBytes: number }[] | undefined,
  status: Pick<DiskStatus, "freeBytes">,
  now: Date,
): { at: string; freeBytes: number }[] {
  const kept = (samples ?? []).filter(
    (sample) => now.getTime() - Date.parse(sample.at) < SAMPLES_KEPT_MS,
  );
  const last = kept.at(-1);
  if (last && now.getTime() - Date.parse(last.at) < SAMPLE_EVERY_MS) {
    return kept;
  }
  return [...kept, { at: now.toISOString(), freeBytes: status.freeBytes }];
}

/** The next state of one disk, and what happened. */
export function decide(
  previous: DiskAlertEntry | undefined,
  status: DiskStatus,
  now: Date,
): { entry: DiskAlertEntry; outcome: "raised" | "low" | "recovered" | "ok" } {
  const measured = { freeBytes: status.freeBytes, totalBytes: status.totalBytes };
  if (status.low) {
    if (previous?.low) {
      return { entry: { ...previous, ...measured }, outcome: "low" };
    }
    return {
      entry: { low: true, since: now.toISOString(), notifiedAt: now.toISOString(), ...measured },
      outcome: "raised",
    };
  }
  if (previous?.low && status.freeBytes < status.thresholdBytes * DISK_RECOVERED_FACTOR) {
    // Above the line but not clearly: still the same episode.
    return { entry: { ...previous, ...measured }, outcome: "low" };
  }
  return {
    entry: { low: false, since: null, notifiedAt: null, ...measured },
    outcome: previous?.low ? "recovered" : "ok",
  };
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
