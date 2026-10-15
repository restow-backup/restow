import type { Readable } from "node:stream";
import {
  type OpenRepository,
  openRepository,
  type RepositoryAccess,
  resolveSelection,
  resticBinary,
  resticCacheBase,
  resticListDirectory,
  SelectionError,
  streamSnapshotZip,
} from "@restow/core";
import {
  acquireEndpointRepositoryLock,
  type Database,
  EndpointRepositoryBusyError,
  type PveGuest,
  type PveSnapshot,
  pveDownloads,
  pveGuestRepositoryLockKey,
  pveGuests,
  pveSnapshots,
} from "@restow/db";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { readSecret } from "../../lib/secrets.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { BrowseDto, PreparedDownloadDto } from "../endpoints/dto.js";
import { ENDPOINT_PROBLEMS } from "../endpoints/problems.js";
import { backendHolding, READ_LOCK_WAIT_MS, tenantStorage } from "../endpoints/repository.js";
import { resticGate } from "../endpoints/restic-gate.js";
import { resticProblem } from "../endpoints/restic-problem.js";
import { browseCursorFor, decodeBrowseCursor } from "../endpoints/service.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";
import { guestRepositoryPrefix } from "./runs.js";
import type { CreateFilesDownloadInput, FilesQuery } from "./schemas.js";
import { browseVmFiles, openVmDownload, prepareVmDownload } from "./vm-files.js";

/**
 * File restore of Proxmox VE containers (#62, docs/PVE.md "File restore"):
 * browse a container restore point folder by folder and download files and
 * folders of it as a ZIP, the way machines are restored on the file restore
 * page (features/endpoints, the same restic runner and ZIP writer).
 *
 * A container restore point is a restic snapshot in the guest's own
 * repository (`pve-guests/<guest id>/`), opened here through the loopback
 * maintenance listener with the repository password from the secret store; the
 * password never leaves the server. The node backs the container up with
 * sources relative to the folder vzdump mounts it in (`.` and the mount
 * points, agent/internal/pve/container.go), so the snapshot's tree is the
 * container's root file system: `/opt/paperless/...` in the tree is
 * `/opt/paperless/...` in the container. The temporary folder (`resticRoot`)
 * only appears in restic's own `paths` of the snapshot, which nothing here
 * shows.
 *
 * Every read holds the repository shared with other reads, never beside the
 * worker's retention or check (`pveGuestRepositoryLockKey`), and goes through
 * the same per-tenant gate as the endpoint reads. A running backup holds only
 * restic's shared lock, so files can be browsed while the container backs up.
 * Every page browsed and every download started is audited. A VM restore
 * point goes to vm-files.ts: its disks' file systems are read by a sandboxed
 * user-space reader, never mounted.
 */

export const PVE_FILE_PROBLEMS = {
  notAContainer: "urn:restow:problem:pve-files-not-a-container",
  noRepository: "urn:restow:problem:pve-files-no-repository",
} as const;

/** How long a prepared download can be started, and how long its row is kept. */
export const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const DOWNLOAD_KEEP_MS = 60 * 60 * 1000;

function notFound(): ProblemError {
  return new ProblemError(404, "Restore point not found", {
    detail: "The restore point does not exist (any more).",
  });
}

function noRepository(): ProblemError {
  return new ProblemError(409, "Repository not available", {
    type: PVE_FILE_PROBLEMS.noRepository,
    detail: "The repository of this container is not available.",
  });
}

function downloadGone(): ProblemError {
  return new ProblemError(404, "Download not found", {
    type: ENDPOINT_PROBLEMS.downloadGone,
    detail: "The download is unknown, has expired or was started already. Prepare it again.",
  });
}

/**
 * The folders a container backup holds, from the guest configuration stored
 * with the restore point: the root file system, and every mount point vzdump
 * includes (a volume with `backup=1`; bind and device mounts never are).
 */
export function containerBackupPaths(guestConfig: string): string[] {
  const mounts = new Set<string>();
  for (const raw of guestConfig.split("\n")) {
    const line = raw.trim();
    // The configuration of PVE snapshots follows in sections; the current one comes first.
    if (line.startsWith("[")) {
      break;
    }
    const match = /^mp\d+:\s*(.+)$/.exec(line);
    if (!match?.[1]) {
      continue;
    }
    const [first = "", ...rest] = match[1].split(",");
    const options = new Map<string, string>();
    for (const part of rest) {
      const at = part.indexOf("=");
      if (at > 0) {
        options.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
      }
    }
    const volume = first.startsWith("volume=") ? first.slice("volume=".length) : first;
    const path = options.get("mp");
    const backup = ["1", "yes", "true", "on"].includes(options.get("backup") ?? "");
    if (path?.startsWith("/") && backup && volume.length > 0 && !volume.startsWith("/")) {
      mounts.add(path.replace(/\/+$/, "") || "/");
    }
  }
  mounts.delete("/");
  return ["/", ...[...mounts].sort()];
}

interface ContainerPoint {
  snapshot: PveSnapshot & { resticSnapshotId: string };
  guest: PveGuest;
}

/** The active container restore point `id` of the tenant, with its guest (404 otherwise). */
async function loadContainerPoint(
  tx: Transaction,
  tenantId: string,
  id: string,
): Promise<ContainerPoint> {
  const [row] = await tx
    .select({ snapshot: pveSnapshots, guest: pveGuests })
    .from(pveSnapshots)
    .innerJoin(pveGuests, eq(pveGuests.id, pveSnapshots.guestId))
    .where(
      and(
        eq(pveSnapshots.tenantId, tenantId),
        eq(pveSnapshots.id, id),
        eq(pveSnapshots.status, "active"),
      ),
    )
    .limit(1);
  if (!row) {
    throw notFound();
  }
  if (row.snapshot.kind !== "ct" || !row.snapshot.resticSnapshotId) {
    throw new ProblemError(409, "Not a container restore point", {
      type: PVE_FILE_PROBLEMS.notAContainer,
      detail: "This restore point cannot be browsed file by file.",
    });
  }
  return {
    snapshot: row.snapshot as PveSnapshot & { resticSnapshotId: string },
    guest: row.guest,
  };
}

/** Everything restic needs to open a container's repository (the password from the secret store). */
async function guestRepositoryAccess(
  database: Database,
  guest: PveGuest,
): Promise<RepositoryAccess> {
  if (!guest.repositorySecretId || !guest.repositoryReadyAt) {
    throw noRepository();
  }
  const password = await readSecret(database, {
    id: guest.repositorySecretId,
    tenantId: guest.tenantId,
  });
  if (password === null) {
    throw noRepository();
  }
  const prefix = guestRepositoryPrefix(guest.id);
  const storage = await backendHolding(await tenantStorage(database, guest.tenantId), prefix);
  return {
    storage,
    prefix,
    repositoryPassword: password,
    repositoryKey: guest.id,
    binary: resticBinary(),
    cacheBase: resticCacheBase(),
  };
}

/** Hold a container's repository for a read: shared with other reads, never beside retention or the check. */
async function holdForRead(database: Database, guestId: string): Promise<() => Promise<void>> {
  try {
    return await acquireEndpointRepositoryLock(
      database.$client,
      pveGuestRepositoryLockKey(guestId),
      { mode: "shared", waitMs: READ_LOCK_WAIT_MS, pollMs: 200 },
    );
  } catch (error) {
    if (error instanceof EndpointRepositoryBusyError) {
      throw new ProblemError(503, "Repository busy", {
        type: ENDPOINT_PROBLEMS.repositoryLocked,
        detail:
          "The server is maintaining this container's backups (retention or a check). Try again shortly.",
      });
    }
    throw error;
  }
}

/** The restore point, its guest, and how to open the guest's repository for a read. */
async function openFor(
  database: Database,
  tenantId: string,
  id: string,
): Promise<ContainerPoint & { open: () => Promise<OpenRepository> }> {
  const point = await withTenantTx(database, tenantId, (tx) =>
    loadContainerPoint(tx, tenantId, id),
  );
  const access = await guestRepositoryAccess(database, point.guest);
  const open = async (): Promise<OpenRepository> => {
    const release = await holdForRead(database, point.guest.id);
    try {
      const repository = await openRepository(access);
      return {
        session: repository.session,
        close: async () => {
          try {
            await repository.close();
          } finally {
            await release();
          }
        },
      };
    } catch (error) {
      await release();
      throw error;
    }
  };
  return { ...point, open };
}

function guestLabel(guest: PveGuest): { vmid: number; name: string | null } {
  return { vmid: guest.vmid, name: guest.name };
}

/** The restore point when it is a VM's (its files are read by vm-files.ts), else null. */
async function vmPointOf(database: Database, tenantId: string, id: string) {
  const [row] = await withTenantTx(database, tenantId, (tx) =>
    tx
      .select({ snapshot: pveSnapshots, guest: pveGuests })
      .from(pveSnapshots)
      .innerJoin(pveGuests, eq(pveGuests.id, pveSnapshots.guestId))
      .where(
        and(
          eq(pveSnapshots.tenantId, tenantId),
          eq(pveSnapshots.id, id),
          eq(pveSnapshots.status, "active"),
          eq(pveSnapshots.kind, "vm"),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/**
 * One page of a folder of a container or VM restore point: folders first, then by
 * name, `nextCursor` for the next page. Every page read is audited.
 */
export async function browseContainerFiles(
  database: Database,
  tenantId: string,
  id: string,
  query: FilesQuery,
  actor: PveActor,
  signal?: AbortSignal,
): Promise<BrowseDto> {
  const vm = await vmPointOf(database, tenantId, id);
  if (vm) {
    return browseVmFiles(database, tenantId, vm, query, actor, signal);
  }
  const after = decodeBrowseCursor(query.cursor);
  const { snapshot, guest, open } = await openFor(database, tenantId, id);
  const listing = await resticGate.run(tenantId, async () => {
    const repository = await open();
    try {
      return await resticListDirectory(repository.session, snapshot.resticSnapshotId, query.path, {
        limit: query.limit,
        after,
        signal,
      });
    } catch (error) {
      throw resticProblem(error);
    } finally {
      await repository.close();
    }
  });
  const last = listing.entries.at(-1);
  const nextCursor = listing.hasMore && last ? browseCursorFor(last) : null;
  await withTenantTx(database, tenantId, (tx) =>
    auditPve(tx, {
      tenantId,
      actor,
      action: PVE_AUDIT_ACTIONS.filesBrowsed,
      target: snapshot.id,
      targetType: "pve_snapshot",
      details: {
        ...guestLabel(guest),
        archiveName: snapshot.archiveName,
        path: query.path,
        entries: listing.entries.length,
        continued: after !== null,
        more: nextCursor !== null,
      },
    }),
  );
  return {
    snapshotId: snapshot.id,
    path: query.path,
    entries: listing.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
      size: entry.size,
      mtime: entry.mtime,
    })),
    nextCursor,
  };
}

/**
 * Step one of a ZIP download: every selected path is looked up in the restic
 * snapshot before any byte is sent (a wrong one is a clean 404), and the
 * selection is kept as a short-lived, single-use download that only the admin
 * who asked can start.
 */
export async function prepareContainerDownload(
  database: Database,
  tenantId: string,
  id: string,
  input: CreateFilesDownloadInput,
  actor: PveActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<PreparedDownloadDto> {
  const vm = await vmPointOf(database, tenantId, id);
  if (vm) {
    return prepareVmDownload(
      database,
      tenantId,
      vm,
      input,
      actor,
      { ttlMs: DOWNLOAD_TTL_MS, keepMs: DOWNLOAD_KEEP_MS },
      signal,
      now,
    );
  }
  const { snapshot, open } = await openFor(database, tenantId, id);
  const release = resticGate.acquire(tenantId);
  let repository: OpenRepository | null = null;
  try {
    repository = await open();
    const selection = await resolveSelection(
      repository.session,
      snapshot.resticSnapshotId,
      input.paths,
      { signal },
    ).catch((error) => {
      if (error instanceof SelectionError) {
        throw new ProblemError(404, "Path not found in the restore point", {
          type: ENDPOINT_PROBLEMS.pathNotFound,
          detail: "A selected path is not a file or folder of this restore point.",
        });
      }
      throw resticProblem(error);
    });
    const row = await withTenantTx(database, tenantId, async (tx) => {
      // Downloads nobody started pile up only for an hour.
      await tx
        .delete(pveDownloads)
        .where(
          and(
            eq(pveDownloads.tenantId, tenantId),
            lt(pveDownloads.expiresAt, new Date(now.getTime() - DOWNLOAD_KEEP_MS)),
          ),
        );
      const [created] = await tx
        .insert(pveDownloads)
        .values({
          tenantId,
          snapshotId: snapshot.id,
          selection,
          createdBy: actor.userId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + DOWNLOAD_TTL_MS),
        })
        .returning();
      if (!created) {
        throw new Error("download insert returned no row");
      }
      return created;
    });
    return { id: row.id, expiresAt: row.expiresAt.toISOString(), items: selection.length };
  } finally {
    if (repository) {
      await repository.close().catch(() => undefined);
    }
    release();
  }
}

/** A ZIP being streamed, with a name for the file. */
export interface ContainerDownload {
  stream: Readable;
  fileName: string;
}

/**
 * Step two: start a prepared download. It is claimed atomically (once, before
 * its expiry, by the admin who prepared it), audited before the first byte,
 * and streamed from `restic dump` through the ZIP writer: nothing is held in
 * memory or written to disk. The gate's slot and the repository lock are held
 * until the stream ends, whichever way.
 */
export async function openContainerDownload(
  database: Database,
  tenantId: string,
  id: string,
  downloadId: string,
  actor: PveActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<ContainerDownload> {
  const vm = await vmPointOf(database, tenantId, id);
  if (vm) {
    return openVmDownload(database, tenantId, vm, downloadId, actor, signal, now);
  }
  const { snapshot, guest, open } = await openFor(database, tenantId, id);
  // A busy server, or a repository under maintenance, refuses here, before the download is spent.
  const release = resticGate.acquire(tenantId);
  let repository: OpenRepository | null = null;
  try {
    repository = await open();
    const download = await withTenantTx(database, tenantId, async (tx) => {
      const [claimed] = await tx
        .update(pveDownloads)
        .set({ startedAt: now })
        .where(
          and(
            eq(pveDownloads.tenantId, tenantId),
            eq(pveDownloads.snapshotId, snapshot.id),
            eq(pveDownloads.id, downloadId),
            actor.userId
              ? eq(pveDownloads.createdBy, actor.userId)
              : isNull(pveDownloads.createdBy),
            isNull(pveDownloads.startedAt),
            gt(pveDownloads.expiresAt, now),
          ),
        )
        .returning();
      if (!claimed) {
        return null;
      }
      await auditPve(tx, {
        tenantId,
        actor,
        action: PVE_AUDIT_ACTIONS.filesDownloaded,
        target: snapshot.id,
        targetType: "pve_snapshot",
        details: {
          ...guestLabel(guest),
          archiveName: snapshot.archiveName,
          downloadId: claimed.id,
          paths: claimed.selection.slice(0, 50).map((item) => item.path),
          pathCount: claimed.selection.length,
        },
      });
      return claimed;
    });
    if (!download) {
      throw downloadGone();
    }
    const zip = streamSnapshotZip({
      session: repository.session,
      snapshotId: snapshot.resticSnapshotId,
      paths: download.selection.map((item) => item.path),
      selection: download.selection,
      signal,
      comment: `Restow container backup, CT ${guest.vmid}${guest.name ? ` (${guest.name})` : ""}, ${snapshot.archiveName}`,
    });
    const opened = repository;
    let finished = false;
    const finish = () => {
      if (finished) {
        return;
      }
      finished = true;
      void opened.close().finally(release);
    };
    zip.stream.once("close", finish);
    zip.stream.once("error", finish);
    const base = guest.name ? `${guest.name}-ct${guest.vmid}` : `ct${guest.vmid}`;
    // The whole container is named after the guest, not after the snapshot.
    const name = zip.fileName.startsWith("snapshot-")
      ? `${base}-${snapshot.backupAt.toISOString().slice(0, 10)}.zip`
      : `${base}-${zip.fileName}`;
    return { stream: zip.stream, fileName: name };
  } catch (error) {
    if (repository) {
      await repository.close().catch(() => undefined);
    }
    release();
    throw error;
  }
}
