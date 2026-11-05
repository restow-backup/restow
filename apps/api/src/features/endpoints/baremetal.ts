import {
  agentVersionAtLeast,
  keyFilesOf,
  type LayoutManifest,
  type LayoutSummary,
  type LayoutUnsupported,
  layoutFingerprint,
  parseLayoutManifest,
  summarizeLayout,
  WHOLE_MACHINE_AGENT_VERSION,
} from "@restow/core";
import {
  type Database,
  type Endpoint,
  type EndpointRun,
  endpointLayouts,
  endpointRuns,
  endpoints,
} from "@restow/db";
import { and, desc, eq, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import { config } from "../../config.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { AgentContext } from "./agent-auth.js";
import type { FinishRunInput } from "./schemas.js";

/**
 * Bare metal on the server, milestone M1 (docs/BAREMETAL.md 4.3, 14.3): the layout manifests the
 * agent sends with a whole machine backup are checked and stored once per machine and content
 * (`endpoint_layouts`), the run points at its layout, and the machine's page reads the newest
 * layout's summary. Restore, the restore check and the boot probe come with later milestones.
 */

export type BaremetalState = "not_enabled" | "not_possible" | "no_layout" | "unverified";
export type BaremetalNotPossible = "container" | "windows" | "darwin_later" | "agent_too_old";

export interface BaremetalLatestDto {
  layoutId: string;
  runId: string;
  snapshotId: string | null;
  capturedAt: string;
  sha256: string;
  fingerprint: string;
  verdict: string;
  unsupported: LayoutUnsupported[];
  summary: LayoutSummary;
}

export interface SnapshotHintDto {
  vg: string;
  sizeBytes: number;
  freeBytes: number;
  suggestedFreeBytes: number;
  mounts: string[];
}

export interface BaremetalDto {
  /** Whole machine backups are switched on for this installation (RESTOW_BAREMETAL_PREVIEW). */
  preview: boolean;
  /** The machine's job backs it up as a whole. */
  enabled: boolean;
  state: BaremetalState;
  notPossible: BaremetalNotPossible | null;
  latest: BaremetalLatestDto | null;
  /** The machine's volume group has no room for snapshots (6.1): what to leave free. */
  snapshotHint: SnapshotHintDto | null;
}

export interface LayoutDto {
  id: string;
  sha256: string;
  createdAt: string;
  manifest: Record<string, unknown>;
}

const LAYOUT_REJECTED = "layout_rejected";

/**
 * Store the layout of a finished backup run and return its id, or null with the hint
 * `layout_rejected` added to `errors` when the manifest is refused. Kept only for a backup that
 * made a snapshot; the run's status stays as the agent reported it either way.
 */
export async function storeRunLayout(
  tx: Transaction,
  agent: AgentContext,
  run: Pick<EndpointRun, "id" | "kind">,
  input: Pick<FinishRunInput, "layout" | "snapshotId" | "status">,
  errors: { path?: string; message: string; code?: string }[],
): Promise<string | null> {
  if (input.layout === undefined || input.layout === null) {
    return null;
  }
  if (run.kind !== "backup" || input.snapshotId === undefined || input.status === "failed") {
    return null;
  }
  const parsed = parseLayoutManifest(input.layout);
  if (!parsed.ok) {
    errors.push({ code: LAYOUT_REJECTED, message: `layout refused: ${parsed.reason}` });
    return null;
  }
  if (parsed.manifest.platform !== "linux") {
    errors.push({
      code: LAYOUT_REJECTED,
      message: "layout refused: macOS layouts are kept from a later release",
    });
    return null;
  }
  const manifest = parsed.manifest;
  await tx
    .insert(endpointLayouts)
    .values({
      tenantId: agent.tenantId,
      endpointId: agent.endpointId,
      sha256: parsed.sha256,
      format: manifest.format,
      schemaVersion: manifest.schemaVersion,
      platform: manifest.platform,
      // The value as the agent sent it (unknown keys included), not the parsed one.
      manifest: JSON.parse(parsed.canonical) as Record<string, unknown>,
      summary: summarizeLayout(manifest) as unknown as Record<string, unknown>,
      verdict: manifest.verdict,
      layoutFingerprint: layoutFingerprint(manifest),
    })
    .onConflictDoNothing({ target: [endpointLayouts.endpointId, endpointLayouts.sha256] });
  const [row] = await tx
    .select({ id: endpointLayouts.id })
    .from(endpointLayouts)
    .where(
      and(
        eq(endpointLayouts.endpointId, agent.endpointId),
        eq(endpointLayouts.sha256, parsed.sha256),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

function loadEndpoint(
  tx: Transaction,
  tenantId: string,
  id: string,
): Promise<Endpoint | undefined> {
  return tx
    .select()
    .from(endpoints)
    .where(
      and(
        eq(endpoints.tenantId, tenantId),
        eq(endpoints.id, id),
        // A removed machine whose backups are still stored keeps its page (#65).
        or(
          isNull(endpoints.removedAt),
          sql`coalesce(${endpoints.removal}->>'state', '') <> 'done'`,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);
}

/** The newest run that recorded a layout, with the layout. */
async function latestLayoutRun(tx: Transaction, endpointId: string) {
  const [row] = await tx
    .select({
      runId: endpointRuns.id,
      snapshotId: endpointRuns.snapshotId,
      layout: endpointLayouts,
    })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(and(eq(endpointRuns.endpointId, endpointId), isNotNull(endpointRuns.layoutId)))
    .orderBy(desc(endpointRuns.startedAt))
    .limit(1);
  return row ?? null;
}

function notPossibleOf(endpoint: Endpoint, enabled: boolean): BaremetalNotPossible | null {
  if (endpoint.os === "windows") return "windows";
  if (endpoint.os === "darwin") return "darwin_later";
  if (endpoint.settings.agent?.machine?.virtualization === "container") return "container";
  if (enabled && !agentVersionAtLeast(endpoint.agentVersion, WHOLE_MACHINE_AGENT_VERSION)) {
    return "agent_too_old";
  }
  return null;
}

/**
 * The volume group whose missing free space kept sources of the backup from a snapshot
 * (`backup.liveReasons` = `vg_no_space`), with the room to leave: 10 % of the group.
 */
export function snapshotHintOf(manifest: LayoutManifest): SnapshotHintDto | null {
  if (manifest.platform !== "linux") {
    return null;
  }
  const sources = Object.entries(manifest.backup.liveReasons)
    .filter(([, reason]) => reason === "vg_no_space")
    .map(([source]) => source);
  if (sources.length === 0) {
    return null;
  }
  const fsOfMount = new Map(manifest.mounts.map((mount) => [mount.target, mount.fs]));
  const vgOfFs = new Map<string, string>();
  for (const fs of manifest.filesystems) {
    const lv = fs.devices.find((device) => device.kind === "lv");
    if (lv && lv.kind === "lv") vgOfFs.set(fs.id, lv.vg);
  }
  const byVg = new Map<string, string[]>();
  for (const source of sources) {
    const fs = fsOfMount.get(source);
    const vg = fs ? vgOfFs.get(fs) : undefined;
    if (vg) byVg.set(vg, [...(byVg.get(vg) ?? []), source]);
  }
  const [first] = [...byVg.entries()];
  const group = first ? manifest.lvm.vgs.find((vg) => vg.name === first[0]) : undefined;
  if (!first || !group) {
    return null;
  }
  return {
    vg: group.name,
    sizeBytes: group.sizeBytes,
    freeBytes: group.freeBytes,
    suggestedFreeBytes: Math.ceil(group.sizeBytes / 10),
    mounts: [...first[1]].sort(),
  };
}

/** The bare metal card of a machine's page (restore role and up). */
export async function getBaremetalState(
  database: Database,
  tenantId: string,
  endpointId: string,
): Promise<BaremetalDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, endpointId);
    if (!endpoint) {
      throw new ProblemError(404, "Endpoint not found");
    }
    const enabled = endpoint.config.wholeMachine === true;
    const notPossible = notPossibleOf(endpoint, enabled);
    const latestRow = await latestLayoutRun(tx, endpointId);
    let latest: BaremetalLatestDto | null = null;
    let snapshotHint: SnapshotHintDto | null = null;
    if (latestRow) {
      const parsed = parseLayoutManifest(latestRow.layout.manifest);
      const manifest = parsed.ok ? parsed.manifest : null;
      latest = {
        layoutId: latestRow.layout.id,
        runId: latestRow.runId,
        snapshotId: latestRow.snapshotId,
        capturedAt:
          manifest?.capturedAt ?? latestRow.layout.createdAt.toISOString().replace(/\.\d+Z$/, "Z"),
        sha256: latestRow.layout.sha256,
        fingerprint: latestRow.layout.layoutFingerprint,
        verdict: latestRow.layout.verdict,
        unsupported: manifest?.platform === "linux" ? manifest.unsupported : [],
        summary: latestRow.layout.summary as unknown as LayoutSummary,
      };
      snapshotHint = manifest ? snapshotHintOf(manifest) : null;
    }
    const state: BaremetalState = notPossible
      ? "not_possible"
      : latest
        ? "unverified"
        : enabled
          ? "no_layout"
          : "not_enabled";
    return {
      preview: config.baremetalPreview,
      enabled,
      state,
      notPossible,
      latest,
      snapshotHint,
    };
  });
}

/** One stored layout with its full manifest (serial numbers, admins only). */
export async function getLayout(
  database: Database,
  tenantId: string,
  endpointId: string,
  layoutId: string,
): Promise<LayoutDto> {
  return withTenantTx(database, tenantId, async (tx) => {
    const endpoint = await loadEndpoint(tx, tenantId, endpointId);
    const [layout] = endpoint
      ? await tx
          .select()
          .from(endpointLayouts)
          .where(and(eq(endpointLayouts.endpointId, endpointId), eq(endpointLayouts.id, layoutId)))
          .limit(1)
      : [];
    if (!layout) {
      throw new ProblemError(404, "Layout not found");
    }
    return {
      id: layout.id,
      sha256: layout.sha256,
      createdAt: layout.createdAt.toISOString(),
      manifest: layout.manifest,
    };
  });
}

/**
 * The LUKS key files a snapshot may hold (docs/BAREMETAL.md 5.4): those of the layout its run
 * recorded and of the machine's newest layout, so a key file is locked in every snapshot once any
 * layout names it. Empty for a machine without layouts.
 */
export async function keyFilesForSnapshot(
  tx: Transaction,
  endpointId: string,
  snapshotId: string,
): Promise<string[]> {
  const snapshot = snapshotId.toLowerCase();
  const ofSnapshot = await tx
    .select({ manifest: endpointLayouts.manifest })
    .from(endpointRuns)
    .innerJoin(endpointLayouts, eq(endpointLayouts.id, endpointRuns.layoutId))
    .where(
      and(
        eq(endpointRuns.endpointId, endpointId),
        snapshot.length >= 64
          ? eq(endpointRuns.snapshotId, snapshot)
          : like(endpointRuns.snapshotId, `${snapshot}%`),
      ),
    )
    .limit(4);
  const newest = await tx
    .select({ manifest: endpointLayouts.manifest })
    .from(endpointLayouts)
    .where(eq(endpointLayouts.endpointId, endpointId))
    .orderBy(desc(endpointLayouts.createdAt))
    .limit(1);
  const files = new Set<string>();
  for (const { manifest } of [...ofSnapshot, ...newest]) {
    const parsed = parseLayoutManifest(manifest);
    if (parsed.ok) {
      for (const file of keyFilesOf(parsed.manifest)) files.add(file);
    }
  }
  return [...files].sort();
}

/** Run {@link keyFilesForSnapshot} in its own tenant transaction. */
export function loadKeyFiles(
  database: Database,
  tenantId: string,
  endpointId: string,
  snapshotId: string,
): Promise<string[]> {
  return withTenantTx(database, tenantId, (tx) => keyFilesForSnapshot(tx, endpointId, snapshotId));
}
