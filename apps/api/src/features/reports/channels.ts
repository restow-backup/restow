import type { ChannelColumns } from "@restow/core";
import { tenantNotificationRecipients, webhooks } from "@restow/db";
import { eq } from "drizzle-orm";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * A tenant's channels and their columns in the notification matrix: the events each webhook and
 * each notification recipient gets (plannedDeliveries leaves the others out). The worker reads
 * the same in apps/worker/src/reporting.ts.
 */
export async function channelColumnsOf(db: DbExecutor, tenantId: string): Promise<ChannelColumns> {
  const hooks = await db
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(eq(webhooks.tenantId, tenantId));
  const recipients = await db
    .select({
      email: tenantNotificationRecipients.email,
      events: tenantNotificationRecipients.events,
    })
    .from(tenantNotificationRecipients)
    .where(eq(tenantNotificationRecipients.tenantId, tenantId));
  return {
    webhooks: new Map(hooks.map((hook) => [hook.id, hook.events])),
    recipients: new Map(
      recipients.map((recipient) => [recipient.email.trim().toLowerCase(), recipient.events]),
    ),
  };
}
