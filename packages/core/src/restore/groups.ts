/**
 * Restore of a Microsoft 365 group mailbox snapshot (protected object kind
 * `group`, backup/groups). The snapshot has a mailbox's layout, so the
 * Exchange restore does the work:
 *
 *   into another mailbox  (target `other`, a user's address) everything: the
 *                         group calendar's events into that user's calendars
 *                         (a restore calendar in rename mode), the
 *                         conversations as mail into a `Conversations` folder.
 *   into the group        (target `original`) the calendar events go back into
 *                         the group calendar; in rename mode as copies next to
 *                         what is there (a group has only one calendar), in
 *                         skip mode an event whose iCalUId exists is left
 *                         alone. Conversations cannot: Graph v1.0 refuses an
 *                         app to start a thread or reply (delegated only), so
 *                         every post is reported as not restorable, with the
 *                         ways that work (another mailbox, download, export).
 *
 * Downloads (EML, JSON) and exports (MBOX, PST) need nothing group-specific.
 * Graph documents creating group events as delegated only as well; if a
 * tenant refuses it to the app, each event fails with Graph's answer and the
 * restore into a user mailbox remains (docs/MICROSOFT.md, group mailboxes).
 */
import type { JobContext, RestoreEngine, RestoreRequest } from "../engine/types.js";
import type { RestoreGraphClientFactory } from "./common.js";
import { ExchangeRestoreEngine } from "./exchange.js";
import type { RestoreReport } from "./results.js";

export interface GroupRestoreEngineOptions {
  readonly graph: RestoreGraphClientFactory;
}

export class GroupRestoreEngine implements RestoreEngine {
  readonly kind = "group" as const;
  private readonly exchange: ExchangeRestoreEngine;

  constructor(options: GroupRestoreEngineOptions) {
    this.exchange = new ExchangeRestoreEngine({ graph: options.graph });
  }

  async run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport> {
    if (request.target.type === "download") {
      throw new Error("download restores are produced by the download engine");
    }
    if (request.target.type === "other") {
      return this.exchange.run(ctx, request);
    }
    return this.exchange.run(ctx, request, {
      group: { groupId: request.protectedObject.externalId },
    });
  }
}
