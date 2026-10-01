/**
 * Exchange Online restore: mail, calendar and contacts of a mailbox snapshot
 * back into a mailbox through Graph (docs/MICROSOFT.md, Exchange
 * restore).
 *
 * Mail      MIME is POSTed base64-encoded into the target folder; flags,
 *           categories and importance are PATCHed afterwards because a MIME
 *           import does not carry them. Messages backed up as parts (Graph
 *           refused the MIME export) are created from their JSON and get their
 *           attachments back one by one. A duplicate is detected by
 *           internetMessageId in the target folder before anything is imported,
 *           against what the folder held before this run wrote to it
 *           (./duplicates.ts: two backed-up messages may share one Message-ID).
 * Calendar  Events are POSTed from the backed-up JSON with a `transactionId`
 *           derived from the restore job, so a retried job cannot create the
 *           same event twice. Series exceptions are re-applied to the recreated
 *           series. Attendees are dropped unless asked for, because Exchange
 *           would send invitations.
 * Contacts  Contacts are POSTed from JSON into the recreated folder path.
 * Folders   Selected folders are recreated even when empty.
 *
 * A mailbox restore never replaces an original (docs/ARCHITECTURE.md,
 * Restore): nothing here is ever deleted, overwritten or moved. Where a
 * restored item lands depends on the mode:
 *   rename   below a fresh restore folder (mail, contacts) and restore
 *            calendars; the original stays untouched
 *   skip     original places; an existing duplicate is left alone
 * The API refuses a new restore request with mode "replace" for a mailbox
 * (apps/api/src/features/restore/service.ts); the `restore_mode` database
 * enum keeps the value for history, so a job queued before that change may
 * still carry it — this engine runs it exactly as "rename" instead and notes
 * that on every item outcome (restored, skipped as a duplicate, or failed),
 * so the downgrade is visible even when a legacy job restores nothing
 * (./common.ts, mailboxRestoreMode).
 * Original places are found by meaning, not by name: a message from the
 * source's "Posteingang" lands in the target's Inbox, whatever it is called.
 *
 * What a restore cannot bring back (conversation ids, some transport headers,
 * the original item ids) is documented; the report never pretends otherwise.
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type { Contact, Event, Message } from "@microsoft/microsoft-graph-types";
import type { ChunkReader } from "../engine/chunkstore.js";
import type { JobContext, Logger, RestoreEngine, RestoreRequest } from "../engine/types.js";
import type { GraphClient } from "../graph/client.js";
import { isGraphError } from "../graph/errors.js";
import {
  type CalendarInfo,
  createCalendar,
  createEvent,
  findOccurrenceByOriginalStart,
  getDefaultCalendar,
  listCalendars,
  sameInstant,
  toCreatableEvent,
  updateEvent,
} from "../graph/resources/calendar.js";
import { collect, odataString, paginate, query, userPath } from "../graph/resources/common.js";
import {
  createContact,
  ensureContactFolderPath,
  listContacts,
  toCreatableContact,
} from "../graph/resources/contacts.js";
import {
  WELL_KNOWN_FOLDER_NAMES,
  type WellKnownFolderName,
  type WellKnownFolders,
  addFileAttachment,
  createMessageFromJson,
  createMessageFromMime,
  ensureMailFolderPath,
  findMessagesByInternetMessageId,
  patchMessage,
  resolveWellKnownFolders,
  toCreatableMessage,
} from "../graph/resources/mail.js";
import type { ManifestObject } from "../manifest.js";
import {
  type FolderStep,
  type SnapshotCatalog,
  folderKindOf,
  isDefaultContactFolder,
  isMailRoot,
  splitAtAnchor,
} from "./catalog.js";
import {
  LEGACY_REPLACE_MODE_NOTE,
  type RestoreGraphClientFactory,
  chunkReaderFor,
  isRecord,
  mailboxRestoreMode,
  readJsonObject,
  restoreFolderNameFor,
  restoreRequestOptions,
  throwIfAborted,
} from "./common.js";
import {
  type CalendarFacts,
  attachmentFactsOf,
  messageFlagsOf,
  messageFormatOf,
  referenceAttachmentsOf,
} from "./conventions.js";
import { type DuplicateSlot, MessageIdDuplicates } from "./duplicates.js";
import {
  type RestoreItemCode,
  RestoreLedger,
  type RestoreReport,
  describeRestoreError,
  failureCodeOf,
  isAbortError,
} from "./results.js";
import { type RestorePlan, planRestore, resolveRestoreSource } from "./selection.js";

export interface ExchangeRestoreEngineOptions {
  readonly graph: RestoreGraphClientFactory;
}

/** Mailbox address (or user id) a restore writes into. */
export function targetMailboxOf(request: RestoreRequest): string {
  if (request.target.type === "download") {
    throw new Error("download restores are produced by the download engine");
  }
  if (request.target.type === "other") {
    const ref = request.target.ref?.trim();
    if (!ref) {
      throw new Error("a restore into another mailbox needs the target mailbox address");
    }
    return ref;
  }
  return request.protectedObject.externalId;
}

/**
 * Deterministic per-event `transactionId`: a retried POST of the same restore
 * job returns the event it created instead of a twin, while a second restore
 * of the same snapshot still creates its own copy.
 */
export function eventTransactionId(restoreJobId: string, object: ManifestObject): string {
  const digest = createHash("sha256")
    .update(`${restoreJobId}\n${object.id ?? object.path}`)
    .digest("hex");
  return `restow-${digest.slice(0, 40)}`;
}

export class ExchangeRestoreEngine implements RestoreEngine {
  readonly kind = "mailbox" as const;

  constructor(private readonly options: ExchangeRestoreEngineOptions) {}

  async run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport> {
    const userId = targetMailboxOf(request);
    const logger = ctx.logger.child({
      component: "restore-exchange",
      restoreJobId: request.restoreJobId,
      snapshotId: request.snapshotId,
    });
    const ledger = new RestoreLedger(ctx.progress);

    ctx.progress.phase("resolve");
    const { manifest } = await resolveRestoreSource(ctx, request);
    const plan = planRestore(manifest, request.selection);
    const { mode, legacyReplace } = mailboxRestoreMode(request.mode);
    if (legacyReplace) {
      logger.warn("restore job carries the discontinued mode 'replace'; running it as 'rename'", {
        restoreJobId: request.restoreJobId,
      });
    }
    const session = new ExchangeRestoreSession({
      ctx,
      client: await this.options.graph(ctx, request.protectedObject),
      userId,
      mode,
      legacyReplace,
      restoreJobId: request.restoreJobId,
      restoreFolderName: restoreFolderNameFor(ctx, request),
      keepAttendees: restoreRequestOptions(request).keepAttendees ?? false,
      catalog: plan.catalog,
      reader: chunkReaderFor(ctx),
      ledger,
      logger,
    });
    const folders = plan.folders.filter((folder) => !session.isStructural(folder));
    const expected = plan.objects.filter(
      (object) => !plan.folders.includes(object) || folders.includes(object),
    );
    ctx.progress.total(expected.length);
    logger.info("restore planned", {
      mail: plan.mail.length,
      events: plan.events.length,
      contacts: plan.contacts.length,
      folders: folders.length,
      target: request.target.type,
      mode,
    });

    await this.restorePlan(ctx, plan, folders, session, ledger);

    ledger.settle(expected);
    await ctx.progress.flush();
    const report = ledger.report();
    logger.info("restore finished", {
      restored: report.restored,
      skipped: report.skipped,
      failed: report.failures.length,
      unverified: report.unverified,
    });
    return report;
  }

  private async restorePlan(
    ctx: JobContext,
    plan: RestorePlan,
    folders: readonly ManifestObject[],
    session: ExchangeRestoreSession,
    ledger: RestoreLedger,
  ): Promise<void> {
    if (folders.length > 0) {
      ctx.progress.phase("folders");
      for (const folder of folders) {
        await session.restoreFolder(folder);
      }
    }
    if (plan.mail.length > 0 || plan.orphanAttachments.length > 0) {
      ctx.progress.phase("mail");
      const duplicates = new MessageIdDuplicates<string>(plan.mail, (message) =>
        JSON.stringify(plan.catalog.mailFolderChain(message)),
      );
      for (const message of plan.mail) {
        await session.restoreMessage(
          message,
          plan.attachmentsByMessage.get(message.path) ?? [],
          duplicates.slot(message),
        );
      }
      for (const attachment of plan.orphanAttachments) {
        ledger.skipped(
          attachment,
          "parent_not_restored",
          "an attachment is restored together with its message; select the message to restore it",
        );
      }
    }
    if (plan.events.length > 0) {
      ctx.progress.phase("calendar");
      for (const event of plan.events) {
        await session.restoreEvent(event);
      }
    }
    if (plan.contacts.length > 0) {
      ctx.progress.phase("contacts");
      for (const contact of plan.contacts) {
        await session.restoreContact(contact);
      }
    }
    for (const object of [...plan.files, ...plan.versions, ...plan.informational]) {
      ledger.failed(
        object,
        new Error("a drive item cannot be restored into a mailbox"),
        "wrong_target",
      );
    }
    for (const object of plan.unknown) {
      ledger.failed(
        object,
        new Error(`objects of type "${object.type ?? ""}" cannot be restored into a mailbox`),
        "not_restorable",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Session: one mailbox, one mode, shared caches

interface SessionOptions {
  readonly ctx: JobContext;
  readonly client: GraphClient;
  readonly userId: string;
  /** A mailbox restore only ever restores or skips; "replace" never reaches here. */
  readonly mode: "rename" | "skip";
  /** The stored request asked for the discontinued "replace" mode; ran as "rename" instead. */
  readonly legacyReplace: boolean;
  readonly restoreJobId: string;
  readonly restoreFolderName: string;
  readonly keepAttendees: boolean;
  readonly catalog: SnapshotCatalog;
  readonly reader: ChunkReader;
  readonly ledger: RestoreLedger;
  readonly logger: Logger;
}

/** The backed-up shape of a calendar item: a bare event or an event with its exceptions. */
interface CalendarItem {
  readonly event: Event;
  readonly exceptions: Event[];
}

function toCalendarItem(value: Record<string, unknown>): CalendarItem {
  if (isRecord(value.event)) {
    const exceptions = Array.isArray(value.exceptions)
      ? (value.exceptions.filter(isRecord) as Event[])
      : [];
    return { event: value.event as Event, exceptions };
  }
  return { event: value as Event, exceptions: [] };
}

type ExistingEvent = Pick<Event, "id" | "subject"> & { id: string };
type ExistingContact = Pick<Contact, "id" | "displayName" | "emailAddresses"> & { id: string };

/** A contact's duplicate key: display name plus first e-mail address, case-insensitive. */
function contactKey(contact: Pick<Contact, "displayName" | "emailAddresses">): string {
  const name = (contact.displayName ?? "").trim().toLowerCase();
  const email = (contact.emailAddresses?.[0]?.address ?? "").trim().toLowerCase();
  return name.length === 0 && email.length === 0 ? "" : `${name}|${email}`;
}

const WELL_KNOWN = new Set<string>(WELL_KNOWN_FOLDER_NAMES);

/** Graph refuses MIME imports above its request size limit; say what to do instead. */
function explainCreateFailure(error: unknown): unknown {
  if (
    isGraphError(error) &&
    (error.status === 413 || /too\s*large|exceed/i.test(`${error.code ?? ""} ${error.message}`))
  ) {
    return new Error(
      `Exchange refused the message as too large for an import through Graph (${error.message}); restore it as a download (EML) instead`,
    );
  }
  return error;
}

/** Where the message ended up, for the skip reasons of its attachments. */
type AttachmentRecorder = () => void;

export class ExchangeRestoreSession {
  private readonly folderCache = new Map<string, string>();
  private readonly contactFolderCache = new Map<string, string>();
  private wellKnown: WellKnownFolders | null = null;
  private calendars: CalendarInfo[] | null = null;
  private readonly calendarIds = new Map<string, string>();
  private readonly contactsByFolder = new Map<string, Map<string, ExistingContact>>();

  constructor(private readonly o: SessionOptions) {}

  private skipReason(what: string, where: string): string {
    return this.o.mode === "rename"
      ? `${what} was already restored into this ${where} (the job was retried)`
      : `${what} already exists in the target ${where}`;
  }

  /** Prepend {@link LEGACY_REPLACE_MODE_NOTE} for a job that asked for the discontinued "replace" mode. */
  private withLegacyReplaceNote(note: string | undefined): string | undefined {
    if (!this.o.legacyReplace) {
      return note;
    }
    return note ? `${LEGACY_REPLACE_MODE_NOTE}; ${note}` : LEGACY_REPLACE_MODE_NOTE;
  }

  /**
   * Same as {@link withLegacyReplaceNote}, for a reason that is never empty
   * (a skip). A legacy-replace job that skips or fails every item must still
   * say, somewhere, that it ran as "rename" instead of the "replace" it was
   * queued with.
   */
  private legacyNote(note: string): string {
    return this.o.legacyReplace ? `${LEGACY_REPLACE_MODE_NOTE}; ${note}` : note;
  }

  /**
   * Wrap a thrown error's message with {@link LEGACY_REPLACE_MODE_NOTE} for a
   * legacy-replace job, so a failed item's reason says so too — the note
   * would otherwise only ever reach an item this session actually restored.
   * Callers derive the failure code from the original error first: the
   * wrapper is a plain `Error` and would otherwise mis-classify a Graph or
   * integrity failure as a generic one.
   *
   * The cause comes first and the note after, using the raw message rather
   * than {@link describeRestoreError}: `RestoreLedger.failed` truncates the
   * reason to its own length limit once more when it calls
   * `describeRestoreError` on whatever this returns, and a cause-first
   * ordering means a long cause trims the (purely informational) note
   * instead of losing its own tail.
   */
  private legacyReplaceError(error: unknown): unknown {
    if (!this.o.legacyReplace) {
      return error;
    }
    const cause = error instanceof Error ? error.message : String(error);
    return new Error(`${cause} (${LEGACY_REPLACE_MODE_NOTE})`, { cause: error });
  }

  /** Folder objects that only give the snapshot its shape and have no counterpart to restore. */
  isStructural(folder: ManifestObject): boolean {
    const { catalog } = this.o;
    switch (folderKindOf(folder)) {
      case "mail":
        return isMailRoot(folder);
      case "contacts":
        return isDefaultContactFolder(folder);
      case "calendar":
        return this.calendarNameFor(catalog.calendarOf(folder)) === undefined;
      default:
        return true;
    }
  }

  // --- folders ------------------------------------------------------------

  async restoreFolder(folder: ManifestObject): Promise<void> {
    const { ctx, catalog, ledger } = this.o;
    throwIfAborted(ctx);
    try {
      let targetRef: string | null;
      switch (folderKindOf(folder)) {
        case "mail":
          targetRef = await this.mailFolderFor(catalog.mailFolderChain(folder));
          break;
        case "contacts":
          targetRef = await this.contactFolderFor(folder);
          break;
        default:
          targetRef = await this.calendarFor(catalog.calendarOf(folder));
      }
      ledger.restored(folder, { targetRef: targetRef ?? undefined, bytes: 0, verified: true });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      ledger.failed(folder, this.legacyReplaceError(error), failureCodeOf(error));
    }
  }

  // --- mail ---------------------------------------------------------------

  /**
   * Restore one message. `duplicates` is its slot in the run's Message-ID
   * bookkeeping (./duplicates.ts): the folder's copies are the ones it had
   * before this run wrote to it, and a retried rename-mode job counts each
   * copy it finds for one message only (Graph cannot compare content).
   */
  async restoreMessage(
    message: ManifestObject,
    attachments: readonly ManifestObject[],
    duplicates: DuplicateSlot<string>,
  ): Promise<void> {
    const { ctx, client, userId, ledger } = this.o;
    throwIfAborted(ctx);
    const skipAttachments = (reason: string): void => {
      for (const attachment of attachments) {
        ledger.skipped(attachment, "parent_not_restored", reason);
      }
    };

    const isJson = messageFormatOf(message) === "json";
    const messageId = duplicates.messageId;
    let created: Message & { id: string };
    try {
      const folderId = await this.mailFolderFor(this.o.catalog.mailFolderChain(message));
      const existing = await duplicates.existing(folderId, async (id) =>
        (await findMessagesByInternetMessageId(client, userId, id, { folderId })).map(
          (duplicate) => duplicate.id,
        ),
      );
      let earlier: string | undefined;
      if (existing.length > 0 && this.o.mode === "skip") {
        earlier = existing[0];
      } else if (existing.length > 0 && this.o.mode === "rename") {
        earlier = (await duplicates.claimEarlierCopy(async () => undefined))?.copy;
      }
      if (earlier !== undefined) {
        duplicates.settle();
        ledger.skipped(
          message,
          "exists",
          this.legacyNote(this.skipReason("a message with this Message-ID", "folder")),
          earlier,
        );
        skipAttachments("the message already exists in the target folder");
        return;
      }
      created = await this.importMessage(message, folderId, isJson);
      duplicates.wrote(folderId, created.id);
    } catch (error) {
      duplicates.settle();
      if (isAbortError(error)) {
        throw error;
      }
      // The code is derived from the original error (explainCreateFailure's
      // rewritten message would otherwise no longer read as, say, a Graph
      // refusal); the reason text carries the friendlier explanation instead.
      ledger.failed(
        message,
        this.legacyReplaceError(explainCreateFailure(error)),
        failureCodeOf(error),
      );
      skipAttachments("the message could not be restored");
      return;
    }

    const problems: string[] = [];
    const notes: string[] = [];
    try {
      await patchMessage(client, userId, created.id, messageFlagsOf(message));
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      problems.push(
        `read state, flag and categories were not applied: ${describeRestoreError(error)}`,
      );
    }

    const recorders: AttachmentRecorder[] = [];
    let attachmentFailures = 0;
    for (const attachment of attachments) {
      const outcome = await this.addAttachment(created.id, attachment, isJson);
      if (outcome.failed) {
        attachmentFailures++;
      }
      recorders.push(outcome.record);
    }
    if (attachmentFailures > 0) {
      problems.push(
        `${attachmentFailures} of ${attachments.length} attachments could not be added`,
      );
    }
    if (isJson && created.isDraft === true) {
      notes.push(
        "restored from the JSON fallback of an oversized message; Exchange shows it as a draft",
      );
    }
    const links = referenceAttachmentsOf(message);
    if (links.length > 0) {
      notes.push(
        `link attachments are listed in the backup but not re-created: ${links.join(", ")}`,
      );
    }
    if (messageId !== undefined && created.internetMessageId !== messageId) {
      problems.push("the Message-ID of the restored message differs from the backup");
    }
    duplicates.settle();

    ledger.restored(message, {
      targetRef: created.id,
      bytes: message.size,
      verified: problems.length > 0 ? false : messageId === undefined ? undefined : true,
      note: this.withLegacyReplaceNote([...problems, ...notes].join("; ") || undefined),
    });
    for (const record of recorders) {
      record();
    }
  }

  /**
   * Create a message from its backup. The backup is read (size and SHA-256
   * verified) and decoded before the request goes out, so a missing or
   * corrupt chunk never reaches the mailbox.
   */
  private async importMessage(
    message: ManifestObject,
    folderId: string,
    isJson: boolean,
  ): Promise<Message & { id: string }> {
    const { client, userId, reader } = this.o;
    const result = isJson
      ? await createMessageFromJson(
          client,
          userId,
          folderId,
          toCreatableMessage((await readJsonObject(reader, message)) as Message),
        )
      : await createMessageFromMime(
          client,
          userId,
          folderId,
          (await reader.readObjectToBuffer(message)).toString("base64"),
        );
    if (!result.id) {
      throw new Error("Graph created the message but returned no id");
    }
    return { ...result, id: result.id };
  }

  /** Attach one backed-up attachment; the ledger entry is recorded after the message's. */
  private async addAttachment(
    messageGraphId: string,
    attachment: ManifestObject,
    ownerIsJson: boolean,
  ): Promise<{ failed: boolean; record: AttachmentRecorder }> {
    const { ctx, client, userId, reader, ledger } = this.o;
    throwIfAborted(ctx);
    const skip = (code: Exclude<RestoreItemCode, "restored" | "unverified">, reason: string) => ({
      failed: false,
      record: () => ledger.skipped(attachment, code, reason),
    });
    if (!ownerIsJson) {
      return skip("exists", "contained in the restored message's MIME");
    }
    const facts = attachmentFactsOf(attachment);
    if (facts.kind === "reference") {
      return skip(
        "not_restorable",
        "link attachments (reference attachments) are kept in the backup but not re-created",
      );
    }
    const isItem = facts.kind === "item";
    const name =
      isItem && !/\.[A-Za-z0-9]{1,8}$/.test(facts.name) ? `${facts.name}.eml` : facts.name;
    let stream: Readable | null = null;
    try {
      stream = reader.objectStream(attachment);
      const added = await addFileAttachment(
        client,
        userId,
        messageGraphId,
        {
          name,
          contentType:
            facts.contentType ?? (isItem ? "message/rfc822" : "application/octet-stream"),
          size: attachment.size,
          isInline: facts.isInline,
          contentId: facts.contentId,
        },
        stream,
      );
      return {
        failed: false,
        record: () =>
          ledger.restored(attachment, {
            targetRef: added.id,
            bytes: attachment.size,
            note: isItem ? "an attached item is restored as a message file (.eml)" : undefined,
          }),
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      return {
        failed: true,
        record: () =>
          ledger.failed(attachment, this.legacyReplaceError(error), failureCodeOf(error)),
      };
    } finally {
      stream?.destroy();
    }
  }

  /**
   * The mail folder for a folder chain, created on demand: below the restore
   * folder in rename mode, otherwise anchored on the target's own well-known
   * folder (Inbox, Sent Items, ...) where the source recorded one.
   */
  async mailFolderFor(chain: readonly FolderStep[]): Promise<string> {
    const { client, userId } = this.o;
    const options = { cache: this.folderCache };
    const { anchor, below, names } = splitAtAnchor(chain);
    if (this.o.mode === "rename") {
      return ensureMailFolderPath(client, userId, [this.o.restoreFolderName, ...names], options);
    }
    if (anchor !== undefined) {
      const anchorId = await this.wellKnownFolderId(anchor);
      if (anchorId !== undefined) {
        return below.length === 0
          ? anchorId
          : ensureMailFolderPath(client, userId, [...below], {
              ...options,
              parentFolderId: anchorId,
            });
      }
    }
    if (names.length === 0) {
      return (
        (await this.wellKnownFolderId("inbox")) ??
        ensureMailFolderPath(client, userId, ["Inbox"], options)
      );
    }
    return ensureMailFolderPath(client, userId, [...names], options);
  }

  private async wellKnownFolderId(name: string): Promise<string | undefined> {
    if (!WELL_KNOWN.has(name)) {
      return undefined;
    }
    if (!this.wellKnown) {
      this.wellKnown = await resolveWellKnownFolders(this.o.client, this.o.userId);
    }
    return this.wellKnown.byName.get(name as WellKnownFolderName);
  }

  // --- calendar -----------------------------------------------------------

  async restoreEvent(object: ManifestObject): Promise<void> {
    const { ctx, client, userId, reader, ledger } = this.o;
    throwIfAborted(ctx);
    try {
      const item = toCalendarItem(await readJsonObject(reader, object));
      const calendarId = await this.calendarFor(this.o.catalog.calendarOf(object));

      const uid = item.event.iCalUId ?? undefined;
      if (uid !== undefined && this.o.mode === "skip") {
        const existing = await this.findEventsByICalUId(calendarId, uid);
        if (existing.length > 0) {
          ledger.skipped(
            object,
            "exists",
            this.legacyNote(this.skipReason("an event with this iCalUId", "calendar")),
            existing[0]?.id,
          );
          return;
        }
      }

      const body: Partial<Event> & { transactionId: string } = {
        ...toCreatableEvent(item.event, { keepAttendees: this.o.keepAttendees }),
        transactionId: eventTransactionId(this.o.restoreJobId, object),
      };
      const created = await createEvent(client, userId, calendarId, body);
      if (!created.id) {
        throw new Error("Graph created the event but returned no id");
      }

      let unapplied = 0;
      for (const exception of item.exceptions) {
        try {
          if (!(await this.applyException(created.id, exception))) {
            unapplied++;
          }
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          unapplied++;
        }
      }
      const problems: string[] = [];
      if (unapplied > 0) {
        problems.push(
          `${unapplied} of ${item.exceptions.length} changed occurrences of the series could not be re-applied`,
        );
      }
      const matches =
        created.subject === item.event.subject &&
        (item.event.start?.dateTime === undefined ||
          (created.start?.dateTime !== undefined &&
            sameInstant(created.start.dateTime, item.event.start.dateTime)));
      if (!matches) {
        problems.push("subject or start of the restored event differs from the backup");
      }
      const notes =
        !this.o.keepAttendees && (item.event.attendees?.length ?? 0) > 0
          ? ["attendees were not invited again; the list is kept in the backup"]
          : [];
      ledger.restored(object, {
        targetRef: created.id,
        bytes: object.size,
        verified: problems.length === 0,
        note: this.withLegacyReplaceNote([...problems, ...notes].join("; ") || undefined),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      ledger.failed(object, this.legacyReplaceError(error), failureCodeOf(error));
    }
  }

  /** Re-apply a backed-up exception to the matching occurrence of the recreated series. */
  private async applyException(masterId: string, exception: Event): Promise<boolean> {
    const { client, userId } = this.o;
    const originalStart = exception.originalStart ?? exception.start?.dateTime;
    if (!originalStart) {
      return false;
    }
    const occurrence = await findOccurrenceByOriginalStart(client, userId, masterId, originalStart);
    if (!occurrence?.id) {
      return false;
    }
    const { recurrence: _recurrence, ...patch } = toCreatableEvent(exception, {
      keepAttendees: this.o.keepAttendees,
    });
    await updateEvent(client, userId, occurrence.id, patch);
    return true;
  }

  /**
   * The target calendar's display name, or undefined for the default
   * calendar. Rename mode never writes into an existing calendar: the default
   * calendar's events go to a calendar named like the restore folder, other
   * calendars' to `<restore folder> (<calendar>)`.
   */
  private calendarNameFor(facts: CalendarFacts): string | undefined {
    if (this.o.mode !== "rename") {
      return facts.isDefault || facts.name === undefined ? undefined : facts.name;
    }
    return facts.isDefault || facts.name === undefined
      ? this.o.restoreFolderName
      : `${this.o.restoreFolderName} (${facts.name})`;
  }

  /** The id of the calendar an event (or calendar folder) goes into, created on demand. */
  async calendarFor(facts: CalendarFacts): Promise<string> {
    const { client, userId } = this.o;
    const wanted = this.calendarNameFor(facts);
    const key = wanted?.toLowerCase() ?? "";
    const cached = this.calendarIds.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let id: string;
    if (wanted === undefined) {
      id = (await getDefaultCalendar(client, userId)).id;
    } else {
      if (!this.calendars) {
        this.calendars = await collect(listCalendars(client, userId));
      }
      const found = this.calendars.find((calendar) => (calendar.name ?? "").toLowerCase() === key);
      id = found ? found.id : (await createCalendar(client, userId, wanted)).id;
    }
    this.calendarIds.set(key, id);
    return id;
  }

  private async findEventsByICalUId(calendarId: string, uid: string): Promise<ExistingEvent[]> {
    const url = `${userPath(this.o.userId)}/calendars/${encodeURIComponent(calendarId)}/events${query(
      {
        $filter: `iCalUId eq ${odataString(uid)}`,
        $select: "id,subject",
      },
    )}`;
    return collect(paginate<ExistingEvent>(this.o.client, url));
  }

  // --- contacts -----------------------------------------------------------

  async restoreContact(object: ManifestObject): Promise<void> {
    const { ctx, client, userId, reader, ledger } = this.o;
    throwIfAborted(ctx);
    try {
      const contact = (await readJsonObject(reader, object)) as Contact;
      const folderId = await this.contactFolderFor(object);

      const key = contactKey(contact);
      if (key.length > 0) {
        const duplicate = (await this.existingContacts(folderId)).get(key);
        if (duplicate) {
          ledger.skipped(
            object,
            "exists",
            this.legacyNote(
              this.skipReason("a contact with this name and e-mail address", "folder"),
            ),
            duplicate.id,
          );
          return;
        }
      }

      const created = await createContact(client, userId, folderId, toCreatableContact(contact));
      if (!created.id) {
        throw new Error("Graph created the contact but returned no id");
      }
      const createdId = created.id;
      if (key.length > 0) {
        this.contactsByFolder.get(folderId ?? "")?.set(key, { ...created, id: createdId });
      }
      const verified = contactKey(created) === key;
      ledger.restored(object, {
        targetRef: createdId,
        bytes: object.size,
        verified,
        note: this.withLegacyReplaceNote(
          verified
            ? undefined
            : "name or e-mail address of the restored contact differs from the backup",
        ),
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      ledger.failed(object, this.legacyReplaceError(error), failureCodeOf(error));
    }
  }

  /** The contact folder of a contact or contact folder object; `null` is the default folder. */
  async contactFolderFor(object: ManifestObject): Promise<string | null> {
    const names = this.o.catalog.contactFolderNames(object);
    const path = this.o.mode === "rename" ? [this.o.restoreFolderName, ...names] : names;
    return ensureContactFolderPath(this.o.client, this.o.userId, path, {
      cache: this.contactFolderCache,
    });
  }

  private async existingContacts(folderId: string | null): Promise<Map<string, ExistingContact>> {
    const cacheKey = folderId ?? "";
    const cached = this.contactsByFolder.get(cacheKey);
    if (cached) {
      return cached;
    }
    const index = new Map<string, ExistingContact>();
    for await (const contact of listContacts(this.o.client, this.o.userId, folderId)) {
      const key = contactKey(contact);
      if (contact.id && key.length > 0 && !index.has(key)) {
        index.set(key, { ...contact, id: contact.id });
      }
    }
    this.contactsByFolder.set(cacheKey, index);
    return index;
  }
}
