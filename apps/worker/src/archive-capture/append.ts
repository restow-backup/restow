/**
 * The capture ways' way into the archive: one captured mail through @restow/core's
 * `captureArchiveItem` on the Postgres store (packages/db `PgArchiveAppendStore`).
 *
 * The mail is parsed for search (envelope from its headers, subject, body text, date) in
 * the isolated parser process the import uses; duplicates across ways are merged (a mail
 * the archive already holds at least as strongly becomes a capture row on that item); a
 * mail received before its stream went live is flagged `captured-late`.
 */
import {
  archive,
  type ChunkIndex,
  type Logger,
  mailfiles,
  type StorageTargets,
  type TenantKeyring,
} from "@restow/core";
import {
  capturedExternalRefs,
  capturedMessageKeys,
  type Database,
  PgArchiveAppendStore,
} from "@restow/db";
import { withTenantTx } from "../handlers/framework.js";
import type { CapturedMail, CaptureStream } from "./ways.js";

export interface CaptureAppendDeps {
  readonly db: Database;
  readonly tenantId: string;
  readonly storage: StorageTargets;
  readonly keys: TenantKeyring;
  readonly index: ChunkIndex;
  readonly retentionPolicy: archive.RetentionPolicy;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}

/** The store of `tenantId`'s archive appends, as core's interface (checked here at compile time). */
export function archiveAppendStore(db: Database, tenantId: string): archive.ArchiveAppendStore {
  return new PgArchiveAppendStore(db, tenantId);
}

/** Whether a mail the service received at `received` is captured late for `stream`. */
export function capturedLate(
  stream: Pick<CaptureStream, "activatedAt">,
  received: Date | null | undefined,
): boolean {
  return (
    stream.activatedAt !== null &&
    received !== null &&
    received !== undefined &&
    received.getTime() < stream.activatedAt.getTime()
  );
}

/** Archive one mail a capture way found in `stream`'s mailbox. */
export async function appendCapturedMail(
  deps: CaptureAppendDeps,
  stream: Pick<CaptureStream, "protectedObjectId" | "way" | "activatedAt">,
  mail: CapturedMail,
): Promise<archive.CaptureArchiveItemResult> {
  const fields = await mailfiles.extractArchiveFields(mail.original, {
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const flags: archive.ArchiveFlag[] = [...(mail.flags ?? [])];
  if (capturedLate(stream, mail.receivedByService) && !flags.includes("captured-late")) {
    flags.push("captured-late");
  }
  return archive.captureArchiveItem({
    tenantId: deps.tenantId,
    storage: deps.storage,
    keys: deps.keys,
    index: deps.index,
    store: archiveAppendStore(deps.db, deps.tenantId),
    original: mail.original,
    source: stream.way,
    receivedAt: deps.now(),
    envelope: fields.envelope,
    flags,
    messageId: fields.messageId,
    metadata: {
      subject: fields.subject,
      bodyText: fields.bodyText,
      hasAttachment: fields.hasAttachment,
      sentAt: fields.sentAt,
    },
    retentionPolicy: deps.retentionPolicy,
    protectedObjectId: stream.protectedObjectId,
    externalRef: mail.externalRef,
    duplicates: "merge",
    now: deps.now,
    logger: deps.logger,
  });
}

/** Which refs and Message-IDs the archive already holds for a mailbox. */
export async function alreadyCapturedFor(
  db: Database,
  tenantId: string,
  protectedObjectId: string,
  query: { readonly externalRefs?: readonly string[]; readonly messageIds?: readonly string[] },
): Promise<{ externalRefs: Set<string>; messageKeys: Set<string> }> {
  const keys = [
    ...new Set(
      (query.messageIds ?? [])
        .map((id) => archive.messageKey(id))
        .filter((key): key is string => key !== null),
    ),
  ];
  return withTenantTx(db, tenantId, async (tx) => ({
    externalRefs: await capturedExternalRefs(tx, protectedObjectId, query.externalRefs ?? []),
    messageKeys: await capturedMessageKeys(tx, tenantId, protectedObjectId, keys),
  }));
}
