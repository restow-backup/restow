/**
 * GroupMailboxBackupEngine: the `group` backup engine. One run produces one
 * snapshot of the group mailbox of a Microsoft 365 group or team:
 *
 *   calendar/<Calendar>/<Subject>.<id>.json     the group calendar, exactly as a
 *                                               user's (../exchange/calendar.ts)
 *   mail/Conversations/<Topic>.<id>.eml         every post of the group
 *                                               conversations (./conversations.ts)
 *
 * It is the Exchange engine's run (../exchange/run.ts) with a group as the
 * calendar owner: the same object index, checkpoints, carry-forward and item
 * failure rules, the same layout and metadata, so restore, the explorer, the
 * restore check and retention treat a group snapshot like a mailbox snapshot.
 *
 * Whole-object failures: a group that no longer exists (404 on the group
 * itself) fails the run with {@link GroupUnavailableError}; the directory sync
 * orphans it. A calendar or conversations listing the app may not read is
 * one item failure each (a warning), so a tenant without the needed consent
 * still gets what Graph does hand out.
 */
import { chunkDataStats, JobAbortedError } from "../../engine/chunkstore.js";
import { SnapshotWriter } from "../../engine/snapshot.js";
import type {
  BackupEngine,
  BackupOptions,
  JobContext,
  ProtectedObjectRef,
} from "../../engine/types.js";
import { buildCause } from "../../failures/classify.js";
import type { FailureCause } from "../../failures/types.js";
import type { GraphClient } from "../../graph/client.js";
import { isNotFound } from "../../graph/errors.js";
import { defaultInstanceWindow, type InstanceWindow } from "../../graph/resources/calendar.js";
import { type GroupMailboxInfo, getGroupMailbox } from "../../graph/resources/groups.js";
import { backupCalendar } from "../exchange/calendar.js";
import type { ExchangeBackupResult } from "../exchange/engine.js";
import {
  DEFAULT_EXCHANGE_CHECKPOINT_BYTES,
  DEFAULT_EXCHANGE_CHECKPOINT_ITEMS,
} from "../exchange/engine.js";
import { folderObjectAt } from "../exchange/folders.js";
import { CALENDAR_ROOT } from "../exchange/paths.js";
import { BackupRun, EXCHANGE_PHASES, isMailboxAccessError, META } from "../exchange/run.js";
import { type ExchangeState, parseCursor, readState, serializeState } from "../exchange/state.js";
import { backupConversations } from "./conversations.js";

/** Builds (or looks up) the throttled Graph client for the group's tenant. */
export type GroupGraphClientFactory<Db = unknown> = (
  ctx: JobContext<Db>,
  protectedObject: ProtectedObjectRef,
) => Promise<GraphClient> | GraphClient;

export interface GroupMailboxBackupEngineOptions<Db = unknown> {
  readonly graph: GroupGraphClientFactory<Db>;
  /** Instance window for series exceptions; defaults to one year back, two ahead. */
  readonly calendarWindow?: (now: Date) => InstanceWindow;
  /** The `calendarView` fallback's range (see graph/resources/calendar.ts). */
  readonly calendarViewWindow?: (now: Date) => InstanceWindow;
  readonly includeCalendar?: boolean;
  readonly includeConversations?: boolean;
  readonly checkpointEveryItems?: number;
  readonly checkpointEveryBytes?: number;
  readonly maxPackBytes?: number;
  readonly snapshotIdGenerator?: () => string;
  readonly packIdGenerator?: () => string;
}

/**
 * The group no longer exists (deleted, or its team removed). Retrying does
 * not help; the directory marks it orphaned on its next sync, and its
 * restore points stay.
 */
export class GroupUnavailableError extends Error {
  /** Read by the failure classifier (failures/classify.ts). */
  readonly failure: FailureCause;

  constructor(
    readonly protectedObjectId: string,
    readonly externalId: string,
  ) {
    super(`the Microsoft 365 group ${externalId} no longer exists`);
    this.name = "GroupUnavailableError";
    this.failure = buildCause(
      "graph.group_unavailable",
      { resource: "groups" },
      {
        message: this.message,
      },
    );
  }
}

export class GroupMailboxBackupEngine<Db = unknown> implements BackupEngine<Db> {
  readonly kind = "group" as const;

  constructor(private readonly options: GroupMailboxBackupEngineOptions<Db>) {}

  async run(
    ctx: JobContext<Db>,
    protectedObject: ProtectedObjectRef,
    options: BackupOptions = {},
  ): Promise<ExchangeBackupResult> {
    if (protectedObject.kind !== "group") {
      throw new Error(
        `GroupMailboxBackupEngine handles group mailboxes, not ${protectedObject.kind} (${protectedObject.id})`,
      );
    }
    const logger = ctx.logger.child({
      component: "group-backup",
      protectedObjectId: protectedObject.id,
    });
    const full = options.full === true;
    const client = await this.options.graph(ctx, protectedObject);
    const groupId = protectedObject.externalId;

    let group: GroupMailboxInfo;
    try {
      group = await getGroupMailbox(client, groupId);
    } catch (error) {
      if (isNotFound(error)) {
        throw new GroupUnavailableError(protectedObject.id, groupId);
      }
      throw error;
    }

    const cursor = parseCursor(await ctx.cursor.load());
    const writer = await SnapshotWriter.begin(ctx, {
      protectedObject,
      sourceType: "m365",
      checkpoint: cursor.checkpoint,
      maxPackBytes: this.options.maxPackBytes,
      snapshotIdGenerator: this.options.snapshotIdGenerator,
      packIdGenerator: this.options.packIdGenerator,
    });
    const resumed =
      cursor.checkpoint !== undefined && cursor.checkpoint.snapshotId === writer.snapshotId;
    const firstBackup = (await ctx.snapshots.latestCompleted(protectedObject.id)) === null;

    const run = new BackupRun({
      ctx,
      client,
      userId: groupId,
      owner: { groupId },
      writer,
      full,
      firstBackup,
      state: await initialState(writer, resumed),
      progress: resumed
        ? cursor.progress
        : {
            completedFolders: [],
            calendarDone: false,
            contactsDone: true,
            conversationsDone: false,
          },
      deltaTokens: {},
      checkpoints: {
        everyItems: Math.max(
          1,
          this.options.checkpointEveryItems ?? DEFAULT_EXCHANGE_CHECKPOINT_ITEMS,
        ),
        everyBytes: Math.max(
          1,
          this.options.checkpointEveryBytes ?? DEFAULT_EXCHANGE_CHECKPOINT_BYTES,
        ),
      },
    });
    logger.info("group mailbox backup started", {
      sequence: writer.sequence,
      resumed,
      full,
      inherited: writer.objectCount,
    });

    try {
      if (!run.writer.has(CALENDAR_ROOT)) {
        run.index.put(folderObjectAt(CALENDAR_ROOT, undefined, { [META.folderKind]: "root" }));
      }
      if (this.options.includeCalendar ?? true) {
        const now = ctx.now();
        const window = (this.options.calendarWindow ?? defaultInstanceWindow)(now);
        await backupCalendar(run, {
          window,
          ...(this.options.calendarViewWindow
            ? { viewWindow: this.options.calendarViewWindow(now) }
            : {}),
        });
      }
      if (this.options.includeConversations ?? true) {
        await backupConversations(run, {
          groupId,
          group: { displayName: group.displayName ?? null, mail: group.mail ?? null },
        });
      }

      run.report(EXCHANGE_PHASES.commit);
      writer.setState(serializeState(run.state));
      const committed = await writer.commit();
      await ctx.cursor.clear();
      await ctx.progress.flush();

      const result: ExchangeBackupResult = {
        snapshotId: committed.snapshotId,
        sequence: committed.sequence,
        objectsWritten: run.counters.written + run.counters.updated,
        objectsTotal: committed.itemCount,
        bytes: writer.chunks.stats.bytesNew,
        failures: [...run.failures],
        chunkStats: chunkDataStats(writer.chunks.stats),
        resumed,
        counters: { ...run.counters },
      };
      logger.info("group mailbox backup committed", {
        sequence: result.sequence,
        objects: result.objectsTotal,
        ...run.counters,
        newBytes: result.bytes,
      });
      return result;
    } catch (error) {
      if (isMailboxAccessError(error)) {
        logger.error("group mailbox is not accessible, snapshot abandoned", { error });
        await writer.abort();
        await ctx.cursor.clear();
        throw error;
      }
      const reason = error instanceof JobAbortedError ? "aborted" : "failed";
      logger.warn(`group mailbox backup ${reason}, checkpointing`, { error });
      try {
        await run.checkpoint();
      } catch (checkpointError) {
        logger.error("checkpoint after failure did not succeed", { error: checkpointError });
      }
      throw error;
    }
  }
}

/** The partial's own state when resuming, the previous snapshot's otherwise (objects inherited). */
async function initialState(writer: SnapshotWriter, resumed: boolean): Promise<ExchangeState> {
  if (resumed) {
    return readState(writer.state);
  }
  const previous = await writer.loadPreviousManifest();
  if (!previous) {
    return readState(undefined);
  }
  writer.inherit(previous);
  return readState(previous.state);
}

/** Convenience for hosts that just want an engine instance for a client factory. */
export function createGroupMailboxBackupEngine<Db = unknown>(
  graph: GroupGraphClientFactory<Db>,
  options: Omit<GroupMailboxBackupEngineOptions<Db>, "graph"> = {},
): GroupMailboxBackupEngine<Db> {
  return new GroupMailboxBackupEngine<Db>({ ...options, graph });
}
