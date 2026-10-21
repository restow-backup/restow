import { randomUUID } from "node:crypto";
import {
  type BlockMap,
  blockCount,
  blockLength,
  buildBlockMap,
  buildPveManifest,
  type ChunkWriterStats,
  decodeFrame,
  encodeBlockMap,
  encodeHashList,
  encodeRestoreBlock,
  generateAgentSecret,
  hashListDigest,
  IncompleteDiskError,
  manifestKey,
  mapChunkIds,
  mapStats,
  type PveDiskObject,
  PveFormatError,
  parseActivityReport,
  parseArchiveName,
  type StagedBlock,
  sealManifest,
  sha256Hex,
  writeToAllTargets,
} from "@restow/core";
import {
  type PveRun,
  type PveRunProgress,
  type PveSnapshot,
  type PveSnapshotDisk,
  type PveTask,
  pveGuests,
  pveRunBlocks,
  pveRuns,
  pveSnapshots,
  pveTasks,
} from "@restow/db";
import { and, desc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { auditPve, nodeActor, PVE_AUDIT_ACTIONS } from "./audit.js";
import { recordBootTestResult } from "./boot-tests.js";
import type { NodeContext } from "./node-auth.js";
import { checkArchiveName, guestForBackup } from "./node-service.js";
import { ensureGuestRepository, guestRepositoryPrefix } from "./repository.js";
import {
  newChunkReader,
  newChunkWriter,
  readBlockMap,
  type TenantChunkStore,
  tenantChunkStore,
} from "./store.js";

/**
 * Backup and restore runs of VMs and containers (docs/PROXMOX.md 2.3 to 2.6,
 * docs/PVE-PROTOCOL.md). A node may only open runs for guests of its own
 * cluster, append blocks to its own open runs, commit once, and read the
 * restore points of its own cluster. Nothing here deletes or overwrites a
 * committed restore point.
 */

export const PVE_RUN_PROBLEM = "urn:restow:problem:pve-run";
export { guestRepositoryPrefix, PVE_REPOSITORY_SECRET_KIND } from "./repository.js";

const RESTIC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How often a node reports the progress of a backup (#51). The open run tells
 * the node, so an older server (no such field) gets no reports at all.
 */
export const PROGRESS_INTERVAL_SECONDS = 5;
const LOCATE_BATCH = 1000;

function problem(
  status: 400 | 404 | 409 | 422 | 500 | 503,
  title: string,
  detail: string,
): ProblemError {
  return new ProblemError(status, title, { type: PVE_RUN_PROBLEM, detail });
}

async function loadRun(tx: Transaction, node: NodeContext, runId: string): Promise<PveRun> {
  const [run] = await tx
    .select()
    .from(pveRuns)
    .where(and(eq(pveRuns.id, runId), eq(pveRuns.clusterId, node.clusterId)))
    .limit(1);
  if (!run) {
    throw problem(404, "Run not found", "No run with this id in this node's cluster.");
  }
  return run;
}

function requireOpenBackup(run: PveRun): void {
  if (run.kind !== "backup") {
    throw problem(409, "Not a backup run", "This run is not a backup.");
  }
  if (run.status !== "running") {
    throw problem(409, "Run closed", "This run has ended; open a new one.");
  }
}

// ---------------------------------------------------------------------------
// Opening a run
// ---------------------------------------------------------------------------

export async function openRun(
  node: NodeContext,
  input: {
    vmid: number;
    kind: "vm" | "ct";
    archiveName: string;
    storageId: string;
    startedAt: string;
  },
  now: Date = new Date(),
): Promise<{
  runId: string;
  guestId: string;
  origin: "restow" | "pve";
  progressIntervalSeconds: number;
}> {
  const archiveName = checkArchiveName(input.archiveName, input.vmid, input.kind);
  const guest = await guestForBackup(node, input.vmid, input.kind);
  if (guest.kind !== input.kind) {
    throw problem(
      409,
      "Guest kind changed",
      `Guest ${input.vmid} is known as ${guest.kind}, not ${input.kind}.`,
    );
  }
  return withTenantTx(db, node.tenantId, async (tx) => {
    // A backup this node was asked for is the task's run; any other was started in PVE.
    const [task] = await tx
      .select()
      .from(pveTasks)
      .where(
        and(
          eq(pveTasks.nodeId, node.nodeId),
          eq(pveTasks.guestId, guest.id),
          eq(pveTasks.kind, "backup"),
          eq(pveTasks.status, "delivered"),
        ),
      )
      .orderBy(desc(pveTasks.deliveredAt))
      .limit(1);
    const startedAt = Number.isNaN(Date.parse(input.startedAt)) ? now : new Date(input.startedAt);
    const [run] = await tx
      .insert(pveRuns)
      .values({
        tenantId: node.tenantId,
        clusterId: node.clusterId,
        nodeId: node.nodeId,
        guestId: guest.id,
        kind: "backup",
        origin: task ? "restow" : "pve",
        archiveName,
        storageId: input.storageId,
        taskId: task?.id ?? null,
        startedAt,
      })
      .returning();
    if (!run) {
      throw new Error("run insert returned no row");
    }
    return {
      runId: run.id,
      guestId: guest.id,
      origin: run.origin,
      progressIntervalSeconds: PROGRESS_INTERVAL_SECONDS,
    };
  });
}

// ---------------------------------------------------------------------------
// Incremental query
// ---------------------------------------------------------------------------

/** The newest active VM restore point of a guest. */
async function latestSnapshot(tx: Transaction, guestId: string): Promise<PveSnapshot | null> {
  const [snap] = await tx
    .select()
    .from(pveSnapshots)
    .where(and(eq(pveSnapshots.guestId, guestId), eq(pveSnapshots.status, "active")))
    .orderBy(desc(pveSnapshots.sequence))
    .limit(1);
  return snap ?? null;
}

/**
 * For each disk: "use" when the newest restore point of the guest holds the
 * disk with the same size and was written through the same PVE storage id
 * (the bitmap is per storage id), else "new". The base for skipping unchanged
 * blocks is that restore point whenever the size matches; it is recorded on
 * the run, and the commit builds on exactly it.
 */
export async function queryIncremental(
  node: NodeContext,
  runId: string,
  devices: { device: string; size: number }[],
) {
  return withTenantTx(db, node.tenantId, async (tx) => {
    const run = await loadRun(tx, node, runId);
    requireOpenBackup(run);
    const latest = await latestSnapshot(tx, run.guestId);
    const recorded: PveRun["devices"] = {};
    const out = devices.map(({ device, size }) => {
      const disk =
        latest?.kind === "vm" ? latest.disks.find((d) => d.device === device) : undefined;
      const sameSize = disk !== undefined && disk.size === size;
      const base = sameSize && latest ? latest.id : null;
      recorded[device] = { size, baseSnapshotId: base };
      return {
        device,
        mode: sameSize && latest?.storageId === run.storageId ? "use" : "new",
        baseSnapshotId: base ?? "",
        hashesDigest: sameSize && disk ? disk.hashesDigest : "",
      };
    });
    await tx.update(pveRuns).set({ devices: recorded }).where(eq(pveRuns.id, run.id));
    return { devices: out };
  });
}

// ---------------------------------------------------------------------------
// Block ingest
// ---------------------------------------------------------------------------

/** The largest frame a node may send: 16 blocks of 4 MiB plus headers. */
export const MAX_FRAME_BYTES = 16 * (4 * 1024 * 1024 + 128) + 16;

/**
 * Store one frame of blocks: every data block's SHA-256 is checked against
 * the node's claim, chunked, encrypted and packed with the tenant key, and
 * staged with its chunk ids. Staged chunks hold a reference until the commit
 * (or the end of a failed run) releases it. A block sent again replaces the
 * earlier one (retries are idempotent).
 */
export async function putBlocks(
  node: NodeContext,
  runId: string,
  body: Buffer,
): Promise<{ accepted: number }> {
  let blocks: ReturnType<typeof decodeFrame>;
  try {
    blocks = decodeFrame(body);
  } catch (error) {
    throw problem(
      400,
      "Malformed block frame",
      error instanceof PveFormatError ? error.message : "unreadable frame",
    );
  }
  const run = await withTenantTx(db, node.tenantId, (tx) => loadRun(tx, node, runId));
  requireOpenBackup(run);
  for (const b of blocks) {
    const device = run.devices[b.device];
    if (!device) {
      throw problem(
        409,
        "Unknown disk",
        `${b.device} was not part of the incremental query of this run.`,
      );
    }
    if (b.index >= blockCount(device.size) || b.length !== blockLength(device.size, b.index)) {
      throw problem(
        422,
        "Block outside the disk",
        `${b.device}: block ${b.index} does not fit a disk of ${device.size} bytes.`,
      );
    }
    if (!b.zero && sha256Hex(b.data as Buffer) !== b.sha256) {
      throw problem(
        422,
        "Block hash mismatch",
        `${b.device}: block ${b.index} does not match its SHA-256.`,
      );
    }
  }
  const store = await tenantChunkStore(node.tenantId);
  const writer = newChunkWriter(store);
  const staged: {
    device: string;
    index: number;
    zero: boolean;
    length: number;
    sha256: string;
    chunks: string[];
  }[] = [];
  for (const b of blocks) {
    if (b.zero) {
      staged.push({
        device: b.device,
        index: b.index,
        zero: true,
        length: b.length,
        sha256: "0".repeat(64),
        chunks: [],
      });
      continue;
    }
    const written = await writer.write(b.data as Buffer);
    staged.push({
      device: b.device,
      index: b.index,
      zero: false,
      length: b.length,
      sha256: b.sha256,
      chunks: written.chunks,
    });
  }
  await writer.close();
  await store.index.addReferences(staged.flatMap((s) => s.chunks));
  const chunkStats = writer.stats;
  const replaced = await withTenantTx(db, node.tenantId, async (tx) => {
    // What the frame added to the chunk store, summed over the run for the compression and
    // deduplication signals (docs/RANSOMWARE.md). A frame sent again counts twice; the ratios
    // barely move.
    await tx
      .update(pveRuns)
      .set({ stats: addRunChunkStats(chunkStats) })
      .where(eq(pveRuns.id, run.id));
    const old = await tx
      .select({
        device: pveRunBlocks.device,
        index: pveRunBlocks.blockIndex,
        chunks: pveRunBlocks.chunks,
      })
      .from(pveRunBlocks)
      .where(
        and(
          eq(pveRunBlocks.runId, run.id),
          sql`(${pveRunBlocks.device}, ${pveRunBlocks.blockIndex}) IN (${sql.join(
            staged.map((s) => sql`(${s.device}, ${s.index})`),
            sql`, `,
          )})`,
        ),
      );
    for (const s of staged) {
      await tx
        .insert(pveRunBlocks)
        .values({
          tenantId: node.tenantId,
          runId: run.id,
          device: s.device,
          blockIndex: s.index,
          zero: s.zero,
          length: s.length,
          sha256: s.sha256,
          chunks: s.chunks,
        })
        .onConflictDoUpdate({
          target: [pveRunBlocks.runId, pveRunBlocks.device, pveRunBlocks.blockIndex],
          set: { zero: s.zero, length: s.length, sha256: s.sha256, chunks: s.chunks },
        });
    }
    return old.flatMap((o) => o.chunks);
  });
  if (replaced.length > 0) {
    await store.index.releaseReferences(replaced);
  }
  return { accepted: blocks.length };
}

/** The run's `stats` with a frame's chunk writer statistics added (one atomic UPDATE). */
function addRunChunkStats(stats: ChunkWriterStats): SQL {
  const add = (key: string, value: number) =>
    sql`jsonb_build_object(${key}::text, COALESCE((${pveRuns.stats}->>${key}::text)::numeric, 0) + ${value})`;
  return sql`${pveRuns.stats} || ${add("chunkBytesIn", stats.bytesIn)} || ${add("chunkBytesNew", stats.bytesNew)} || ${add("chunkBytesSampled", stats.bytesSampled)} || ${add("chunkBytesSampledCompressed", stats.bytesSampledCompressed)}`;
}

/** Release what a run staged (its block references) and drop the rows. */
export async function releaseStaging(tenantId: string, runId: string): Promise<void> {
  const rows = await withTenantTx(db, tenantId, (tx) =>
    tx
      .select({ chunks: pveRunBlocks.chunks })
      .from(pveRunBlocks)
      .where(eq(pveRunBlocks.runId, runId)),
  );
  const ids = rows.flatMap((r) => r.chunks);
  if (ids.length > 0) {
    const store = await tenantChunkStore(tenantId);
    await store.index.releaseReferences(ids);
  }
  await withTenantTx(db, tenantId, (tx) =>
    tx.delete(pveRunBlocks).where(eq(pveRunBlocks.runId, runId)),
  );
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitInput {
  commitId: string;
  devices?: {
    device: string;
    size: number;
    bitmapMode: string;
    readBytes: number;
    uploadedBytes: number;
    changedBlocks: number;
    zeroBlocks: number;
    hashSkipped: number;
  }[];
  guestConfig: string;
  firewallConfig: string | null;
  resticSnapshotId?: string;
  resticBytesAdded?: number;
  resticBytesAddedPacked?: number;
  resticFilesNew?: number;
  resticFilesChanged?: number;
  resticFilesTotal?: number;
  activity?: unknown;
  resticTotalBytes?: number;
  resticRoot?: string;
  pveVersion?: string;
  resticUnreadable?: number;
  resticUnreadablePaths?: string[];
  consistency?: string;
}

/**
 * A container backup's file counts and activity report, as far as the node sent them (nodes from
 * 0.4.0 on), for the ransomware judgement; the report checked and bounded.
 */
export function containerActivityStats(input: {
  resticFilesNew?: number;
  resticFilesChanged?: number;
  resticFilesTotal?: number;
  resticBytesAddedPacked?: number;
  resticTotalBytes?: number;
  activity?: unknown;
}): Record<string, unknown> {
  const report = parseActivityReport(input.activity);
  return {
    // Compression (packed / added) and deduplication (added / processed) of the new data.
    ...(input.resticBytesAddedPacked !== undefined
      ? { resticBytesAddedPacked: input.resticBytesAddedPacked }
      : {}),
    ...(input.resticTotalBytes !== undefined ? { resticTotalBytes: input.resticTotalBytes } : {}),
    ...(input.resticFilesNew !== undefined ? { resticFilesNew: input.resticFilesNew } : {}),
    ...(input.resticFilesChanged !== undefined
      ? { resticFilesChanged: input.resticFilesChanged }
      : {}),
    ...(input.resticFilesTotal !== undefined ? { resticFilesTotal: input.resticFilesTotal } : {}),
    ...(report ? { activity: { ...report } } : {}),
  };
}

interface WrittenObject {
  chunks: string[];
  size: number;
  sha256: string;
}

const committing = new Set<string>();

/**
 * Seal the restore point: build the full block map of every disk (base map
 * plus the staged blocks), store the maps and the configuration in the chunk
 * store, write the sealed manifest, take one reference per distinct chunk
 * the restore point needs and only then release the staged references.
 * Idempotent by `commitId`: a repeated commit answers with the restore point
 * it already made.
 */
export async function commitRun(
  node: NodeContext,
  runId: string,
  input: CommitInput,
  now: Date = new Date(),
) {
  const first = await withTenantTx(db, node.tenantId, (tx) => loadRun(tx, node, runId));
  if (first.snapshotId) {
    if (first.commitId === input.commitId) {
      return alreadyCommitted(node.tenantId, first.snapshotId);
    }
    throw problem(
      409,
      "Run already committed",
      "This run committed a restore point with another commit id.",
    );
  }
  requireOpenBackup(first);
  if (committing.has(runId)) {
    throw problem(503, "Commit in progress", "This run is being committed; ask again shortly.");
  }
  committing.add(runId);
  try {
    return await commitOnce(node, first, input, now);
  } finally {
    committing.delete(runId);
  }
}

async function alreadyCommitted(tenantId: string, snapshotId: string) {
  const [snap] = await withTenantTx(db, tenantId, (tx) =>
    tx.select().from(pveSnapshots).where(eq(pveSnapshots.id, snapshotId)).limit(1),
  );
  return {
    snapshotId,
    alreadyCommitted: true,
    hashesDigests: Object.fromEntries((snap?.disks ?? []).map((d) => [d.device, d.hashesDigest])),
  };
}

async function writeSmall(store: TenantChunkStore, data: Buffer): Promise<WrittenObject> {
  const writer = newChunkWriter(store);
  const written = await writer.write(data);
  await writer.close();
  return { chunks: written.chunks, size: written.size, sha256: written.sha256 };
}

async function locatePacks(store: TenantChunkStore, ids: string[]): Promise<string[]> {
  const packs = new Set<string>();
  for (let i = 0; i < ids.length; i += LOCATE_BATCH) {
    const batch = ids.slice(i, i + LOCATE_BATCH);
    const located = await store.index.locate(batch);
    for (const id of batch) {
      const loc = located.get(id);
      if (!loc) {
        throw new Error(`refusing to commit: chunk ${id} is not locatable`);
      }
      packs.add(loc.packPath);
    }
  }
  return [...packs].sort();
}

async function commitOnce(node: NodeContext, run: PveRun, input: CommitInput, now: Date) {
  const store = await tenantChunkStore(node.tenantId);
  const guest = (
    await withTenantTx(db, node.tenantId, (tx) =>
      tx.select().from(pveGuests).where(eq(pveGuests.id, run.guestId)).limit(1),
    )
  )[0];
  if (!guest) {
    throw problem(404, "Guest not found", "The guest of this run is gone.");
  }
  const kind = guest.kind;
  const parsed = parseArchiveName(run.archiveName ?? "");
  if (!parsed) {
    throw problem(409, "Run without archive name", "The run has no valid archive name.");
  }
  if (kind === "ct" && !input.resticSnapshotId) {
    throw problem(422, "Restic snapshot missing", "A container commit names its restic snapshot.");
  }
  const disks: PveSnapshotDisk[] = [];
  const diskObjects: PveDiskObject[] = [];
  const refIds: string[] = [];
  const bitmapModes: Record<string, string> = {};
  let byteSize = 0;
  let baseSnapshotId: string | null = null;
  if (kind === "vm") {
    const reported = input.devices ?? [];
    if (reported.length === 0) {
      throw problem(422, "No disks", "A VM commit lists its disks.");
    }
    for (const d of reported) {
      const recorded = run.devices[d.device];
      if (!recorded || recorded.size !== d.size) {
        throw problem(
          409,
          "Disk not queried",
          `${d.device} was not part of the incremental query with this size.`,
        );
      }
      let base: BlockMap | null = null;
      if (recorded.baseSnapshotId) {
        baseSnapshotId = recorded.baseSnapshotId;
        const [baseSnap] = await withTenantTx(db, node.tenantId, (tx) =>
          tx
            .select()
            .from(pveSnapshots)
            .where(eq(pveSnapshots.id, recorded.baseSnapshotId as string))
            .limit(1),
        );
        const baseDisk = baseSnap?.disks.find((x) => x.device === d.device);
        if (baseSnap?.status !== "active" || !baseDisk) {
          throw problem(
            409,
            "Base restore point gone",
            `${d.device}: the base restore point was removed meanwhile; back up again.`,
          );
        }
        base = await readBlockMap(store, baseDisk.map.chunks);
      }
      const staged = await withTenantTx(db, node.tenantId, (tx) =>
        tx
          .select()
          .from(pveRunBlocks)
          .where(and(eq(pveRunBlocks.runId, run.id), eq(pveRunBlocks.device, d.device))),
      );
      let map: BlockMap;
      try {
        map = buildBlockMap(
          d.device,
          d.size,
          base,
          staged.map(
            (s): StagedBlock => ({
              index: s.blockIndex,
              zero: s.zero,
              sha256: s.sha256,
              chunks: s.chunks,
              length: s.length,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof IncompleteDiskError) {
          throw problem(409, "Disk incomplete", error.message);
        }
        throw error;
      }
      const mapObject = await writeSmall(store, encodeBlockMap(map));
      const stats = mapStats(map);
      const digest = hashListDigest(map);
      disks.push({
        device: d.device,
        size: d.size,
        map: mapObject,
        hashesDigest: digest,
        changedBlocks: d.changedBlocks,
        zeroBlocks: stats.zeroBlocks,
        dataBlocks: stats.dataBlocks,
        bitmapMode: d.bitmapMode,
      });
      diskObjects.push({
        device: d.device,
        diskSize: d.size,
        map: mapObject,
        changedBlocks: d.changedBlocks,
        zeroBlocks: stats.zeroBlocks,
        bitmapMode: d.bitmapMode,
      });
      refIds.push(...mapChunkIds(map), ...mapObject.chunks);
      bitmapModes[d.device] = d.bitmapMode;
      byteSize += d.size;
    }
  } else {
    byteSize = input.resticTotalBytes ?? 0;
  }
  const config = await writeSmall(store, Buffer.from(input.guestConfig ?? "", "utf8"));
  const firewall =
    input.firewallConfig != null
      ? await writeSmall(store, Buffer.from(input.firewallConfig, "utf8"))
      : null;
  refIds.push(...config.chunks, ...(firewall?.chunks ?? []));
  const unique = [...new Set(refIds)];

  const snapshotId = randomUUID();
  const sequence = await withTenantTx(db, node.tenantId, async (tx) => {
    const [row] = await tx
      .select({ max: sql<number | null>`max(${pveSnapshots.sequence})` })
      .from(pveSnapshots)
      .where(eq(pveSnapshots.guestId, guest.id));
    return Number(row?.max ?? 0) + 1;
  });
  // References first: from here on garbage collection keeps every chunk this
  // restore point needs, whatever happens to the staged references.
  await store.index.addReferences(unique);
  try {
    const packs = await locatePacks(store, unique);
    const manifest = buildPveManifest({
      tenantId: node.tenantId,
      snapshotId,
      guestId: guest.id,
      createdAt: parsed.time,
      sequence,
      state: {
        kind: kind === "vm" ? "pve-vm" : "pve-ct",
        clusterId: node.clusterId,
        vmid: guest.vmid,
        node: node.name,
        archiveName: parsed.archiveName,
        storageId: run.storageId ?? node.storageId,
        pveVersion: input.pveVersion,
        baseSnapshotId,
        bitmapModes,
        ...(kind === "ct"
          ? {
              resticSnapshotId: input.resticSnapshotId,
              resticRoot: input.resticRoot,
              resticPrefix: guestRepositoryPrefix(guest.id),
            }
          : {}),
      },
      config,
      firewall,
      disks: diskObjects,
      packs,
    });
    const path = manifestKey(node.tenantId, snapshotId);
    await writeToAllTargets(
      store.write,
      path,
      await sealManifest(manifest, store.keys.current, path),
    );
    const stats = {
      readBytes: (input.devices ?? []).reduce((s, d) => s + d.readBytes, 0),
      uploadedBytes: (input.devices ?? []).reduce((s, d) => s + d.uploadedBytes, 0),
      changedBlocks: (input.devices ?? []).reduce((s, d) => s + d.changedBlocks, 0),
      zeroBlocks: (input.devices ?? []).reduce((s, d) => s + d.zeroBlocks, 0),
      hashSkipped: (input.devices ?? []).reduce((s, d) => s + d.hashSkipped, 0),
      ...(kind === "ct" ? { resticBytesAdded: input.resticBytesAdded ?? 0 } : {}),
      // What the container backup changed, for the ransomware judgement (apps/worker suspicion).
      ...(kind === "ct" ? containerActivityStats(input) : {}),
      // An incomplete container snapshot (restic exit 3) says what it misses.
      ...(kind === "ct" && input.resticUnreadable
        ? {
            resticUnreadable: input.resticUnreadable,
            consistency: input.consistency ?? null,
            ...(input.resticUnreadablePaths?.length
              ? { unreadablePaths: input.resticUnreadablePaths }
              : {}),
          }
        : {}),
    };
    await withTenantTx(db, node.tenantId, async (tx) => {
      await tx.insert(pveSnapshots).values({
        id: snapshotId,
        tenantId: node.tenantId,
        clusterId: node.clusterId,
        guestId: guest.id,
        runId: run.id,
        sequence,
        kind,
        archiveName: parsed.archiveName,
        storageId: run.storageId ?? node.storageId,
        origin: run.origin,
        manifestPath: path,
        guestConfig: input.guestConfig ?? "",
        firewallConfig: input.firewallConfig ?? null,
        disks,
        resticSnapshotId: input.resticSnapshotId ?? null,
        resticRoot: input.resticRoot ?? null,
        byteSize,
        stats,
        chunkRefs: unique.length,
        baseSnapshotId,
        backupAt: parsed.time,
      });
      await tx
        .update(pveRuns)
        .set({ snapshotId, commitId: input.commitId, stats: { ...run.stats, ...stats } })
        .where(eq(pveRuns.id, run.id));
      const diskState = { ...guest.diskState };
      for (const d of disks) {
        diskState[d.device] = {
          size: d.size,
          lastSnapshotId: snapshotId,
          bitmapMode: d.bitmapMode,
          readBytes: input.devices?.find((x) => x.device === d.device)?.readBytes ?? 0,
          at: now.toISOString(),
        };
      }
      await tx
        .update(pveGuests)
        .set({ lastSnapshotId: snapshotId, lastSuccessAt: now, lastBackupAt: now, diskState })
        .where(eq(pveGuests.id, guest.id));
      await auditPve(tx, {
        tenantId: node.tenantId,
        actor: nodeActor(node.name, node.ip),
        action: PVE_AUDIT_ACTIONS.snapshotCommitted,
        target: snapshotId,
        targetType: "pve_snapshot",
        details: { vmid: guest.vmid, kind, archiveName: parsed.archiveName, sequence, ...stats },
      });
    });
  } catch (error) {
    await store.index.releaseReferences(unique).catch(() => undefined);
    throw error;
  }
  await releaseStaging(node.tenantId, run.id);
  return {
    snapshotId,
    alreadyCommitted: false,
    hashesDigests: Object.fromEntries(disks.map((d) => [d.device, d.hashesDigest])),
  };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** Reports closer together than this are dropped, whatever the node sends. */
export const PROGRESS_MIN_GAP_MS = 2_000;
const lastProgressAt = new Map<string, number>();

export interface ProgressInput {
  bytesDone: number;
  bytesTotal?: number | null | undefined;
  bytesUploaded?: number | null | undefined;
}

/**
 * The progress a report makes of the previous one: the throughput is what was
 * read between the two reports, smoothed with the previous figure so a single
 * slow interval does not make the number jump.
 */
export function nextProgress(
  previous: PveRunProgress | null,
  input: ProgressInput,
  now: Date,
): PveRunProgress {
  let bytesPerSecond: number | null = previous?.bytesPerSecond ?? null;
  if (previous) {
    const seconds = (now.getTime() - Date.parse(previous.at)) / 1000;
    const delta = input.bytesDone - previous.bytesDone;
    if (Number.isFinite(seconds) && seconds > 0 && delta >= 0) {
      const current = delta / seconds;
      bytesPerSecond = Math.round(
        previous.bytesPerSecond === null ? current : (previous.bytesPerSecond + current) / 2,
      );
    }
  }
  const total = input.bytesTotal ?? null;
  return {
    bytesDone: input.bytesDone,
    // A total below what was read is an estimate that fell short: unknown, not over 100 %.
    bytesTotal: total !== null && total > 0 && total >= input.bytesDone ? total : null,
    bytesUploaded: input.bytesUploaded ?? null,
    bytesPerSecond,
    at: now.toISOString(),
  };
}

/**
 * Keep how far a running backup is. Reports closer than
 * {@link PROGRESS_MIN_GAP_MS} are taken but not written, so a node cannot
 * turn progress into a write load. `clusterId` scopes a node's report to its
 * cluster; a container backup's run credential names the run itself.
 */
export async function reportProgress(
  tenantId: string,
  clusterId: string | null,
  runId: string,
  input: ProgressInput,
  now: Date = new Date(),
): Promise<{ stored: boolean }> {
  const last = lastProgressAt.get(runId);
  if (last !== undefined && now.getTime() - last < PROGRESS_MIN_GAP_MS) {
    return { stored: false };
  }
  lastProgressAt.set(runId, now.getTime());
  if (lastProgressAt.size > 10_000) {
    lastProgressAt.clear();
  }
  return withTenantTx(db, tenantId, async (tx) => {
    const [run] = await tx
      .select({
        id: pveRuns.id,
        kind: pveRuns.kind,
        status: pveRuns.status,
        progress: pveRuns.progress,
      })
      .from(pveRuns)
      .where(
        clusterId
          ? and(eq(pveRuns.id, runId), eq(pveRuns.clusterId, clusterId))
          : eq(pveRuns.id, runId),
      )
      .limit(1);
    if (!run) {
      throw problem(404, "Run not found", "No run with this id in this node's cluster.");
    }
    if (run.kind !== "backup" || run.status !== "running") {
      throw problem(409, "Run closed", "This run has ended; it takes no progress.");
    }
    await tx
      .update(pveRuns)
      .set({ progress: nextProgress(run.progress, input, now) })
      .where(eq(pveRuns.id, run.id));
    return { stored: true };
  });
}

// ---------------------------------------------------------------------------
// End of a run
// ---------------------------------------------------------------------------

export async function finishRun(
  node: NodeContext,
  runId: string,
  input: { status: "succeeded" | "failed"; error?: string; stats?: Record<string, unknown> },
  now: Date = new Date(),
): Promise<void> {
  const run = await withTenantTx(db, node.tenantId, (tx) => loadRun(tx, node, runId));
  if (run.status !== "running") {
    return;
  }
  const status = input.status === "succeeded" && run.snapshotId ? "succeeded" : "failed";
  const message =
    status === "failed"
      ? (input.error ?? "").slice(0, 2000) ||
        (run.snapshotId ? "" : "The backup ended without a restore point.")
      : null;
  if (!run.snapshotId) {
    await releaseStaging(node.tenantId, run.id);
  }
  await withTenantTx(db, node.tenantId, async (tx) => {
    await tx
      .update(pveRuns)
      .set({
        status,
        finishedAt: now,
        errorMessage: message,
        stats: { ...run.stats, ...(input.stats ?? {}) },
      })
      .where(eq(pveRuns.id, run.id));
    await tx.update(pveGuests).set({ lastBackupAt: now }).where(eq(pveGuests.id, run.guestId));
    if (run.taskId) {
      await tx
        .update(pveTasks)
        .set({
          status: status === "succeeded" ? "done" : "failed",
          finishedAt: now,
          errorMessage: message,
        })
        .where(
          and(eq(pveTasks.id, run.taskId), inArray(pveTasks.status, ["pending", "delivered"])),
        );
    }
  });
}

export async function runLog(node: NodeContext, runId: string, log: string): Promise<void> {
  await withTenantTx(db, node.tenantId, async (tx) => {
    await loadRun(tx, node, runId);
    await tx
      .update(pveRuns)
      .set({ logTail: log.slice(-20 * 1024) })
      .where(eq(pveRuns.id, runId));
  });
}

/**
 * A task failed before (or without) a run: the run linked to it fails too,
 * and a backup task that never opened a run gets a failed run, so History
 * shows it.
 */
export async function finishFailedTaskRun(
  tx: Transaction,
  task: PveTask,
  message: string,
  now: Date,
): Promise<void> {
  if (task.kind === "boot_test") {
    // A boot test's run says it could not be carried out; the restore point keeps its rating.
    await recordBootTestResult(tx, task, { status: "failed", error: message }, now);
    return;
  }
  // Every run the task left open fails with it (a redelivered task can have opened several).
  const closed = await tx
    .update(pveRuns)
    .set({ status: "failed", finishedAt: now, errorMessage: message })
    .where(and(eq(pveRuns.taskId, task.id), eq(pveRuns.status, "running")))
    .returning({ id: pveRuns.id, guestId: pveRuns.guestId });
  if (closed.length > 0) {
    for (const guestId of new Set(closed.map((r) => r.guestId))) {
      await tx.update(pveGuests).set({ lastBackupAt: now }).where(eq(pveGuests.id, guestId));
    }
    return;
  }
  if (task.kind === "backup" && task.guestId) {
    const [any] = await tx
      .select({ id: pveRuns.id })
      .from(pveRuns)
      .where(eq(pveRuns.taskId, task.id))
      .limit(1);
    if (any) {
      return;
    }
    const [guest] = await tx
      .select()
      .from(pveGuests)
      .where(eq(pveGuests.id, task.guestId))
      .limit(1);
    if (guest) {
      await tx.insert(pveRuns).values({
        tenantId: task.tenantId,
        clusterId: guest.clusterId,
        nodeId: task.nodeId,
        guestId: guest.id,
        kind: "backup",
        origin: "restow",
        status: "failed",
        taskId: task.id,
        errorMessage: message,
        startedAt: task.createdAt,
        finishedAt: now,
      });
      await tx.update(pveGuests).set({ lastBackupAt: now }).where(eq(pveGuests.id, guest.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Containers: restic repository and short-lived credentials
// ---------------------------------------------------------------------------

export function resticUrl(instanceUrl: string, guestId: string): string {
  return `${instanceUrl.replace(/\/$/, "")}/agent/pve/restic/${guestId}/`;
}

/** Where a container backup reports its progress, with the run's own credential. */
export function progressUrl(instanceUrl: string, runId: string): string {
  return `${instanceUrl.replace(/\/$/, "")}/agent/pve/v1/runs/${runId}/progress`;
}

async function issueResticCredential(
  tenantId: string,
  runId: string,
  guestId: string,
  instanceUrl: string,
  now: Date,
  backup = false,
) {
  // A backup also makes sure the repository is really on the primary (repository.ts).
  const password = await ensureGuestRepository(tenantId, guestId, { runId, write: backup });
  const token = generateAgentSecret();
  const expiresAt = new Date(now.getTime() + RESTIC_TOKEN_TTL_MS);
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .update(pveRuns)
      .set({ resticTokenHash: token.hash, resticExpiresAt: expiresAt })
      .where(eq(pveRuns.id, runId)),
  );
  return {
    repositoryUrl: resticUrl(instanceUrl, guestId),
    username: runId,
    password: token.value,
    repositoryPassword: password,
    expiresAt: expiresAt.toISOString(),
    // Backups only; an older server sends neither, and the node then reports nothing.
    ...(backup
      ? {
          progressUrl: progressUrl(instanceUrl, runId),
          progressIntervalSeconds: PROGRESS_INTERVAL_SECONDS,
        }
      : {}),
  };
}

/** The per-run credential of a container backup. */
export async function runRestic(
  node: NodeContext,
  runId: string,
  instanceUrl: string,
  now: Date = new Date(),
) {
  const run = await withTenantTx(db, node.tenantId, (tx) => loadRun(tx, node, runId));
  requireOpenBackup(run);
  return issueResticCredential(node.tenantId, run.id, run.guestId, instanceUrl, now, true);
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

async function snapshotInCluster(node: NodeContext, snapshotId: string): Promise<PveSnapshot> {
  const [snap] = await withTenantTx(db, node.tenantId, (tx) =>
    tx
      .select()
      .from(pveSnapshots)
      .where(and(eq(pveSnapshots.id, snapshotId), eq(pveSnapshots.clusterId, node.clusterId)))
      .limit(1),
  );
  if (snap?.status !== "active") {
    throw problem(404, "Restore point not found", "No such restore point in this node's cluster.");
  }
  return snap;
}

/** Look a PVE volume name of this cluster up. */
export async function resolveVolname(node: NodeContext, volname: string) {
  const parsed = parseArchiveName(volname);
  if (!parsed) {
    throw problem(404, "Restore point not found", "Not a volume name of this storage.");
  }
  const [snap] = await withTenantTx(db, node.tenantId, (tx) =>
    tx
      .select()
      .from(pveSnapshots)
      .where(
        and(
          eq(pveSnapshots.clusterId, node.clusterId),
          eq(pveSnapshots.archiveName, parsed.archiveName),
          eq(pveSnapshots.status, "active"),
        ),
      )
      .limit(1),
  );
  if (!snap) {
    throw problem(
      404,
      "Restore point not found",
      `No restore point ${parsed.archiveName} in this cluster.`,
    );
  }
  return {
    snapshotId: snap.id,
    kind: snap.kind,
    vmid: parsed.vmid,
    guestConfig: snap.guestConfig,
    firewallConfig: snap.firewallConfig,
    devices: snap.disks.map((d) => ({ device: d.device, size: d.size })),
    resticSnapshotId: snap.resticSnapshotId ?? "",
    resticRoot: snap.resticRoot ?? "",
  };
}

async function diskMap(node: NodeContext, snapshotId: string, device: string) {
  const snap = await snapshotInCluster(node, snapshotId);
  const disk = snap.disks.find((d) => d.device === device);
  if (!disk) {
    throw problem(404, "Disk not found", `The restore point has no disk ${device}.`);
  }
  const store = await tenantChunkStore(node.tenantId);
  return { store, map: await readBlockMap(store, disk.map.chunks), disk };
}

export async function diskHashes(
  node: NodeContext,
  snapshotId: string,
  device: string,
): Promise<Buffer> {
  const { map } = await diskMap(node, snapshotId, device);
  return encodeHashList(map);
}

export const MAX_RESTORE_BLOCKS = 16;

/** Blocks [from, from+count) of a disk, each proven against the map's SHA-256. */
export async function restoreBlocks(
  node: NodeContext,
  snapshotId: string,
  device: string,
  from: number,
  count: number,
): Promise<Buffer> {
  const { store, map } = await diskMap(node, snapshotId, device);
  const reader = newChunkReader(store);
  const parts: Buffer[] = [];
  const end = Math.min(from + Math.min(count, MAX_RESTORE_BLOCKS), map.entries.length);
  for (let i = from; i < end; i++) {
    const entry = map.entries[i];
    if (!entry) {
      break;
    }
    const length = blockLength(map.diskSize, i);
    if (entry.chunks.length === 0) {
      parts.push(encodeRestoreBlock(i, length, null));
      continue;
    }
    const pieces: Buffer[] = [];
    for await (const piece of reader.read(entry.chunks)) {
      pieces.push(piece);
    }
    const data = Buffer.concat(pieces);
    if (data.length !== length || sha256Hex(data) !== entry.sha256) {
      throw problem(
        500,
        "Restore data damaged",
        `${device}: block ${i} does not match its recorded SHA-256.`,
      );
    }
    parts.push(encodeRestoreBlock(i, length, data));
  }
  return Buffer.concat(parts);
}

/** A read credential for a container restore point (a restore run is recorded). */
export async function restoreRestic(
  node: NodeContext,
  snapshotId: string,
  instanceUrl: string,
  now: Date = new Date(),
) {
  const snap = await snapshotInCluster(node, snapshotId);
  if (snap.kind !== "ct") {
    throw problem(
      409,
      "Not a container",
      "Only container restore points have a restic repository.",
    );
  }
  const runId = await withTenantTx(db, node.tenantId, async (tx) => {
    const [task] = await tx
      .select()
      .from(pveTasks)
      .where(
        and(
          eq(pveTasks.nodeId, node.nodeId),
          eq(pveTasks.guestId, snap.guestId),
          eq(pveTasks.kind, "restore"),
          eq(pveTasks.status, "delivered"),
        ),
      )
      .orderBy(desc(pveTasks.deliveredAt))
      .limit(1);
    if (task) {
      const [existing] = await tx
        .select()
        .from(pveRuns)
        .where(eq(pveRuns.taskId, task.id))
        .limit(1);
      if (existing) {
        return existing.id;
      }
    }
    const [run] = await tx
      .insert(pveRuns)
      .values({
        tenantId: node.tenantId,
        clusterId: node.clusterId,
        nodeId: node.nodeId,
        guestId: snap.guestId,
        kind: "restore",
        origin: task ? "restow" : "pve",
        archiveName: snap.archiveName,
        storageId: snap.storageId,
        taskId: task?.id ?? null,
        snapshotId: snap.id,
        startedAt: now,
      })
      .returning();
    return (run as PveRun).id;
  });
  return issueResticCredential(node.tenantId, runId, snap.guestId, instanceUrl, now);
}
