import { type Database, type DiskAlertEntry, type DiskAlertState, settings } from "@restow/db";
import { eq, sql } from "drizzle-orm";
import type { DatabaseService, DiskKind, DiskStatus } from "./database.js";
import { raiseInstallationEvent } from "./notify.js";

/**
 * The low disk space warning (docs/DATABASE.md, "Disk space"). Every quarter of an hour
 * the api looks at the two disks a full one hurts most:
 *
 *   database    the file system under PostgreSQL's data (from the opt-in updater, which
 *               can see it; without the updater it is not watched)
 *   repository  the file system under the installation's local default repository
 *               (STORAGE_LOCAL_PATH or the saved local default)
 *
 * A disk is low below a tenth of its size, and always below 5 GiB (a quarter of a disk
 * smaller than 20 GiB). When a disk becomes low, the warning goes out once: a
 * notification in the bell of the provider administrators and, for every event rule that
 * lists `installation.disk_low`, its e-mails and webhooks. It goes out again only after
 * the disk recovered to a fifth above the threshold in between, so a disk hovering around
 * the line does not raise one warning after the other. The state is kept in
 * `settings.disk_alerts`, so an api restart does not repeat the warning.
 */

export const DISK_LOW_EVENT = "installation.disk_low";
export const DISK_WATCH_INTERVAL_MS = 15 * 60_000;
const FIRST_CHECK_MS = 90_000;
/** A low disk counts as recovered only this far above its threshold. */
export const DISK_RECOVERED_FACTOR = 1.2;

export interface DiskWatchDeps {
  db: Database;
  service: Pick<DatabaseService, "disks">;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string, fields?: object) => void;
}

export type DiskWatchOutcome = Record<DiskKind, "raised" | "low" | "recovered" | "ok" | "unknown">;

export class DiskWatch {
  constructor(private readonly deps: DiskWatchDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One check of both disks; raises what became low. */
  async checkOnce(): Promise<DiskWatchOutcome> {
    const disks = await this.deps.service.disks();
    const now = this.now();
    return this.deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: settings.id, alerts: settings.diskAlerts })
        .from(settings)
        .limit(1)
        .for("update");
      const outcome: DiskWatchOutcome = { database: "unknown", repository: "unknown" };
      if (!row) {
        return outcome;
      }
      const next: DiskAlertState = { ...(row.alerts ?? {}) };
      for (const kind of ["database", "repository"] as const) {
        const status = disks[kind];
        if (!status) {
          continue;
        }
        const previous = next[kind];
        const decided = decide(previous, status, now);
        next[kind] = decided.entry;
        outcome[kind] = decided.outcome;
        if (decided.outcome === "raised") {
          await raiseInstallationEvent(tx, {
            event: DISK_LOW_EVENT,
            level: "warning",
            message: `Low disk space under the ${kind === "database" ? "database" : "local repository"}: ${formatGib(status.freeBytes)} of ${formatGib(status.totalBytes)} free.`,
            details: {
              disk: kind,
              location: status.location,
              freeBytes: status.freeBytes,
              totalBytes: status.totalBytes,
              thresholdBytes: status.thresholdBytes,
              // The subject line of the alert mail names the disk's place.
              objectName: status.location ?? kind,
            },
            now,
          });
          this.deps.log?.("warn", "disk space is low", {
            disk: kind,
            freeBytes: status.freeBytes,
            totalBytes: status.totalBytes,
          });
        }
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
