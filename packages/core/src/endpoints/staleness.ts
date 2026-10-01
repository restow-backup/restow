/**
 * When an endpoint counts as silent (docs/AGENT.md, alerts). One rule for the
 * API (status in the lists) and the worker (the alert), pure:
 *
 *   server profile   silent when no contact for more than 2 hours (a server
 *                    reports every 5 minutes and is always on)
 *   client profile   never "silent" (a laptop is off at night); instead its
 *                    backup is overdue when the last good one is older than a
 *                    configurable number of days, 7 by default
 */
import { DEFAULT_CLIENT_STALE_DAYS, DEFAULT_SERVER_STALE_HOURS } from "./config.js";

export interface StalenessInput {
  profile: "server" | "client";
  status: "active" | "revoked";
  createdAt: Date;
  lastSeenAt: Date | null;
  lastSuccessAt: Date | null;
  settings: { staleAfterHours?: number; staleAfterDays?: number } | null;
}

export interface Staleness {
  /** A server that stopped reporting. */
  silent: boolean;
  /** A client without a good backup for too long. */
  backupOverdue: boolean;
  /** The limit that was applied, for the message. */
  limit: { hours?: number; days?: number };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export function endpointStaleness(input: StalenessInput, now: Date): Staleness {
  if (input.status !== "active") {
    return { silent: false, backupOverdue: false, limit: {} };
  }
  if (input.profile === "server") {
    const hours = input.settings?.staleAfterHours ?? DEFAULT_SERVER_STALE_HOURS;
    const since = input.lastSeenAt ?? input.createdAt;
    return {
      silent: now.getTime() - since.getTime() > hours * HOUR,
      backupOverdue: false,
      limit: { hours },
    };
  }
  const days = input.settings?.staleAfterDays ?? DEFAULT_CLIENT_STALE_DAYS;
  const since = input.lastSuccessAt ?? input.createdAt;
  return {
    silent: false,
    backupOverdue: now.getTime() - since.getTime() > days * DAY,
    limit: { days },
  };
}

/** Contact within this window counts as "online" in the lists (three missed heartbeats). */
export const ONLINE_WINDOW_MS = 15 * 60 * 1000;

export type Connection = "online" | "offline" | "never";

export function connectionOf(lastSeenAt: Date | null, now: Date): Connection {
  if (!lastSeenAt) {
    return "never";
  }
  return now.getTime() - lastSeenAt.getTime() <= ONLINE_WINDOW_MS ? "online" : "offline";
}
