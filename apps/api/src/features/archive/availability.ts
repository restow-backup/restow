/**
 * Whether the archive is offered to a tenant's administrators (#48, docs/ARCHIVE.md
 * "Eintrag „Archiv“ im Menü"): the menu entry "Archive" and the restore explorer's source
 * "From the archive" show only then.
 *
 * Offered means: the archive holds mail of the tenant, or the edition includes a capture
 * (the gates `archive.mailboxCapture` or `archive.smtpCapture`) and a mail job of the tenant
 * archives. An archive that holds mail stays reachable whatever the edition says now
 * (a file import with "archive at the same time" works in every edition, a licence may
 * change): archived mail must remain searchable and provable. Read from two `exists`
 * lookups on indexed columns; nothing is counted.
 */
import { archiveItems, backupJobs } from "@restow/db";
import { and, eq, sql } from "drizzle-orm";
import { featureEnabled } from "../../lib/features.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";

export interface ArchiveAvailability {
  /** The edition includes a capture (Graph, IMAP, journaling or forwarded copies). */
  readonly available: boolean;
  /** A mail job of the tenant archives (any way chosen, or the choice still pending). */
  readonly captureActive: boolean;
  /** The archive holds at least one item of the tenant. */
  readonly hasItems: boolean;
  /** What the menu and the explorer go by. */
  readonly offered: boolean;
}

/** The rule on its own, for the tests and the docs. */
export function isArchiveOffered(
  state: Pick<ArchiveAvailability, "available" | "captureActive" | "hasItems">,
): boolean {
  return state.hasItems || (state.available && state.captureActive);
}

export async function archiveAvailability(
  db: DbExecutor,
  tenantId: string,
  installation?: DbExecutor,
): Promise<ArchiveAvailability> {
  const [mailbox, smtp] = await Promise.all([
    featureEnabled("archive.mailboxCapture", installation),
    featureEnabled("archive.smtpCapture", installation),
  ]);
  const available = mailbox || smtp;
  const { hasItems, captureActive } = await withTenantTx(db, tenantId, async (tx) => {
    const [items] = await tx
      .select({ found: sql<boolean>`true` })
      .from(archiveItems)
      .where(eq(archiveItems.tenantId, tenantId))
      .limit(1);
    const [job] = await tx
      .select({ found: sql<boolean>`true` })
      .from(backupJobs)
      .where(
        and(
          eq(backupJobs.tenantId, tenantId),
          eq(backupJobs.kind, "mail"),
          eq(backupJobs.archive, true),
        ),
      )
      .limit(1);
    return { hasItems: items !== undefined, captureActive: job !== undefined };
  });
  return {
    available,
    captureActive,
    hasItems,
    offered: isArchiveOffered({ available, captureActive, hasItems }),
  };
}
