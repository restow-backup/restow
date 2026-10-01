/**
 * OneDrive backup engine (docs/MICROSOFT.md, OneDrive backup and
 * restore).
 *
 *   drive root delta with token   first run enumerates everything, later runs
 *                                 only changes incl. the `deleted` facet
 *   items tracked by id           paths are derived when a manifest is written,
 *                                 so moves, renames and deletions are correct in
 *                                 whatever order Graph reports them
 *   streaming downloads           `@microsoft.graph.downloadUrl` into the chunk
 *                                 writer; files are never held in memory
 *   folders as manifest objects   kind "folder", so the tree restores as a tree
 *   metadata as information       path, size, mtime, authorship, sharing;
 *                                 permissions are recorded, never restored (v1)
 *   versions (optional)           `/items/{id}/versions`, off by default (cost)
 *   resume                        job cursor with page URL and last item
 *   410 Gone                      full re-enumeration of this drive; content
 *                                 unchanged by cTag is reused, not re-downloaded
 *   item failures                 non-fatal, reported, retried next run
 *   cancellation                  checkpoint, then JobAbortedError
 *
 * The engine is pure with respect to its environment: Graph access comes in
 * through {@link OneDriveGraphClientResolver}, everything else through the
 * JobContext.
 */
import { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  BackupEngine,
  BackupOptions,
  BackupResult,
  JobContext,
  ProtectedObjectRef,
} from "../../engine/types.js";
import type { GraphClient } from "../../graph/client.js";
import { getUserDrive } from "../../graph/resources/drive.js";
import { DriveBackupRun, type RunSettings } from "./run.js";
import {
  ENGINE_NAME,
  planRun,
  readCheckpointDeletions,
  readCursor,
  readManifestState,
} from "./state.js";

/**
 * Hands the engine a throttled Graph client for the source that owns the
 * protected object. The worker builds it from the source's Entra tenant and
 * the app credentials; tests hand in a fake.
 */
export type OneDriveGraphClientResolver<Db = unknown> = (
  ctx: JobContext<Db>,
  protectedObject: ProtectedObjectRef,
) => Promise<GraphClient> | GraphClient;

/** Maps a protected object to the Graph drive id it stands for. */
export type OneDriveIdResolver = (
  client: GraphClient,
  protectedObject: ProtectedObjectRef,
) => Promise<string>;

/**
 * The protected object names a user who has no OneDrive provisioned (not
 * licensed, or never signed in). Retrying does not help; the directory should
 * show "no OneDrive" rather than a failing backup.
 */
export class OneDriveUnavailableError extends Error {
  constructor(
    readonly protectedObjectId: string,
    readonly externalId: string,
  ) {
    super(`no OneDrive is provisioned for ${externalId}`);
    this.name = "OneDriveUnavailableError";
  }
}

/** OneDrive for Business drive ids start with `b!`; anything else is treated as a user id or UPN. */
export function looksLikeDriveId(value: string): boolean {
  return value.startsWith("b!");
}

/**
 * Default drive resolution: `externalId` is either the drive id itself or the
 * user (id or UPN) whose drive is looked up through `/users/{id}/drive`.
 */
export const resolveOneDriveId: OneDriveIdResolver = async (client, protectedObject) => {
  const external = protectedObject.externalId;
  if (looksLikeDriveId(external)) {
    return external;
  }
  const drive = await getUserDrive(client, external);
  if (!drive) {
    throw new OneDriveUnavailableError(protectedObject.id, external);
  }
  return drive.id;
};

export const ONEDRIVE_BACKUP_DEFAULTS = {
  checkpointEveryItems: 500,
  checkpointEveryBytes: 512 * 1024 * 1024,
  checkpointMinIntervalMs: 60_000,
  /** Upper bound on failed item ids carried into the next run's retry list. */
  maxRetryIds: 1000,
} as const;

export interface OneDriveBackupEngineOptions<Db = unknown> {
  readonly graph: OneDriveGraphClientResolver<Db>;
  readonly resolveDriveId?: OneDriveIdResolver;
  /** Also store historical file versions (docs/MICROSOFT.md: extra Graph calls per file). */
  readonly includeVersions?: boolean;
  /** Checkpoint after this many processed items ... */
  readonly checkpointEveryItems?: number;
  /** ... or after this many downloaded bytes, whichever comes first ... */
  readonly checkpointEveryBytes?: number;
  /** ... but never more often than this. */
  readonly checkpointMinIntervalMs?: number;
  /** Failed items beyond this many make the next run enumerate the whole drive instead. */
  readonly maxRetryIds?: number;
  readonly maxPackBytes?: number;
  /** Injectable id generators (tests pin them). */
  readonly snapshotIdGenerator?: () => string;
  readonly packIdGenerator?: () => string;
}

/** Convenience for hosts that just want an engine instance for a client resolver. */
export function createOneDriveBackupEngine<Db = unknown>(
  graph: OneDriveGraphClientResolver<Db>,
  options: Omit<OneDriveBackupEngineOptions<Db>, "graph"> = {},
): OneDriveBackupEngine<Db> {
  return new OneDriveBackupEngine<Db>({ ...options, graph });
}

export class OneDriveBackupEngine<Db = unknown> implements BackupEngine<Db> {
  readonly kind = "onedrive" as const;
  private readonly settings: RunSettings;

  constructor(private readonly options: OneDriveBackupEngineOptions<Db>) {
    const defaults = ONEDRIVE_BACKUP_DEFAULTS;
    this.settings = {
      includeVersions: options.includeVersions ?? false,
      checkpointEveryItems: Math.max(
        1,
        options.checkpointEveryItems ?? defaults.checkpointEveryItems,
      ),
      checkpointEveryBytes: Math.max(
        1,
        options.checkpointEveryBytes ?? defaults.checkpointEveryBytes,
      ),
      checkpointMinIntervalMs: Math.max(
        0,
        options.checkpointMinIntervalMs ?? defaults.checkpointMinIntervalMs,
      ),
      maxRetryIds: Math.max(0, options.maxRetryIds ?? defaults.maxRetryIds),
    };
  }

  async run(
    ctx: JobContext<Db>,
    protectedObject: ProtectedObjectRef,
    options: BackupOptions,
  ): Promise<BackupResult> {
    if (protectedObject.kind !== this.kind) {
      throw new Error(
        `onedrive engine cannot back up a protected object of kind ${protectedObject.kind}`,
      );
    }
    const logger = ctx.logger.child({ engine: ENGINE_NAME, protectedObjectId: protectedObject.id });
    const client = await this.options.graph(ctx, protectedObject);
    const driveId = await (this.options.resolveDriveId ?? resolveOneDriveId)(
      client,
      protectedObject,
    );
    const resume = readCursor(await ctx.cursor.load(), driveId);

    // The context's Db parameter is opaque to core; the writer only uses the seams.
    const context = ctx as unknown as JobContext;
    const writer = await SnapshotWriter.begin(context, {
      protectedObject,
      sourceType: "m365",
      checkpoint: resume?.snapshot,
      maxPackBytes: this.options.maxPackBytes,
      snapshotIdGenerator: this.options.snapshotIdGenerator,
      packIdGenerator: this.options.packIdGenerator,
    });
    const resumed = resume !== null && writer.snapshotId === resume.snapshot?.snapshotId;
    const previous = await writer.loadPreviousManifest();
    const plan = planRun({
      full: options.full === true,
      includeVersions: this.settings.includeVersions,
      resume: resumed ? resume : null,
      previous: previous ? readManifestState(previous.state, driveId) : null,
    });

    logger.info("onedrive backup started", {
      driveId,
      sequence: writer.sequence,
      reason: plan.reason,
      mode: plan.start.mode,
      retries: plan.retryIds.length,
      versions: this.settings.includeVersions,
    });

    const run = new DriveBackupRun({
      ctx: context,
      client,
      driveId,
      writer,
      previous,
      plan,
      settings: this.settings,
      logger: logger.child({ driveId }),
      resumed,
      resumedDeletions: resumed ? readCheckpointDeletions(writer.state, driveId) : [],
    });
    return run.execute();
  }
}
