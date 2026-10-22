import { randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Database } from "@restow/db";
import { audit } from "../../lib/audit.js";
import { ProblemError } from "../../problem.js";
import {
  type DataLocation,
  type DataUsage,
  type MoveCheck,
  type MoveProblem,
  type MoveRecord,
  type OldCopy,
  type OldCopyRemoval,
  type UpdateSpace,
  validateTargetDir,
} from "../../updater/database-protocol.js";
import { isDumpFileName } from "../../updater/dumps.js";
import type { StateView } from "../../updater/protocol.js";
import { type Actor, mapUpdaterError } from "./service.js";
import {
  type UpdaterClient,
  UpdaterRejectedError,
  UpdaterUnavailableError,
} from "./updater-client.js";

/**
 * Installation > Database (docs/DATABASE.md): where the database keeps its data, how
 * much room its disk and the disk of the local default repository have, moving the
 * database to a directory on another disk through the opt-in updater, removing the old
 * copy a move left, and the updater's pre-update dumps (download and delete).
 *
 *   GET    /api/v1/updates/database                     the view (every provider admin)
 *   POST   /api/v1/updates/database/check               check a directory (owner)
 *   POST   /api/v1/updates/database/move                move the database there (owner, recent sign-in)
 *   DELETE /api/v1/updates/database/old-copies/:id      remove an old copy (owner, recent sign-in)
 *   POST   /api/v1/updates/dumps/:file/download         a one-time download link (owner, recent sign-in)
 *   GET    /api/v1/updates/dumps/:file?ticket=...       the download itself (owner, with the link's ticket)
 *   DELETE /api/v1/updates/dumps/:file                  delete a dump (owner, recent sign-in)
 *
 * A dump holds the whole database, the encrypted secrets included: it is treated like the
 * most sensitive export there is. A download takes two requests: the first, which needs a
 * recent sign-in, issues a ticket for that one file and that one person, valid for a minute
 * and good for one download; the browser then follows the link and saves the file as it
 * streams in (a fetch could not hand gigabytes to the disk, and a plain link could not ask
 * the person to confirm it is them). The download is audited before the first byte goes
 * out and streamed through without being buffered; nothing of it is logged.
 */

export const DATABASE_AUDIT_ACTIONS = {
  /** A provider owner asked the updater to move the database (`target`: the directory). */
  moveRequested: "database.move.requested",
  /** Written from the updater's journal: the move started, succeeded or failed. */
  moveStarted: "database.move.started",
  moveSucceeded: "database.move.succeeded",
  moveFailed: "database.move.failed",
  /** A provider owner asked the updater to remove an old copy; and the updater's report of it. */
  oldCopyRemovalRequested: "database.old_copy.removal_requested",
  oldCopyRemoved: "database.old_copy.removed",
  /** A pre-update dump was downloaded or deleted (`target`: the file name). */
  dumpDownloaded: "update.dump.downloaded",
  dumpDeleted: "update.dump.deleted",
} as const;

export const DATABASE_PROBLEMS = {
  /** The checks of the directory did not pass; `problems` says which. */
  moveRefused: "urn:restow:problem:database-move-refused",
  /** An update, a restart, a move or a removal runs. */
  busy: "urn:restow:problem:database-busy",
  /** The updater answers but cannot move the database (it predates the feature). */
  unsupported: "urn:restow:problem:database-move-unsupported",
  invalidDirectory: "urn:restow:problem:database-directory-invalid",
  dumpNotFound: "urn:restow:problem:dump-not-found",
  dumpProtected: "urn:restow:problem:dump-protected",
  oldCopyNotFound: "urn:restow:problem:database-old-copy-not-found",
  /** The download link was used already, expired, or is someone else's. */
  dumpTicketInvalid: "urn:restow:problem:dump-ticket-invalid",
} as const;

/** How long a download link of a dump is good for. */
export const DUMP_TICKET_TTL_MS = 60_000;

const GIB = 1024 ** 3;
/** A disk is low below a tenth of its size, and never with less than 5 GiB (a quarter on a small one). */
export const DISK_LOW_SHARE = 0.1;
export const DISK_LOW_MIN_BYTES = 5 * GIB;

/** The free space below which a disk of `totalBytes` counts as low. */
export function diskThreshold(totalBytes: number): number {
  return Math.ceil(
    Math.max(totalBytes * DISK_LOW_SHARE, Math.min(DISK_LOW_MIN_BYTES, totalBytes * 0.25)),
  );
}

/** `system` (0.4.5): the disk under the operating system and Docker, read as `/` in the api. */
export type DiskKind = "database" | "repository" | "system";

export interface DiskStatus {
  kind: DiskKind;
  /** The data directory or volume (database), the repository's path (repository), `/` (system). */
  location: string | null;
  freeBytes: number;
  totalBytes: number;
  thresholdBytes: number;
  low: boolean;
}

export function diskStatus(
  kind: DiskKind,
  location: string | null,
  freeBytes: number,
  totalBytes: number,
): DiskStatus {
  const thresholdBytes = diskThreshold(totalBytes);
  return { kind, location, freeBytes, totalBytes, thresholdBytes, low: freeBytes < thresholdBytes };
}

/**
 * What the database page can do with the updater:
 *
 *   ready        the updater answers and can move the database
 *   unsupported  the updater answers but predates the database location (recreate it)
 *   unavailable  no updater answers (the manual steps of docs/DATABASE.md remain)
 *   demo         the demo installation changes nothing
 */
export type DatabaseUpdaterAvailability = "ready" | "unsupported" | "unavailable" | "demo";

export interface DatabaseView {
  updater: DatabaseUpdaterAvailability;
  /** An update is announced or running: nothing can be moved now. */
  updateActive: boolean;
  location: DataLocation | null;
  usage: DataUsage | null;
  /** The compose file takes the location from `.env`; null when unknown. */
  movable: boolean | null;
  move: MoveRecord | null;
  oldCopies: OldCopy[];
  removal: OldCopyRemoval | null;
  /** What the next update needs on disk (the updater's preflight); null when unknown. */
  updateSpace: UpdateSpace | null;
  disks: { database: DiskStatus | null; repository: DiskStatus | null };
  /** The project directory on the host, for the commands of the manual way. */
  projectDir: string | null;
}

/** The disk under the installation's local default repository; null when it is not local. */
export type RepositoryDisk = () => Promise<{
  path: string;
  freeBytes: number;
  totalBytes: number;
} | null>;

export interface DatabaseServiceDeps {
  /** The installation pool: the installation audit chain. */
  db: Database;
  updater: UpdaterClient;
  repositoryDisk: RepositoryDisk;
  demo?: boolean;
  now?: () => number;
}

/** A volume's name or a directory: what the page and the audit log show. */
function describeLocation(location: DataLocation | null): string | null {
  return location?.source ?? null;
}

export class DatabaseService {
  /** Download tickets of dumps, in memory: they live for a minute and the api runs once. */
  private readonly tickets = new Map<
    string,
    { file: string; userId: string | null; expiresAt: number }
  >();

  constructor(private readonly deps: DatabaseServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get demo(): boolean {
    return this.deps.demo === true;
  }

  private async updaterState(fresh: boolean): Promise<StateView | null> {
    if (this.demo || !this.deps.updater.enabled) {
      return null;
    }
    try {
      return await this.deps.updater.state({ fresh });
    } catch {
      return null;
    }
  }

  /** The two watched disks, from the updater's view and the repository's file system. */
  async disks(state?: StateView | null): Promise<DatabaseView["disks"]> {
    const current = state === undefined ? await this.updaterState(false) : state;
    const usage = current?.database?.usage ?? null;
    const database = usage
      ? diskStatus(
          "database",
          describeLocation(current?.database?.location ?? null),
          usage.filesystemFreeBytes,
          usage.filesystemTotalBytes,
        )
      : null;
    const repositoryDisk = await this.deps.repositoryDisk().catch(() => null);
    const repository = repositoryDisk
      ? diskStatus(
          "repository",
          repositoryDisk.path,
          repositoryDisk.freeBytes,
          repositoryDisk.totalBytes,
        )
      : null;
    return { database, repository };
  }

  async view(options: { fresh?: boolean } = {}): Promise<DatabaseView> {
    const state = await this.updaterState(options.fresh === true);
    const database = state?.database ?? null;
    const updater: DatabaseUpdaterAvailability = this.demo
      ? "demo"
      : !state
        ? "unavailable"
        : !database
          ? "unsupported"
          : "ready";
    return {
      updater,
      updateActive: state?.phase === "scheduled" || state?.phase === "running",
      location: database?.location ?? null,
      usage: database?.usage ?? null,
      movable: database?.movable ?? null,
      move: database?.move ?? null,
      oldCopies: database?.oldCopies ?? [],
      removal: database?.removal ?? null,
      updateSpace: state?.capabilities.updateSpace ?? null,
      disks: await this.disks(state),
      projectDir: state?.projectDir ?? state?.capabilities.projectDir ?? null,
    };
  }

  /** Check a directory; nothing changes, so nothing is audited. */
  async check(targetDir: string, actor: Actor): Promise<MoveCheck> {
    const dir = this.validDirectory(targetDir);
    await this.requireUpdater();
    try {
      return await this.deps.updater.checkDatabaseLocation({
        targetDir: dir,
        requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  /** Move the database to `targetDir`; the updater checks everything again first. */
  async move(targetDir: string, actor: Actor): Promise<DatabaseView> {
    const dir = this.validDirectory(targetDir);
    await this.requireUpdater();
    try {
      await this.deps.updater.moveDatabase({
        targetDir: dir,
        requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
      });
    } catch (error) {
      throw mapDatabaseError(error);
    }
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: DATABASE_AUDIT_ACTIONS.moveRequested,
      target: dir,
      targetType: "database",
      ip: actor.ip,
      details: { targetDir: dir },
    });
    return this.view({ fresh: true });
  }

  async removeOldCopy(id: string, actor: Actor): Promise<DatabaseView> {
    if (!/^c-\d{1,16}$/.test(id)) {
      throw new ProblemError(404, "No such old copy", { type: DATABASE_PROBLEMS.oldCopyNotFound });
    }
    const state = await this.requireUpdater();
    const copy = state.database?.oldCopies.find((entry) => entry.id === id) ?? null;
    try {
      await this.deps.updater.removeOldDatabaseCopy(id, {
        userId: actor.id,
        label: actor.email,
        ip: actor.ip,
      });
    } catch (error) {
      throw mapDatabaseError(error, "copy");
    }
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: DATABASE_AUDIT_ACTIONS.oldCopyRemovalRequested,
      target: describeLocation(copy?.location ?? null) ?? id,
      targetType: "database",
      ip: actor.ip,
      details: { copyId: id, location: copy?.location ?? null, movedAt: copy?.movedAt ?? null },
    });
    return this.view({ fresh: true });
  }

  /**
   * A dump as a download: audited first, then the updater's stream is handed through. The
   * response carries only what a download needs (no updater headers).
   */
  /** A one-time link to download `file`, for `actor` only, valid for {@link DUMP_TICKET_TTL_MS}. */
  async issueDumpTicket(file: string, actor: Actor): Promise<{ url: string; expiresAt: string }> {
    if (!isDumpFileName(file)) {
      throw dumpNotFound();
    }
    const state = await this.requireUpdater();
    if (!state.capabilities.dumps.some((dump) => dump.file === file)) {
      throw dumpNotFound();
    }
    const now = this.now();
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(key);
      }
    }
    const ticket = randomBytes(24).toString("base64url");
    const expiresAt = now + DUMP_TICKET_TTL_MS;
    this.tickets.set(ticket, { file, userId: actor.id, expiresAt });
    return {
      url: `/api/v1/updates/dumps/${encodeURIComponent(file)}?ticket=${ticket}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Use up a ticket: true when it was issued for this file and this person and is still valid. */
  private redeemTicket(file: string, presented: string | undefined, actor: Actor): boolean {
    if (!presented) {
      return false;
    }
    for (const [key, ticket] of this.tickets) {
      const a = Buffer.from(key);
      const b = Buffer.from(presented);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        this.tickets.delete(key);
        return ticket.file === file && ticket.userId === actor.id && ticket.expiresAt > this.now();
      }
    }
    return false;
  }

  async downloadDump(file: string, ticket: string | undefined, actor: Actor): Promise<Response> {
    if (!isDumpFileName(file)) {
      throw dumpNotFound();
    }
    if (!this.redeemTicket(file, ticket, actor)) {
      throw new ProblemError(403, "The download link is not valid", {
        type: DATABASE_PROBLEMS.dumpTicketInvalid,
        detail: "Start the download again from Installation > Updates.",
      });
    }
    await this.requireUpdater();
    let upstream: Response | null;
    try {
      upstream = await this.deps.updater.downloadDump(file);
    } catch (error) {
      throw mapDatabaseError(error, "dump");
    }
    if (!upstream?.body) {
      throw dumpNotFound();
    }
    const length = upstream.headers.get("content-length");
    try {
      await audit(this.deps.db, {
        tenantId: null,
        actor: actor.email,
        actorUserId: actor.id,
        action: DATABASE_AUDIT_ACTIONS.dumpDownloaded,
        target: file,
        targetType: "dump",
        ip: actor.ip,
        details: { file, bytes: length && /^\d+$/.test(length) ? Number(length) : null },
      });
    } catch (error) {
      // No audit entry, no download.
      await upstream.body.cancel().catch(() => undefined);
      throw error;
    }
    const headers = new Headers({
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    if (length && /^\d+$/.test(length)) {
      headers.set("Content-Length", length);
    }
    return new Response(upstream.body, { status: 200, headers });
  }

  async deleteDump(file: string, actor: Actor): Promise<void> {
    if (!isDumpFileName(file)) {
      throw dumpNotFound();
    }
    await this.requireUpdater();
    try {
      await this.deps.updater.deleteDump(file);
    } catch (error) {
      throw mapDatabaseError(error, "dump");
    }
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: DATABASE_AUDIT_ACTIONS.dumpDeleted,
      target: file,
      targetType: "dump",
      ip: actor.ip,
      details: { file },
    });
  }

  private validDirectory(targetDir: string): string {
    const validated = validateTargetDir(targetDir);
    if ("problem" in validated) {
      throw new ProblemError(422, "Invalid directory", {
        type: DATABASE_PROBLEMS.invalidDirectory,
        detail: validated.problem,
        extensions: {
          field: "targetDir",
          problems: [{ code: "path_invalid", detail: validated.problem }],
        },
      });
    }
    return validated.dir;
  }

  private async requireUpdater(): Promise<StateView> {
    if (this.demo || !this.deps.updater.enabled) {
      throw mapUpdaterError(new UpdaterUnavailableError("disabled"));
    }
    const state = await this.updaterState(true);
    if (!state) {
      throw mapUpdaterError(new UpdaterUnavailableError("unreachable"));
    }
    if (!state.database) {
      throw new ProblemError(409, "The updater cannot move the database", {
        type: DATABASE_PROBLEMS.unsupported,
        detail:
          "This updater predates the database location. Recreate it (`docker compose --profile updater up -d updater`) after updating, or follow docs/DATABASE.md.",
      });
    }
    return state;
  }
}

function dumpNotFound(): ProblemError {
  return new ProblemError(404, "No such dump", { type: DATABASE_PROBLEMS.dumpNotFound });
}

/** The updater's refusals of the database routes as problems. */
export function mapDatabaseError(
  error: unknown,
  context: "move" | "copy" | "dump" = "move",
): ProblemError {
  if (error instanceof UpdaterRejectedError) {
    const body = (error.body ?? {}) as { message?: unknown; problems?: MoveProblem[] };
    const message = typeof body.message === "string" ? body.message : undefined;
    if (error.code === "blocked" && Array.isArray(body.problems)) {
      return new ProblemError(409, "The database cannot be moved there", {
        type: DATABASE_PROBLEMS.moveRefused,
        detail: message,
        extensions: { problems: body.problems },
      });
    }
    if (error.code === "blocked") {
      return new ProblemError(409, "Refused", {
        type: context === "dump" ? DATABASE_PROBLEMS.dumpProtected : DATABASE_PROBLEMS.busy,
        detail: message,
      });
    }
    if (error.code === "busy") {
      return new ProblemError(409, "Something else runs", {
        type: DATABASE_PROBLEMS.busy,
        detail: message,
      });
    }
    if (error.code === "not_found") {
      return new ProblemError(404, "Not found", {
        type:
          context === "dump" ? DATABASE_PROBLEMS.dumpNotFound : DATABASE_PROBLEMS.oldCopyNotFound,
        detail: message,
      });
    }
  }
  return mapUpdaterError(error);
}

/**
 * The file system under a local repository path: the path itself, or the nearest
 * directory above it that exists (a repository that has not written yet).
 */
export async function filesystemOf(
  target: string,
): Promise<{ path: string; freeBytes: number; totalBytes: number } | null> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return {
        path: target,
        freeBytes: Number(stats.bavail) * Number(stats.bsize),
        totalBytes: Number(stats.blocks) * Number(stats.bsize),
      };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  }
}
