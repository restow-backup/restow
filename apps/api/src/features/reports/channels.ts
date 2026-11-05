import type { ChannelColumns } from "@restow/core";
import { channelColumnsOf as columnsOf } from "@restow/db";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * A tenant's channels and their columns in the notification matrix: the events each webhook and
 * each notification recipient gets, and how each recipient wants them (at once or in a digest;
 * plannedDeliveries leaves the others out). The worker reads the same through @restow/db
 * report-events.ts.
 */
export async function channelColumnsOf(db: DbExecutor, tenantId: string): Promise<ChannelColumns> {
  return columnsOf(db, tenantId);
}
