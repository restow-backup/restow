import { randomBytes, randomUUID } from "node:crypto";
import {
  type BlockMap,
  IncompleteDiskError,
  type PveDiskObject,
  PveFormatError,
  type StagedBlock,
  blockCount,
  blockLength,
  buildBlockMap,
  buildPveManifest,
  decodeFrame,
  encodeBlockMap,
  encodeHashList,
  encodeRestoreBlock,
  generateAgentSecret,
  hashListDigest,
  manifestKey,
  mapChunkIds,
  mapStats,
  parseArchiveName,
  resticInit,
  sealEndpointPassword,
  sealManifest,
  sha256Hex,
  writeToAllTargets,
} from "@restow/core";
import { resticBinary, resticCacheBase, withRepository } from "@restow/core";
import {
  type PveRun,
  type PveSnapshot,
  type PveSnapshotDisk,
  type PveTask,
  pveGuests,
  pveRunBlocks,
  pveRuns,
  pveSnapshots,
  pveTasks,
} from "@restow/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db.js";
import { loadTenantDek, readSecret, storeSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import { PVE_AUDIT_ACTIONS, auditPve, nodeActor } from "./audit.js";
import type { NodeContext } from "./node-auth.js";
import { checkArchiveName, guestForBackup } from "./node-service.js";
import {
  type TenantChunkStore,
  newChunkReader,
  newChunkWriter,
  readBlockMap,
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
/** Container repositories lie under this prefix of the tenant's primary target. */
export function guestRepositoryPrefix(guestId: string): string {
  return `pve-guests/${guestId}/`;
}
export const PVE_REPOSITORY_SECRET_KIND = "pve_ct_repository";
const RESTIC_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
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
): Promise<{ runId: string; guestId: string; origin: "restow" | "pve" }> {
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
    return { runId: run.id, guestId: guest.id, origin: run.origin };
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
  const replaced = await withTenantTx(db, node.tenantId, async (tx) => {
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
  resticTotalBytes?: number;
  resticRoot?: string;
  pveVersion?: string;
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
        if (!baseSnap || baseSnap.status !== "active" || !baseDisk) {
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
  const [run] = await tx
    .select()
    .from(pveRuns)
    .where(and(eq(pveRuns.taskId, task.id), eq(pveRuns.status, "running")))
    .limit(1);
  if (run) {
    await tx
      .update(pveRuns)
      .set({ status: "failed", finishedAt: now, errorMessage: message })
      .where(eq(pveRuns.id, run.id));
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

/** Create the container repository of a guest once (the node is append-only and cannot). */
async function ensureRepository(tenantId: string, guestId: string): Promise<string> {
  const [guest] = await withTenantTx(db, tenantId, (tx) =>
    tx.select().from(pveGuests).where(eq(pveGuests.id, guestId)).limit(1),
  );
  if (!guest) {
    throw problem(404, "Guest not found", "Unknown guest.");
  }
  if (guest.repositorySecretId && guest.repositoryReadyAt) {
    const password = await readSecret(db, { id: guest.repositorySecretId, tenantId });
    if (password) {
      return password;
    }
  }
  const password = randomBytes(32).toString("base64url");
  const secret = await storeSecret(db, {
    tenantId,
    kind: PVE_REPOSITORY_SECRET_KIND,
    plaintext: password,
  });
  const store = await tenantChunkStore(tenantId);
  const prefix = guestRepositoryPrefix(guest.id);
  await withRepository(
    {
      storage: store.write.primary,
      prefix,
      repositoryPassword: password,
      endpointId: guest.id,
      binary: resticBinary(),
      cacheBase: resticCacheBase(),
    },
    (session) => resticInit(session),
  );
  const dek = await withTenantTx(db, tenantId, (tx) => loadTenantDek(tx, tenantId));
  // Next to the repository, sealed with the tenant key: storage and master key restore without this database.
  await store.write.primary.put(
    `${prefix}restow-repository-password.json`,
    sealEndpointPassword({ tenantId, endpointId: guest.id, password, dek }),
  );
  await withTenantTx(db, tenantId, (tx) =>
    tx
      .update(pveGuests)
      .set({ repositorySecretId: secret.id, repositoryReadyAt: new Date() })
      .where(eq(pveGuests.id, guest.id)),
  );
  return password;
}

export function resticUrl(instanceUrl: string, guestId: string): string {
  return `${instanceUrl.replace(/\/$/, "")}/agent/pve/restic/${guestId}/`;
}

async function issueResticCredential(
  tenantId: string,
  runId: string,
  guestId: string,
  instanceUrl: string,
  now: Date,
) {
  const password = await ensureRepository(tenantId, guestId);
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
  return issueResticCredential(node.tenantId, run.id, run.guestId, instanceUrl, now);
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
  if (!snap || snap.status !== "active") {
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
