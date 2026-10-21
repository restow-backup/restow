import type { Database, JobPauseRequester, JobStartPause } from "@restow/db";
import { jobStartPause } from "@restow/db";
import { and, eq, lte, sql } from "drizzle-orm";
import { INSTALLED_AGENT } from "../endpoints/commands.js";

/**
 * Nodes and agents follow the server (0.4.2, docs/UPDATING.md "Nodes and agents"): once the
 * server runs the new release, the pause of new job starts moves to the phase `fleet`. While it
 * holds, every heartbeat of a Proxmox VE node (restow-pve) and of an endpoint agent that runs an
 * older release says "update now"; they install the release when idle, and during the pause they
 * are idle. The pause lifts once every reachable node and agent reports the release, or after
 * {@link FLEET_WINDOW_MS} in any case. Unreachable ones are listed with the command for an update
 * by hand. On the installation pool, across tenants.
 */

/** How long the pause waits for nodes and agents at most. */
export const FLEET_WINDOW_MS = 15 * 60 * 1000;
/**
 * Reachable: seen within this time. Agents call every 5 minutes (one minute of jitter), nodes
 * every minute.
 */
export const FLEET_REACHABLE_MS = 7 * 60 * 1000;
/** Members listed at most (the ones still to update first); the counts cover all of them. */
export const FLEET_LIST_LIMIT = 200;

/**
 * What one runs by hand on a node or a machine that was not reached. restow-pve and an agent from
 * 0.4.2 on (`restow-agent update`) install the offered release at once (an agent not while a
 * backup runs). An older agent has no `update` command: restarting its service makes it look for
 * the update a minute later (`legacy`, for agents before `agentUpdateSince`).
 */
export const MANUAL_UPDATE_COMMANDS = {
  pve_node: "/opt/restow-pve/bin/restow-pve update",
  linux: `sudo '${INSTALLED_AGENT.linux}' update`,
  darwin: `sudo '${INSTALLED_AGENT.darwin}' update`,
  legacy: {
    linux: "sudo systemctl restart restow-agent",
    darwin: "sudo launchctl kickstart -k system/com.restowbackup.agent",
  },
  agentUpdateSince: "0.4.2",
} as const;

export type FleetMemberKind = "pve_node" | "agent";
/**
 * `updated`: runs the release (or a development build, which never updates itself);
 * `pending`: reachable and behind, it updates when idle; `unreachable`: behind and silent;
 * `paused`: behind, but automatic agent updates are paused for its tenant or the machine.
 */
export type FleetMemberState = "updated" | "pending" | "unreachable" | "paused";

export interface FleetMember {
  kind: FleetMemberKind;
  id: string;
  tenantId: string;
  tenantName: string;
  name: string;
  /** The operating system of an agent's machine (`linux`, `darwin`); null for a node. */
  os: string | null;
  version: string | null;
  state: FleetMemberState;
  lastSeenAt: string | null;
}

export interface FleetCounts {
  updated: number;
  pending: number;
  unreachable: number;
  paused: number;
  total: number;
}

export interface FleetStatus {
  /** The release nodes and agents update to (the agent release this server announces). */
  targetVersion: string;
  counts: Record<FleetMemberKind, FleetCounts> & { all: FleetCounts };
  /** The members still to update (pending, unreachable, paused), at most FLEET_LIST_LIMIT. */
  members: FleetMember[];
  truncated: boolean;
  commands: typeof MANUAL_UPDATE_COMMANDS;
}

/** `0.4.2-rc.1` -> `{0,4,2}`; anything else -> null (compared as "not behind"). */
function versionArray(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const emptyCounts = (): FleetCounts => ({
  updated: 0,
  pending: 0,
  unreachable: 0,
  paused: 0,
  total: 0,
});

/**
 * Where the nodes and agents stand against `targetVersion`: counts over all of them, one
 * aggregate query, and the first members still to update.
 */
export async function fleetStatus(
  db: Database,
  targetVersion: string,
  now: Date,
): Promise<FleetStatus> {
  const target = versionArray(targetVersion);
  const reachableSince = new Date(now.getTime() - FLEET_REACHABLE_MS);
  const counts = {
    pve_node: emptyCounts(),
    agent: emptyCounts(),
    all: emptyCounts(),
  };
  if (!target) {
    return {
      targetVersion,
      counts,
      members: [],
      truncated: false,
      commands: MANUAL_UPDATE_COMMANDS,
    };
  }
  const targetSql = sql`ARRAY[${target[0]}, ${target[1]}, ${target[2]}]::int[]`;
  // The members with their state, in SQL: the version as an int[] of its first three numbers.
  const members = sql`
    WITH m AS (
      SELECT 'pve_node'::text AS kind, n.id, n.tenant_id, t.name AS tenant_name, n.name,
             NULL::text AS os, n.helper_version AS version, n.last_seen_at,
             false AS updates_paused
        FROM pve_nodes n JOIN tenants t ON t.id = n.tenant_id
       WHERE n.revoked_at IS NULL
      UNION ALL
      SELECT 'agent'::text, e.id, e.tenant_id, t.name, coalesce(nullif(e.display_name, ''), e.hostname),
             e.os::text, e.agent_version, e.last_seen_at,
             (t.agent_updates_paused OR coalesce((e.settings->>'autoUpdatePaused')::boolean, false))
        FROM endpoints e JOIN tenants t ON t.id = e.tenant_id
       WHERE e.status = 'active'
    ), v AS (
      SELECT m.*,
             CASE WHEN m.version ~ '^v?[0-9]+\\.[0-9]+\\.[0-9]+'
                  THEN (regexp_match(m.version, '^v?([0-9]+)\\.([0-9]+)\\.([0-9]+)'))::int[] END AS va
        FROM m
    ), s AS (
      SELECT v.*,
             CASE
               WHEN v.va IS NULL OR v.version LIKE '%-dev%' OR v.va >= ${targetSql} THEN 'updated'
               WHEN v.kind = 'agent' AND v.updates_paused THEN 'paused'
               WHEN v.last_seen_at IS NOT NULL AND v.last_seen_at > ${reachableSince} THEN 'pending'
               ELSE 'unreachable'
             END AS state
        FROM v
    )`;
  const grouped = await db.execute<{ kind: FleetMemberKind; state: FleetMemberState; n: string }>(
    sql`${members} SELECT kind, state, count(*) AS n FROM s GROUP BY kind, state`,
  );
  for (const row of grouped.rows) {
    const n = Number(row.n);
    const byKind = counts[row.kind];
    if (!byKind) {
      continue;
    }
    byKind[row.state] += n;
    byKind.total += n;
    counts.all[row.state] += n;
    counts.all.total += n;
  }
  const listed = await db.execute<{
    kind: FleetMemberKind;
    id: string;
    tenant_id: string;
    tenant_name: string;
    name: string;
    os: string | null;
    version: string | null;
    state: FleetMemberState;
    last_seen_at: Date | string | null;
  }>(sql`${members}
    SELECT kind, id, tenant_id, tenant_name, name, os, version, state, last_seen_at FROM s
     WHERE state <> 'updated'
     ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'unreachable' THEN 1 ELSE 2 END,
              tenant_name, name
     LIMIT ${FLEET_LIST_LIMIT + 1}`);
  const rows = listed.rows;
  return {
    targetVersion,
    counts,
    members: rows.slice(0, FLEET_LIST_LIMIT).map((r) => ({
      kind: r.kind,
      id: r.id,
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      name: r.name,
      os: r.os,
      version: r.version,
      state: r.state,
      lastSeenAt: r.last_seen_at === null ? null : new Date(r.last_seen_at).toISOString(),
    })),
    truncated: rows.length > FLEET_LIST_LIMIT,
    commands: MANUAL_UPDATE_COMMANDS,
  };
}

/** Whether the server now runs the release the pause was for. */
export function serverRunsPauseVersion(pause: JobStartPause, running: string | null): boolean {
  const norm = (v: string) => v.trim().replace(/^v/, "");
  return running !== null && norm(running) === norm(pause.version);
}

/**
 * Move the pause to the phase `fleet` (one api process wins): new starts stay paused while the
 * nodes and agents update, at most {@link FLEET_WINDOW_MS}. Returns the row, or null when the
 * pause was no longer `announced`.
 */
export async function enterFleetPhase(
  db: Database,
  pause: Pick<JobStartPause, "id">,
  now: Date,
): Promise<JobStartPause | null> {
  const [row] = await db
    .update(jobStartPause)
    .set({ phase: "fleet", ...fleetWindow(now), updatedAt: now })
    .where(and(eq(jobStartPause.id, pause.id), eq(jobStartPause.phase, "announced")))
    .returning();
  return row ?? null;
}

/** The deadline of the phase `fleet` from `now`, and when its row lifts itself. */
function fleetWindow(now: Date): { deadlineAt: Date; expiresAt: Date } {
  const deadlineAt = new Date(now.getTime() + FLEET_WINDOW_MS);
  // A minute of slack after the deadline: the pause is lifted by the step that sees it.
  return { deadlineAt, expiresAt: new Date(deadlineAt.getTime() + 60_000) };
}

/**
 * Start the phase `fleet` without an update before it (0.4.3, "Update nodes and agents now"):
 * the server already runs the release, but no pause led into the phase (an update by hand, or
 * one whose announcement was lost). New starts pause as after an update, at most
 * {@link FLEET_WINDOW_MS}, and the same step lifts the pause (service.ts, advancePause). Only
 * when no pause holds: an expired row is replaced, a live one is left alone. Returns the row, or
 * null when a pause holds already.
 */
export async function startFleetPhase(
  db: Database,
  input: { version: string; requestedBy: JobPauseRequester; now: Date },
): Promise<JobStartPause | null> {
  const { now } = input;
  return db.transaction(async (tx) => {
    await tx.delete(jobStartPause).where(lte(jobStartPause.expiresAt, now));
    const [row] = await tx
      .insert(jobStartPause)
      .values({
        mode: "interrupt",
        phase: "fleet",
        version: input.version,
        leadSeconds: 0,
        // No update request: the phase starts on its own (nothing is handed to the updater).
        request: { fleetOnly: true },
        requestedBy: input.requestedBy,
        ...fleetWindow(now),
        announcedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  });
}
