import { createHash } from "node:crypto";
import { basename } from "node:path/posix";
import type { Readable } from "node:stream";
import {
  blockLength,
  compareDirectoryEntries,
  type FsEntry,
  GuestFsError,
  GuestFsSandbox,
  normaliseSnapshotPath,
  PVE_BLOCK_SIZE,
  type SandboxDisk,
  streamGuestZip,
} from "@restow/core";
import {
  type Database,
  type PveDownloadItem,
  type PveGuest,
  type PveSnapshot,
  pveDownloads,
  pveGuests,
  pveSnapshots,
} from "@restow/db";
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { BrowseDto, PreparedDownloadDto } from "../endpoints/dto.js";
import { ENDPOINT_PROBLEMS } from "../endpoints/problems.js";
import { resticGate } from "../endpoints/restic-gate.js";
import { browseCursorFor, decodeBrowseCursor } from "../endpoints/service.js";
import { auditPve, PVE_AUDIT_ACTIONS, type PveActor } from "./audit.js";
import type { CreateFilesDownloadInput, FilesQuery } from "./schemas.js";
import { newChunkReader, readBlockMap, tenantChunkStore } from "./store.js";

/**
 * File restore from VM restore points (docs/PVE.md, "Files of a VM"): browse the file systems
 * of a VM's disks folder by folder and download files and folders as a ZIP, on the same file
 * restore page and routes as a container's (features/pve/files.ts dispatches here for a VM).
 *
 * Nothing is mounted and nothing runs on the PVE node. The API reads the restore point's disks
 * from its block maps in the tenant's chunk store (every block proven against its SHA-256) and
 * hands the bytes to a reader in a throwaway, sandboxed child process (@restow/core
 * GuestFsSandbox): user-space parsers of partition tables, LVM, ext2/3/4, XFS, NTFS and FAT,
 * under Node's permission model, without secrets, with a heap, time and byte budget. A guest
 * file system built to attack its reader can make that child fail; it never reaches a kernel
 * file system driver, the API's memory or a key. Every folder read and every download is
 * audited, like a container's.
 */

/** How many disk blocks one request keeps decrypted in memory (4 MiB each). */
const BLOCK_CACHE = 16;
/** A folder page may read this much of the disks (the metadata on the way to the folder). */
const BROWSE_READ_BUDGET = 2 * 1024 ** 3;

/** The disks a file restore reads: not the EFI variables and TPM state of the VM. */
export function browsableDisks(snapshot: Pick<PveSnapshot, "disks">) {
  return snapshot.disks.filter((disk) => !/^drive-(efidisk|tpmstate)/.test(disk.device));
}

function notFound(): ProblemError {
  return new ProblemError(404, "Restore point not found", {
    detail: "The restore point does not exist (any more).",
  });
}

function guestProblem(error: unknown): ProblemError {
  if (error instanceof ProblemError) {
    return error;
  }
  if (error instanceof GuestFsError) {
    if (error.code === "not_found") {
      return new ProblemError(404, "Path not found in the restore point", {
        type: ENDPOINT_PROBLEMS.pathNotFound,
        detail: "The path is not a file or folder of this restore point.",
      });
    }
    if (error.code === "not_a_directory") {
      return new ProblemError(404, "Not a folder", {
        type: ENDPOINT_PROBLEMS.pathNotFound,
        detail: "The path is not a folder of this restore point.",
      });
    }
    return new ProblemError(422, "File system not readable", {
      type: PVE_VM_FILE_PROBLEMS.unreadable,
      detail: `The file system of this restore point could not be read here: ${error.message}`,
    });
  }
  throw error;
}

export const PVE_VM_FILE_PROBLEMS = {
  unreadable: "urn:restow:problem:pve-vm-files-unreadable",
} as const;

/** The disks of a VM restore point as the sandbox reads them: blocks from the chunk store. */
async function sandboxDisks(tenantId: string, snapshot: PveSnapshot): Promise<SandboxDisk[]> {
  const store = await tenantChunkStore(tenantId);
  const reader = newChunkReader(store);
  const cache = new Map<string, Buffer>();
  const disks: SandboxDisk[] = [];
  for (const disk of browsableDisks(snapshot)) {
    const map = await readBlockMap(store, disk.map.chunks);
    const block = async (index: number): Promise<Buffer> => {
      const key = `${disk.device}:${index}`;
      const hit = cache.get(key);
      if (hit) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const entry = map.entries[index];
      const length = blockLength(map.diskSize, index);
      let data: Buffer;
      if (!entry || entry.chunks.length === 0) {
        data = Buffer.alloc(length);
      } else {
        const parts: Buffer[] = [];
        for await (const part of reader.read(entry.chunks)) {
          parts.push(part);
        }
        data = Buffer.concat(parts);
        if (
          data.length !== length ||
          createHash("sha256").update(data).digest("hex") !== entry.sha256
        ) {
          throw new Error(`${disk.device}: block ${index} does not match its recorded SHA-256`);
        }
      }
      cache.set(key, data);
      if (cache.size > BLOCK_CACHE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return data;
    };
    disks.push({
      device: disk.device,
      size: map.diskSize,
      read: async (offset, length) => {
        const out = Buffer.alloc(length);
        for (let done = 0; done < length; ) {
          const at = offset + done;
          const index = Math.floor(at / PVE_BLOCK_SIZE);
          const inBlock = at % PVE_BLOCK_SIZE;
          const data = await block(index);
          const take = Math.min(length - done, data.length - inBlock);
          data.copy(out, done, inBlock, inBlock + take);
          done += take;
        }
        return out;
      },
    });
  }
  return disks;
}

interface VmPoint {
  snapshot: PveSnapshot;
  guest: PveGuest;
}

/** The active VM restore point `id` of the tenant with its guest, or 404. */
export async function loadVmPoint(
  database: Database,
  tenantId: string,
  id: string,
): Promise<VmPoint> {
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
  if (!row) {
    throw notFound();
  }
  return row;
}

/** Run `work` with a sandbox over the point's disks; the sandbox is killed afterwards. */
async function withSandbox<T>(
  tenantId: string,
  snapshot: PveSnapshot,
  options: { maxReadBytes?: number; signal?: AbortSignal },
  work: (sandbox: GuestFsSandbox) => Promise<T>,
): Promise<T> {
  const disks = await sandboxDisks(tenantId, snapshot);
  const sandbox = await GuestFsSandbox.start(disks, options);
  try {
    return await work(sandbox);
  } catch (error) {
    throw guestProblem(error);
  } finally {
    sandbox.close();
  }
}

function guestLabel(guest: PveGuest) {
  return { vmid: guest.vmid, name: guest.name, kind: "vm" as const };
}

/**
 * One page of a folder of a VM restore point: `/` lists the readable file systems (a folder
 * each), below that the folders of each. Folders first, then by name.
 */
export async function browseVmFiles(
  database: Database,
  tenantId: string,
  point: VmPoint,
  query: FilesQuery,
  actor: PveActor,
  signal?: AbortSignal,
): Promise<BrowseDto & { unreadable?: { name: string; reason: string }[] }> {
  const after = decodeBrowseCursor(query.cursor);
  const path = normaliseSnapshotPath(query.path);
  const { snapshot, guest } = point;
  const listed = await resticGate.run(tenantId, () =>
    withSandbox(
      tenantId,
      snapshot,
      { maxReadBytes: BROWSE_READ_BUDGET, signal },
      async (sandbox) => {
        const entries = await sandbox.list(path);
        const unreadable = path === "/" ? (await sandbox.volumes()).skipped : [];
        return { entries, unreadable };
      },
    ),
  );
  const sorted = listed.entries
    .map((entry) => ({ ...entry, path: path === "/" ? `/${entry.name}` : `${path}/${entry.name}` }))
    .sort(compareDirectoryEntries);
  const start = after
    ? sorted.findIndex(
        (entry) =>
          compareDirectoryEntries(entry, {
            type: after.folder ? "dir" : "file",
            name: after.name,
          }) > 0,
      )
    : 0;
  const page = start < 0 ? [] : sorted.slice(start, start + query.limit);
  const more = start >= 0 && start + query.limit < sorted.length;
  const last = page.at(-1);
  const nextCursor = more && last ? browseCursorFor(last) : null;
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
        path,
        entries: page.length,
        continued: after !== null,
        more: nextCursor !== null,
      },
    }),
  );
  return {
    snapshotId: snapshot.id,
    path,
    entries: page.map((entry: FsEntry & { path: string }) => ({
      name: entry.name,
      path: entry.path,
      type: entry.type,
      size: entry.size,
      mtime: entry.mtime,
    })),
    nextCursor,
    ...(path === "/" && listed.unreadable.length > 0
      ? { unreadable: listed.unreadable.map((v) => ({ name: v.id, reason: v.reason })) }
      : {}),
  };
}

/** Step one of a ZIP download: every path is looked up before anything is sent. */
export async function prepareVmDownload(
  database: Database,
  tenantId: string,
  point: VmPoint,
  input: CreateFilesDownloadInput,
  actor: PveActor,
  ttl: { ttlMs: number; keepMs: number },
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<PreparedDownloadDto> {
  const { snapshot } = point;
  const requested = [...new Set(input.paths.map(normaliseSnapshotPath))];
  const selection = await resticGate.run(tenantId, () =>
    withSandbox(
      tenantId,
      snapshot,
      { maxReadBytes: BROWSE_READ_BUDGET, signal },
      async (sandbox) => {
        const out: PveDownloadItem[] = [];
        for (const path of requested) {
          const entry = path === "/" ? { type: "dir" as const } : await sandbox.stat(path);
          if (!entry || (entry.type !== "file" && entry.type !== "dir")) {
            throw new ProblemError(404, "Path not found in the restore point", {
              type: ENDPOINT_PROBLEMS.pathNotFound,
              detail: "A selected path is not a file or folder of this restore point.",
            });
          }
          out.push({ path, type: entry.type });
        }
        return out;
      },
    ),
  );
  const row = await withTenantTx(database, tenantId, async (tx) => {
    await tx
      .delete(pveDownloads)
      .where(
        and(
          eq(pveDownloads.tenantId, tenantId),
          lt(pveDownloads.expiresAt, new Date(now.getTime() - ttl.keepMs)),
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
        expiresAt: new Date(now.getTime() + ttl.ttlMs),
      })
      .returning();
    if (!created) {
      throw new Error("download insert returned no row");
    }
    return created;
  });
  return { id: row.id, expiresAt: row.expiresAt.toISOString(), items: selection.length };
}

/**
 * Step two: claim the prepared download (once, by the admin who prepared it), audit it and
 * stream the ZIP. Files the reader cannot read (an NTFS-compressed file, a damaged one) do not
 * break the download: they are named in `_not-restored.txt` at its end. Symbolic links are not
 * followed and listed there too.
 */
export async function openVmDownload(
  database: Database,
  tenantId: string,
  point: VmPoint,
  downloadId: string,
  actor: PveActor,
  signal?: AbortSignal,
  now: Date = new Date(),
): Promise<{ stream: Readable; fileName: string }> {
  const { snapshot, guest } = point;
  const download = await withTenantTx(database, tenantId, async (tx) => {
    const [claimed] = await tx
      .update(pveDownloads)
      .set({ startedAt: now })
      .where(
        and(
          eq(pveDownloads.tenantId, tenantId),
          eq(pveDownloads.snapshotId, snapshot.id),
          eq(pveDownloads.id, downloadId),
          actor.userId ? eq(pveDownloads.createdBy, actor.userId) : isNull(pveDownloads.createdBy),
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
    throw new ProblemError(404, "Download not found", {
      type: ENDPOINT_PROBLEMS.downloadGone,
      detail: "The download is unknown, has expired or was started already. Prepare it again.",
    });
  }
  const release = resticGate.acquire(tenantId);
  let sandbox: GuestFsSandbox;
  try {
    // A download reads what it holds; the deadline per read still ends a reader that hangs.
    sandbox = await GuestFsSandbox.start(await sandboxDisks(tenantId, snapshot), {
      maxReadBytes: Number.MAX_SAFE_INTEGER,
      signal,
    });
  } catch (error) {
    release();
    throw error;
  }
  const stream = streamGuestZip({
    reader: sandbox,
    selection: download.selection,
    comment: `Restow VM backup, VM ${guest.vmid}${guest.name ? ` (${guest.name})` : ""}, ${snapshot.archiveName}`,
    signal,
    onEnd: () => {
      sandbox.close();
      release();
    },
  });
  const base = guest.name ? `${guest.name}-vm${guest.vmid}` : `vm${guest.vmid}`;
  const first = download.selection.length === 1 ? download.selection[0] : null;
  const label =
    first && first.path !== "/"
      ? basename(first.path)
      : snapshot.backupAt.toISOString().slice(0, 10);
  return { stream, fileName: `${base}-${label}.zip` };
}
