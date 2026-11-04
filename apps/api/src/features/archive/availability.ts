/**
 * Whether the archive is offered to a tenant's administrators (#48, docs/ARCHIVE.md
 * "Eintrag „Archiv“ im Menü"): the menu entry "Archive" and the restore explorer's source
 * "From the archive" show only then.
 *
 * Offered means: the archive holds mail of the tenant, or the edition includes a capture
 * (the gates `archive.mailboxCapture` or `archive.smtpCapture`) and a capture is set up in
 * the tenant: a mail job archives, the journal address was issued or confirmed from 0.5.0 on
 * (Exchange journaling or forwarded copies, `tenants.journal_address_issued_at`), an account
 * has an active forwarding address (`archive_forward_addresses`), or a capture stream is not
 * switched off (`archive_capture_streams`). Journaling set up before its first report arrives
 * counts: the address is issued only where journaling is set up (the Archive page, the job
 * editor with Exchange journaling chosen; the tenant page reads the journal host alone). An
 * address alone (`tenants.journal_token`) does not: up to 0.4.12 the tenant page issued it on
 * its first view, also where nobody set up journaling, and migration 0075 leaves the issue time
 * of those empty. Such an address counts once a report arrived (the archive holds mail), a job
 * archives, or the journal setup is opened again. An archive
 * that holds mail stays reachable whatever the edition says now (a file import with
 * "archive at the same time" works in every edition, a licence may change): archived mail
 * must remain searchable and provable. Read from `exists` lookups
 * on indexed columns in one statement; nothing is counted.
 */
import {
  archiveCaptureStreams,
  archiveForwardAddresses,
  archiveItems,
  backupJobs,
  tenants,
} from "@restow/db";
import { and, eq, isNotNull, isNull, ne, type SQLWrapper, sql } from "drizzle-orm";
import { featureEnabled } from "../../lib/features.js";
import { type DbExecutor, withTenantTx } from "../../lib/tenant-context.js";

export interface ArchiveAvailability {
  /** The edition includes a capture (Graph, IMAP, journaling or forwarded copies). */
  readonly available: boolean;
  /**
   * A capture is set up: a mail job archives (any way chosen, or the choice still pending),
   * the journal address was issued from 0.5.0 on, a forwarding address is active, or a
   * capture stream runs.
   */
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
    const found = (query: SQLWrapper) => sql<boolean>`exists (${query})`;
    const [row] = await tx
      .select({
        hasItems: found(
          tx
            .select({ one: sql`1` })
            .from(archiveItems)
            .where(eq(archiveItems.tenantId, tenantId))
            .limit(1),
        ),
        archivingJob: found(
          tx
            .select({ one: sql`1` })
            .from(backupJobs)
            .where(
              and(
                eq(backupJobs.tenantId, tenantId),
                eq(backupJobs.kind, "mail"),
                eq(backupJobs.archive, true),
              ),
            )
            .limit(1),
        ),
        journalAddress: found(
          tx
            .select({ one: sql`1` })
            .from(tenants)
            .where(
              and(
                eq(tenants.id, tenantId),
                isNotNull(tenants.journalToken),
                isNotNull(tenants.journalAddressIssuedAt),
              ),
            )
            .limit(1),
        ),
        forwardAddress: found(
          tx
            .select({ one: sql`1` })
            .from(archiveForwardAddresses)
            .where(
              and(
                eq(archiveForwardAddresses.tenantId, tenantId),
                isNull(archiveForwardAddresses.revokedAt),
              ),
            )
            .limit(1),
        ),
        stream: found(
          tx
            .select({ one: sql`1` })
            .from(archiveCaptureStreams)
            .where(
              and(
                eq(archiveCaptureStreams.tenantId, tenantId),
                ne(archiveCaptureStreams.status, "disabled"),
              ),
            )
            .limit(1),
        ),
      })
      .from(sql`(select 1) as "one"`);
    return {
      hasItems: row?.hasItems === true,
      captureActive:
        row?.archivingJob === true ||
        row?.journalAddress === true ||
        row?.forwardAddress === true ||
        row?.stream === true,
    };
  });
  return {
    available,
    captureActive,
    hasItems,
    offered: isArchiveOffered({ available, captureActive, hasItems }),
  };
}
