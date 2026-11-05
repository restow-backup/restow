/**
 * Exchange Online restore: mail, calendar and contacts of a mailbox snapshot
 * back into a mailbox through Graph (docs/MICROSOFT.md, Exchange
 * restore).
 *
 * Mail      MIME is POSTed base64-encoded into the target folder; flags,
 *           categories and importance are PATCHed afterwards because a MIME
 *           import does not carry them. Graph refuses a request over 4 MB, so
 *           a MIME whose base64 is larger than MIME_IMPORT_LIMIT_BASE64_BYTES
 *           is created from its header and body as JSON (./mime-parts.ts) and
 *           its attachments are added one by one (upload sessions from 3 MB).
 *           Messages backed up as parts (Graph refused the MIME export) are
 *           created from their JSON and get their attachments back one by one. A duplicate is detected by
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
 * A POST is never sent twice blindly: when Graph's answer is lost
 * (isWriteOutcomeUnknown: 502/504, a timeout, a broken connection) the item
 * may exist all the same, or appear a minute later (the mailbox may still be
 * working on it when the gateway gives up), so the engine looks for it for
 * about two minutes (./common.ts, UNKNOWN_OUTCOME_LOOKS_MS) before anything
 * is sent again (a message by Message-ID, a folder by name, an attachment by
 * name and size, a contact by name and address) and keeps what it finds. What
 * was sent again is looked up once more, and a second copy that appeared
 * after all makes the item unconfirmed. An event is resent with its
 * transactionId, which Graph deduplicates.
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
import { isGraphError, isNotFound } from "../graph/errors.js";
import {
  addEventFileAttachment,
  type CalendarInfo,
  calendarPath,
  createCalendar,
  createEvent,
  findOccurrenceByOriginalStart,
  getDefaultCalendar,
  listCalendars,
  listEventAttachments,
  sameInstant,
  toCreatableEvent,
  updateEvent,
} from "../graph/resources/calendar.js";
import {
  collect,
  isGroupOwner,
  isWriteOutcomeUnknown,
  type MailboxOwner,
  odataString,
  paginate,
  query,
} from "../graph/resources/common.js";
import {
  createContact,
  ensureContactFolderPath,
  listContacts,
  toCreatableContact,
} from "../graph/resources/contacts.js";
import {
  type AttachmentMeta,
  addFileAttachment,
  base64Length,
  createMessageFromJson,
  createMessageFromMime,
  ensureMailFolderPath,
  findMessagesByInternetMessageId,
  getMessage,
  listAttachments,
  MIME_IMPORT_LIMIT_BASE64_BYTES,
  PID_TAG_CLIENT_SUBMIT_TIME,
  PID_TAG_MESSAGE_DELIVERY_TIME,
  patchMessage,
  prepareMessageCreate,
  resolveWellKnownFolders,
  WELL_KNOWN_FOLDER_NAMES,
  type WellKnownFolderName,
  type WellKnownFolders,
} from "../graph/resources/mail.js";
import type { ManifestObject } from "../manifest.js";
import {
  type FolderStep,
  folderKindOf,
  isDefaultContactFolder,
  isMailRoot,
  type SnapshotCatalog,
  splitAtAnchor,
} from "./catalog.js";
import {
  chunkReaderFor,
  isRecord,
  LEGACY_REPLACE_MODE_NOTE,
  lookAfterUnknownOutcome,
  mailboxRestoreMode,
  type RestoreGraphClientFactory,
  readJsonObject,
  restoreFolderNameFor,
  restoreRequestOptions,
  throwIfAborted,
} from "./common.js";
import {
  attachmentFactsOf,
  attachmentsNotBackedUpNote,
  attachmentsNotBackedUpOf,
  type CalendarFacts,
  imapFlagsNotCarried,
  imapInternalDateOf,
  messageFlagsOf,
  messageFormatOf,
  messageIsDraftOf,
  objectTypeOf,
  parseBoolean,
  referenceAttachmentsOf,
} from "./conventions.js";
import { type DuplicateSlot, MessageIdDuplicates } from "./duplicates.js";
import { finishGmailMessageForExchange, gmailLabelFolderNote, planGmailMail } from "./gmail.js";
import {
  forEachMimeAttachment,
  graphMessageFromMime,
  type MimeOutline,
  outlineMime,
} from "./mime-parts.js";
import { ObjectRangeSource } from "./object-range.js";
import { RESTORED_BY_EARLIER_ATTEMPT, RestoreProgress } from "./progress.js";
import {
  describeRestoreError,
  failureCodeOf,
  isAbortError,
  type RestoreItemCode,
  RestoreLedger,
  type RestoreReport,
} from "./results.js";
import { planRestore, type RestorePlan, resolveRestoreSource } from "./selection.js";

const EVENT_ATTACHMENT_WITHOUT_EVENT =
  "an event attachment is restored together with its event; select the event to restore it";

export interface ExchangeRestoreEngineOptions {
  readonly graph: RestoreGraphClientFactory;
  /** First wait after a failed attachment fragment before the session is asked (tests: 0). */
  readonly fragmentRetryDelayMs?: number;
  /** Waits before each look for what an unanswered POST made (./common.ts; tests: zeros). */
  readonly unknownOutcomeLooksMs?: readonly number[];
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

/**
 * Why a group conversation cannot go back into its group: Graph v1.0 lets
 * only a signed-in user (delegated permission) start a thread or reply to
 * one, never an app. Shown on every such item of a restore into a group.
 */
export const GROUP_POST_NOT_RESTORABLE =
  "Microsoft Graph does not let an app post into a group conversation; restore the conversations into a user mailbox, or download or export them (EML, MBOX)";

/** Restore into the group mailbox itself (./groups.ts) instead of a user's mailbox. */
export interface GroupRestoreTarget {
  readonly groupId: string;
}

export class ExchangeRestoreEngine implements RestoreEngine {
  readonly kind = "mailbox" as const;

  constructor(private readonly options: ExchangeRestoreEngineOptions) {}

  /**
   * Restore a mailbox snapshot, or a group mailbox snapshot: into a user's
   * mailbox (the default), or with `group` into the group itself, where only
   * calendar events can go (a group mailbox exposes no mail folders and an
   * app cannot post to its conversations).
   */
  async run(
    ctx: JobContext,
    request: RestoreRequest,
    into: { readonly group?: GroupRestoreTarget } = {},
  ): Promise<RestoreReport> {
    const group = into.group;
    const userId = group ? group.groupId : targetMailboxOf(request);
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
    const progress = await RestoreProgress.open(ctx.cursor, {
      restoreJobId: request.restoreJobId,
      retry: ctx.attempt > 0,
    });
    const session = new ExchangeRestoreSession({
      progress,
      ctx,
      client: await this.options.graph(ctx, request.protectedObject),
      userId,
      ...(group ? { owner: { groupId: group.groupId } } : {}),
      mode,
      legacyReplace,
      restoreJobId: request.restoreJobId,
      restoreFolderName: restoreFolderNameFor(ctx, request),
      keepAttendees: restoreRequestOptions(request).keepAttendees ?? false,
      catalog: plan.catalog,
      reader: chunkReaderFor(ctx),
      fragmentRetryDelayMs: this.options.fragmentRetryDelayMs,
      unknownOutcomeLooksMs: this.options.unknownOutcomeLooksMs,
      ledger,
      logger,
    });
    const folders = plan.folders.filter(
      (folder) => !session.isStructural(folder) && (!group || folderKindOf(folder) === "calendar"),
    );
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

    try {
      if (group) {
        await this.restoreIntoGroup(ctx, plan, folders, session, ledger);
      } else {
        await this.restorePlan(ctx, plan, folders, session, ledger);
      }
    } finally {
      // What this attempt restored stays known to the next one, also when it failed.
      await progress.flush().catch((error: unknown) =>
        logger.warn("could not save the restore progress", {
          error: describeRestoreError(error),
        }),
      );
    }

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

  /** Calendar events into the group's calendar; everything else is reported, not attempted. */
  private async restoreIntoGroup(
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
    if (plan.events.length > 0) {
      ctx.progress.phase("calendar");
      for (const event of plan.events) {
        await session.restoreEvent(event, plan.attachmentsByEvent.get(event.path) ?? []);
      }
    }
    for (const object of [...plan.mail, ...plan.orphanAttachments]) {
      if (objectTypeOf(object) === "event-attachment") {
        ledger.skipped(object, "parent_not_restored", EVENT_ATTACHMENT_WITHOUT_EVENT);
        continue;
      }
      ledger.failed(object, new Error(GROUP_POST_NOT_RESTORABLE), "not_restorable");
    }
    for (const object of [
      ...plan.contacts,
      ...plan.files,
      ...plan.versions,
      ...plan.informational,
    ]) {
      ledger.failed(
        object,
        new Error("only calendar events can be restored into a group"),
        "wrong_target",
      );
    }
    for (const object of plan.unknown) {
      ledger.failed(
        object,
        new Error(`objects of type "${object.type ?? ""}" cannot be restored into a group`),
        "not_restorable",
      );
    }
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
      // A Gmail message once, not once per label; labels become categories (./gmail.ts).
      const gmail = planGmailMail(plan.mail, plan.catalog, "exchange");
      const duplicates = new MessageIdDuplicates<string>(gmail.mail, (message) =>
        JSON.stringify(plan.catalog.mailFolderChain(message)),
      );
      for (const message of gmail.mail) {
        await session.restoreMessage(
          message,
          plan.attachmentsByMessage.get(message.path) ?? [],
          duplicates.slot(message),
        );
        const unit = gmail.units.get(message.path);
        if (unit !== undefined) {
          finishGmailMessageForExchange(unit, ledger);
        }
        // A group post whose attachments Graph never handed out comes back without them.
        const missing = attachmentsNotBackedUpOf(message);
        if (missing !== undefined) {
          ledger.amendRestored(message.path, attachmentsNotBackedUpNote(missing), true);
        }
      }
      for (const attachment of plan.orphanAttachments) {
        ledger.skipped(
          attachment,
          "parent_not_restored",
          objectTypeOf(attachment) === "event-attachment"
            ? EVENT_ATTACHMENT_WITHOUT_EVENT
            : "an attachment is restored together with its message; select the message to restore it",
        );
      }
    }
    if (plan.events.length > 0) {
      ctx.progress.phase("calendar");
      for (const event of plan.events) {
        await session.restoreEvent(event, plan.attachmentsByEvent.get(event.path) ?? []);
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
  /**
   * Whose calendar events go into: the user `userId`, or the group mailbox of
   * a Microsoft 365 group (./groups.ts), which has exactly one calendar.
   */
  readonly owner?: MailboxOwner;
  /** A mailbox restore only ever restores or skips; "replace" never reaches here. */
  readonly mode: "rename" | "skip";
  /** The stored request asked for the discontinued "replace" mode; ran as "rename" instead. */
  readonly legacyReplace: boolean;
  readonly restoreJobId: string;
  readonly restoreFolderName: string;
  readonly keepAttendees: boolean;
  readonly catalog: SnapshotCatalog;
  readonly reader: ChunkReader;
  readonly fragmentRetryDelayMs?: number | undefined;
  readonly unknownOutcomeLooksMs?: readonly number[] | undefined;
  readonly ledger: RestoreLedger;
  readonly logger: Logger;
  /** What earlier attempts of this job restored (./progress.ts). */
  readonly progress: RestoreProgress;
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

/** A created message and what its create could not carry over. */
interface ImportedMessage {
  readonly created: Message & { id: string };
  /** Created from JSON (the JSON fallback, or a MIME too large for one request). */
  readonly fromJson: boolean;
  /** JSON creates only: backed-up headers Graph does not take on create. */
  readonly droppedHeaders: number;
  /** JSON creates only: the times sent as extended properties, to compare with the result. */
  readonly sentTimes: { readonly received?: string; readonly sent?: string };
  /** A MIME too large for one request: its attachments, added after the create. */
  readonly mimeParts?: MimeOutline;
  /**
   * Graph did not answer the create; the message it had made was found by
   * its Message-ID and taken (or, when there was none, the create was sent
   * once more). Says so on the item.
   */
  readonly recovered?: {
    readonly adopted: boolean;
    readonly note: string;
    /** Sent once more, and the first create made its copy after all: the ids of those copies. */
    readonly twins?: readonly string[];
  };
  /** A message an earlier attempt created: the attachments it has already. */
  readonly present?: readonly AttachmentMeta[];
}

/** What Graph says about a message a create made, for the checks after it. */
const CREATED_MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "isDraft",
  "receivedDateTime",
  "sentDateTime",
] as const;

/** Why a failed write is not sent again: it may have gone through. */
function outcomeUnknownError(what: string, error: unknown): Error {
  return new Error(
    `Exchange did not answer whether it created ${what} (${describeRestoreError(error)}); it was not sent again so that no second copy is made, check the target for it`,
    { cause: error },
  );
}

function withId(message: Message): Message & { id: string } {
  if (!message.id) {
    throw new Error("Graph created the message but returned no id");
  }
  return { ...message, id: message.id };
}

/** Whether two Graph timestamps name the same second. */
function sameSecond(a: string | null | undefined, b: string | undefined): boolean {
  if (typeof a !== "string" || b === undefined) {
    return false;
  }
  const left = Date.parse(a);
  const right = Date.parse(b);
  return !Number.isNaN(left) && Math.floor(left / 1000) === Math.floor(right / 1000);
}

export class ExchangeRestoreSession {
  private readonly folderCache = new Map<string, string>();
  private readonly contactFolderCache = new Map<string, string>();
  private wellKnown: WellKnownFolders | null = null;
  private calendars: CalendarInfo[] | null = null;
  private readonly calendarIds = new Map<string, string>();
  /**
   * Per contact folder: the contacts it held before this run wrote to it, by
   * {@link contactKey}. Contacts this run creates are never added, so a second
   * backed-up contact with the same name and address is not mistaken for one
   * an earlier attempt restored.
   */
  private readonly contactsByFolder = new Map<string, Map<string, ExistingContact[]>>();
  /** Every contact a folder held when this run first looked at it. */
  private readonly contactsBefore = new Set<string>();
  /** Contacts this run created (or found its unanswered create had made). */
  private readonly contactsCreated = new Set<string>();

  /** Whose calendar the events go into (see {@link SessionOptions.owner}). */
  private readonly owner: MailboxOwner;

  constructor(private readonly o: SessionOptions) {
    this.owner = o.owner ?? o.userId;
  }

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
    const label = gmailLabelFolderNote(folder, catalog, "exchange");
    if (label !== undefined) {
      ledger.skipped(folder, "exists", this.legacyNote(label));
      return;
    }
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
    const { ctx, client, userId, ledger, progress } = this.o;
    throwIfAborted(ctx);
    const skipAttachments = (reason: string): void => {
      for (const attachment of attachments) {
        ledger.skipped(attachment, "parent_not_restored", reason);
      }
    };

    const isJson = messageFormatOf(message) === "json";
    const messageId = duplicates.messageId;
    const recorded = progress.get(message.path);
    let imported: ImportedMessage;
    try {
      const folderId = await this.mailFolderFor(this.o.catalog.mailFolderChain(message));
      const existing = await duplicates.existing(folderId, async (id) =>
        (await findMessagesByInternetMessageId(client, userId, id, { folderId })).map(
          (duplicate) => duplicate.id,
        ),
      );
      if (recorded?.state === "done") {
        // This job's own record: restored by an earlier attempt, with its verdict.
        if (existing.length > 0) {
          await duplicates.claimEarlierCopy(async () => undefined);
        }
        duplicates.settle();
        ledger.restored(message, {
          targetRef: recorded.targetRef,
          bytes: message.size,
          verified: recorded.verified,
          note: this.withLegacyReplaceNote(RESTORED_BY_EARLIER_ATTEMPT),
        });
        for (const attachment of attachments) {
          if (isJson) {
            ledger.restored(attachment, {
              bytes: attachment.size,
              note: RESTORED_BY_EARLIER_ATTEMPT,
            });
          } else {
            ledger.skipped(attachment, "exists", "contained in the restored message's MIME");
          }
        }
        return;
      }
      const resumed =
        recorded?.state === "created" ? await this.existingMessage(recorded.targetRef) : undefined;
      if (resumed !== undefined) {
        duplicates.claim(resumed.id);
        imported = await this.completeEarlier(
          message,
          isJson,
          resumed,
          "an earlier attempt of this job created the message and was interrupted; what was missing was added now",
        );
      } else {
        let earlier: string | undefined;
        if (existing.length > 0 && this.o.mode === "skip") {
          earlier = existing[0];
        } else if (existing.length > 0 && this.o.mode === "rename") {
          earlier = (await duplicates.claimEarlierCopy(async () => undefined))?.copy;
        }
        const copy =
          earlier !== undefined &&
          this.o.mode === "rename" &&
          this.hasPartsToAdd(message, attachments, isJson)
            ? await this.existingMessage(earlier)
            : undefined;
        if (copy !== undefined) {
          // The restore folder belongs to this job: the copy is an earlier
          // attempt's, which may have ended before its attachments followed.
          imported = await this.completeEarlier(
            message,
            isJson,
            copy,
            "found in the restore folder from an earlier attempt of this job; what was missing was added now",
          );
        } else if (earlier !== undefined) {
          if (this.o.mode === "rename") {
            // An earlier attempt may have ended before the flags followed the create.
            await patchMessage(client, userId, earlier, messageFlagsOf(message)).catch(
              (error: unknown) => {
                if (isAbortError(error)) {
                  throw error;
                }
              },
            );
          }
          duplicates.settle();
          ledger.skipped(
            message,
            "exists",
            this.legacyNote(this.skipReason("a message with this Message-ID", "folder")),
            earlier,
          );
          skipAttachments("the message already exists in the target folder");
          return;
        } else {
          imported = await this.importMessage(message, folderId, isJson, duplicates);
          duplicates.wrote(folderId, imported.created.id);
          if (this.hasPartsToAdd(message, attachments, isJson)) {
            // Long work follows (attachments): a retry must know the message exists.
            await progress.created(message.path, imported.created.id);
          }
        }
      }
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

    const { created } = imported;
    const problems: string[] = [];
    const notes: string[] = imported.recovered ? [imported.recovered.note] : [];
    if (imported.recovered?.twins !== undefined) {
      problems.push(
        `the first create went through after all: the folder holds ${imported.recovered.twins.length + 1} copies of this message, remove the extra one`,
      );
    }
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

    let attachmentsComplete = true;
    if (imported.mimeParts !== undefined) {
      const mimeProblems = await this.addMimeAttachments(
        message,
        created.id,
        imported.mimeParts,
        imported.present,
      );
      attachmentsComplete = mimeProblems.length === 0;
      problems.push(...mimeProblems);
      notes.push(
        "Exchange takes at most 4 MB in one request, so the message was created from its header and body and its attachments were added one by one; the header lines Exchange does not take (Received, References and similar) and the exact MIME stay in the backup (download it as EML for the original bytes)",
      );
    }

    const recorders: AttachmentRecorder[] = [];
    let attachmentFailures = 0;
    let attachmentTwins = 0;
    const taken = new Set<string>();
    for (const attachment of attachments) {
      const outcome = await this.addAttachment(
        created.id,
        attachment,
        isJson,
        taken,
        imported.present,
      );
      if (outcome.failed) {
        attachmentFailures++;
      }
      if (outcome.twin === true) {
        attachmentTwins++;
      }
      recorders.push(outcome.record);
    }
    if (attachmentTwins > 0) {
      problems.push(`${attachmentTwins} attachments are on the restored message twice`);
    }
    if (attachmentFailures > 0) {
      attachmentsComplete = false;
      problems.push(
        `${attachmentFailures} of ${attachments.length} attachments could not be added`,
      );
    }
    const wasDraft = messageIsDraftOf(message);
    if (created.isDraft === true && wasDraft === false) {
      problems.push("Exchange created the restored message as a draft, the backup is no draft");
    } else if (created.isDraft === true && wasDraft === undefined) {
      notes.push(
        isJson
          ? "restored from the JSON fallback of an oversized message; Exchange shows it as a draft"
          : "Exchange shows the restored message as a draft",
      );
    }
    if (imported.fromJson) {
      this.checkJsonCreate(imported, problems, imported.mimeParts === undefined ? notes : []);
    }
    const uncarried = imapFlagsNotCarried(message);
    if (uncarried.length > 0) {
      notes.push(
        `IMAP flags Microsoft 365 has no counterpart for were not set: ${uncarried.join(" ")}`,
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

    const verified =
      problems.length > 0
        ? false
        : messageId === undefined || imported.recovered?.adopted
          ? undefined
          : true;
    if (attachmentsComplete) {
      await progress.done(message.path, verified, created.id);
    } else {
      // A retry adds what is still missing to this message instead of a new one.
      await progress.created(message.path, created.id);
    }
    ledger.restored(message, {
      targetRef: created.id,
      bytes: message.size,
      verified,
      note: this.withLegacyReplaceNote([...problems, ...notes].join("; ") || undefined),
    });
    for (const record of recorders) {
      record();
    }
  }

  /** Whether attachments follow the create (a JSON message with attachments, a MIME too large for one request). */
  private hasPartsToAdd(
    message: ManifestObject,
    attachments: readonly ManifestObject[],
    isJson: boolean,
  ): boolean {
    return isJson
      ? attachments.length > 0
      : base64Length(message.size) > MIME_IMPORT_LIMIT_BASE64_BYTES;
  }

  /** A message by id as the checks after a create need it, or undefined when it is gone. */
  private async existingMessage(id: string): Promise<(Message & { id: string }) | undefined> {
    try {
      const found = await getMessage(this.o.client, this.o.userId, id, {
        select: CREATED_MESSAGE_SELECT,
      });
      return { ...found, id };
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * A message an earlier attempt of this job created, to be finished: its
   * attachments are listed so only the missing ones are added.
   */
  private async completeEarlier(
    message: ManifestObject,
    isJson: boolean,
    existing: Message & { id: string },
    note: string,
  ): Promise<ImportedMessage> {
    const { client, userId, reader } = this.o;
    const large = !isJson && base64Length(message.size) > MIME_IMPORT_LIMIT_BASE64_BYTES;
    const mimeParts = large ? await outlineMime(reader.objectStream(message)) : undefined;
    return {
      created: existing,
      fromJson: isJson || large,
      droppedHeaders: 0,
      sentTimes: {},
      ...(mimeParts ? { mimeParts } : {}),
      present: await collect(listAttachments(client, userId, existing.id)),
      recovered: { adopted: true, note },
    };
  }

  /**
   * What a message created from its JSON fallback lost: the dates the create
   * set as extended properties (./graph/resources/mail.ts,
   * prepareMessageCreate) are compared with what Graph answered, and a
   * difference makes the item unverified. (The draft state is compared for
   * every created message in {@link restoreMessage}.)
   */
  private checkJsonCreate(imported: ImportedMessage, problems: string[], notes: string[]): void {
    const { created, droppedHeaders, sentTimes } = imported;
    const lostDates: string[] = [];
    if (
      sentTimes.received !== undefined &&
      !sameSecond(created.receivedDateTime, sentTimes.received)
    ) {
      lostDates.push("received");
    }
    if (sentTimes.sent !== undefined && !sameSecond(created.sentDateTime, sentTimes.sent)) {
      lostDates.push("sent");
    }
    if (lostDates.length > 0) {
      problems.push(
        `Exchange did not take the ${lostDates.join(" and ")} date of the backup; the restored message shows other dates`,
      );
    }
    if (droppedHeaders > 0) {
      notes.push(
        `${droppedHeaders} transport headers of the original (Received, DKIM-Signature and similar) are kept in the backup; Exchange does not take them on a restored message`,
      );
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
    slot: DuplicateSlot<string>,
  ): Promise<ImportedMessage> {
    const { client, userId, reader } = this.o;
    if (!isJson && base64Length(message.size) <= MIME_IMPORT_LIMIT_BASE64_BYTES) {
      const mime = (await reader.readObjectToBuffer(message)).toString("base64");
      const { result, recovered } = await this.createMessageOnce(folderId, slot, () =>
        createMessageFromMime(client, userId, folderId, mime),
      );
      return {
        created: withId(result),
        fromJson: false,
        droppedHeaders: 0,
        sentTimes: {},
        ...(recovered ? { recovered } : {}),
      };
    }
    // The JSON fallback, or a MIME whose base64 would exceed Graph's 4 MB
    // request limit: created from JSON, attachments added afterwards. The
    // MIME pass reads (and so verifies) the whole backup before the create.
    const mimeParts = isJson ? undefined : await outlineMime(reader.objectStream(message));
    const json = mimeParts
      ? graphMessageFromMime(mimeParts, {
          receivedDateTime: this.recordedReceivedTime(message),
          isRead: messageFlagsOf(message).isRead,
        })
      : ((await readJsonObject(reader, message)) as Message);
    const { body, loss } = prepareMessageCreate(json, { isDraft: messageIsDraftOf(message) });
    const property = (id: string) =>
      body.singleValueExtendedProperties?.find((entry) => entry.id === id)?.value ?? undefined;
    const { result, recovered } = await this.createMessageOnce(folderId, slot, () =>
      createMessageFromJson(client, userId, folderId, body),
    );
    return {
      ...(recovered ? { recovered } : {}),
      created: withId(result),
      fromJson: true,
      droppedHeaders: loss.droppedHeaders,
      sentTimes: {
        received: property(PID_TAG_MESSAGE_DELIVERY_TIME),
        sent: property(PID_TAG_CLIENT_SUBMIT_TIME),
      },
      ...(mimeParts ? { mimeParts } : {}),
    };
  }

  /**
   * POST a message, never twice: when Graph does not answer (504, a timeout,
   * a broken connection) the message may exist all the same, or appear a
   * little later. Its Message-ID is looked up in the folder for about two
   * minutes, and a copy neither the folder had before this run nor this run
   * wrote for another message is the one the create made. Only when none of
   * the looks finds one is the create sent once more, and then the folder is
   * looked at again: a further copy means the first create went through
   * after all (`recovered.twins`). A message without Message-ID cannot be
   * looked up and is reported instead.
   */
  private async createMessageOnce(
    folderId: string,
    slot: DuplicateSlot<string>,
    post: () => Promise<Message>,
  ): Promise<{ result: Message; recovered?: ImportedMessage["recovered"] }> {
    const { client, userId } = this.o;
    try {
      return { result: await post() };
    } catch (error) {
      if (!isWriteOutcomeUnknown(error)) {
        throw error;
      }
      if (slot.messageId === undefined) {
        throw outcomeUnknownError("the message", error);
      }
      const lookup = async (id: string) =>
        (await findMessagesByInternetMessageId(client, userId, id, { folderId })).map(
          (found) => found.id,
        );
      const own = await lookAfterUnknownOutcome(
        this.o.ctx,
        () => slot.findOwnWrite(folderId, lookup),
        this.o.unknownOutcomeLooksMs,
      );
      if (own !== undefined) {
        const result = await getMessage(client, userId, own, { select: CREATED_MESSAGE_SELECT });
        return {
          result: { ...result, id: own },
          recovered: {
            adopted: true,
            note: "Exchange did not answer the create; the message it had made was found by its Message-ID and kept, not created twice",
          },
        };
      }
      let result: Message;
      try {
        result = await post();
      } catch (retryError) {
        throw isWriteOutcomeUnknown(retryError)
          ? outcomeUnknownError("the message", retryError)
          : retryError;
      }
      // The first create may still have gone through after the last look.
      const twins = (await slot.ownWrites(folderId, lookup)).filter((id) => id !== result.id);
      return {
        result,
        recovered:
          twins.length > 0
            ? {
                adopted: false,
                twins,
                note: "Exchange did not answer the first create and showed no message for two minutes; it was sent once more",
              }
            : {
                adopted: false,
                note: "Exchange did not answer the first create and showed no message for two minutes; it was sent once more, and the folder holds this one copy",
              },
      };
    }
  }

  /**
   * Add a file attachment, never twice: after an unknown outcome the
   * message's attachments are listed, and one of the same name and size that
   * this restore has not counted yet is the one the POST made. Only a source
   * that can be read again (`reopen`) is sent once more when there is none.
   */
  private async addFileAttachmentOnce(
    messageGraphId: string,
    file: Parameters<typeof addFileAttachment>[3],
    source: Readable,
    reopen: (() => Readable) | undefined,
    taken: Set<string>,
    present?: readonly AttachmentMeta[],
  ): Promise<{ id: string | undefined; existed?: boolean; twin?: boolean }> {
    const { client, userId } = this.o;
    const uploadOptions = this.uploadOptions();
    const match = (attachment: AttachmentMeta): boolean => {
      const size = attachment.size ?? -1;
      return (
        attachment.name === file.name &&
        !taken.has(attachment.id) &&
        size >= file.size &&
        size <= file.size + 64 * 1024
      );
    };
    // A message an earlier attempt created may hold this attachment already.
    const already = present?.find(match);
    if (already !== undefined) {
      taken.add(already.id);
      return { id: already.id, existed: true };
    }
    try {
      const added = await addFileAttachment(
        client,
        userId,
        messageGraphId,
        file,
        source,
        uploadOptions,
      );
      if (added.id !== undefined) {
        taken.add(added.id);
      }
      return added;
    } catch (error) {
      if (!isWriteOutcomeUnknown(error)) {
        throw error;
      }
      const findMade = async (): Promise<AttachmentMeta | undefined> => {
        for await (const attachment of listAttachments(client, userId, messageGraphId)) {
          if (match(attachment)) {
            return attachment;
          }
        }
        return undefined;
      };
      const made = await lookAfterUnknownOutcome(
        this.o.ctx,
        findMade,
        this.o.unknownOutcomeLooksMs,
      );
      if (made !== undefined) {
        taken.add(made.id);
        return { id: made.id };
      }
      if (reopen === undefined) {
        throw outcomeUnknownError(`the attachment ${file.name}`, error);
      }
      const again = reopen();
      try {
        const added = await addFileAttachment(
          client,
          userId,
          messageGraphId,
          file,
          again,
          uploadOptions,
        );
        if (added.id !== undefined) {
          taken.add(added.id);
        }
        // The first POST may still have gone through after the last look.
        const late = await findMade();
        if (late !== undefined) {
          taken.add(late.id);
          return { ...added, twin: true };
        }
        return added;
      } catch (retryError) {
        throw isWriteOutcomeUnknown(retryError)
          ? outcomeUnknownError(`the attachment ${file.name}`, retryError)
          : retryError;
      } finally {
        again.destroy();
      }
    }
  }

  /** Upload sessions end their waits with the job and resume failed fragments. */
  private uploadOptions(): { signal: AbortSignal; retryDelayMs?: number } {
    return {
      signal: this.o.ctx.signal,
      ...(this.o.fragmentRetryDelayMs !== undefined
        ? { retryDelayMs: this.o.fragmentRetryDelayMs }
        : {}),
    };
  }

  /** When the backup says the message arrived: Exchange's receivedDateTime, IMAP's internal date. */
  private recordedReceivedTime(message: ManifestObject): string | undefined {
    const recorded = message.metadata?.receivedDateTime;
    if (recorded !== undefined && !Number.isNaN(Date.parse(recorded))) {
      return recorded;
    }
    return message.metadata?.internalDate !== undefined
      ? imapInternalDateOf(message)?.toISOString()
      : undefined;
  }

  /**
   * Add the attachments of a MIME too large for one request, in a second pass
   * over the backup: below 3 MB each in one POST, larger ones through an
   * upload session. Returns the problems for the message's outcome.
   */
  private async addMimeAttachments(
    message: ManifestObject,
    messageGraphId: string,
    outline: MimeOutline,
    present?: readonly AttachmentMeta[],
  ): Promise<string[]> {
    const { ctx, reader } = this.o;
    const failed: string[] = [];
    const taken = new Set<string>();
    let seen = 0;
    try {
      await forEachMimeAttachment(reader.objectStream(message), async (index, content) => {
        seen = index + 1;
        const facts = outline.attachments[index];
        if (facts === undefined) {
          failed.push(`attachment ${index + 1}: not found in the first reading of the backup`);
          return;
        }
        throwIfAborted(ctx);
        try {
          await this.addFileAttachmentOnce(
            messageGraphId,
            {
              name: facts.name,
              contentType: facts.contentType,
              size: facts.size,
              isInline: facts.isInline,
              contentId: facts.contentId,
            },
            content,
            undefined,
            taken,
            present,
          );
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          failed.push(`${facts.name}: ${describeRestoreError(error)}`);
        }
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      failed.push(`reading the attachments failed: ${describeRestoreError(error)}`);
    }
    const missing = Math.max(0, outline.attachments.length - seen);
    const problems: string[] = [];
    if (failed.length > 0 || missing > 0) {
      problems.push(
        `${failed.length + missing} of ${outline.attachments.length} attachments could not be added${
          failed.length > 0 ? ` (${failed.join("; ")})` : ""
        }`,
      );
    }
    return problems;
  }

  /** Attach one backed-up attachment; the ledger entry is recorded after the message's. */
  private async addAttachment(
    messageGraphId: string,
    attachment: ManifestObject,
    ownerIsJson: boolean,
    taken: Set<string>,
    present?: readonly AttachmentMeta[],
  ): Promise<{ failed: boolean; twin?: boolean; record: AttachmentRecorder }> {
    const { ctx, reader, ledger } = this.o;
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
      const added = await this.addFileAttachmentOnce(
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
        () => reader.objectStream(attachment),
        taken,
        present,
      );
      return {
        failed: false,
        ...(added.twin ? { twin: true } : {}),
        record: () =>
          ledger.restored(attachment, {
            targetRef: added.id,
            bytes: attachment.size,
            ...(added.twin ? { verified: false } : {}),
            note:
              [
                ...(added.twin
                  ? [
                      "Exchange did not answer the first add and showed no attachment for two minutes; it was sent once more, and then the first add went through after all: the message holds this attachment twice",
                    ]
                  : []),
                ...(added.existed ? ["added by an earlier attempt of this job"] : []),
                ...(isItem ? ["an attached item is restored as a message file (.eml)"] : []),
              ].join("; ") || undefined,
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

  async restoreEvent(
    object: ManifestObject,
    attachments: readonly ManifestObject[] = [],
  ): Promise<void> {
    const { ctx, client, reader, ledger } = this.o;
    throwIfAborted(ctx);
    let attachmentsDone = false;
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
          for (const attachment of attachments) {
            ledger.skipped(
              attachment,
              "parent_not_restored",
              "the event already exists in the target calendar",
            );
          }
          return;
        }
      }

      const body: Partial<Event> & { transactionId: string } = {
        ...toCreatableEvent(item.event, { keepAttendees: this.o.keepAttendees }),
        transactionId: eventTransactionId(this.o.restoreJobId, object),
      };
      // The transactionId makes Graph answer a repeated POST with the event
      // the first one made, so after an unanswered POST it is safe to send
      // the same body once more.
      const created = await createEvent(client, this.owner, calendarId, body).catch(
        (error: unknown) => {
          if (!isWriteOutcomeUnknown(error)) {
            throw error;
          }
          return createEvent(client, this.owner, calendarId, body);
        },
      );
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
      attachmentsDone = true;
      const attached = await this.restoreEventAttachments(created.id, attachments);
      if (attached.failed > 0) {
        problems.push(
          `${attached.failed} of ${attachments.length} attachments could not be added to the event`,
        );
      }
      if (attached.unconfirmed > 0) {
        problems.push(
          `${attached.unconfirmed} of ${attachments.length} attachments are not on the restored event`,
        );
      }
      if (attached.twins > 0) {
        problems.push(`${attached.twins} attachments are on the restored event twice`);
      }
      const hadAttachments =
        item.event.hasAttachments === true ||
        parseBoolean(object.metadata?.hasAttachments) === true;
      if (hadAttachments && attachments.length === 0) {
        problems.push(
          "the event had attachments, but they were not part of the backup (earlier backups and group calendars do not hold them)",
        );
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
      if (!attachmentsDone) {
        for (const attachment of attachments) {
          ledger.skipped(attachment, "parent_not_restored", "its event could not be restored");
        }
      }
    }
  }

  /**
   * Add the backed-up attachments to a restored event, never twice: one an
   * earlier attempt (the same event, by its transactionId) already added is
   * kept, and after an unknown outcome the event's attachments are looked at
   * before anything is sent again. Each attachment is confirmed by name and
   * size on the event afterwards.
   */
  private async restoreEventAttachments(
    eventId: string,
    attachments: readonly ManifestObject[],
  ): Promise<{ failed: number; unconfirmed: number; twins: number }> {
    const { ctx, client, reader, ledger } = this.o;
    if (attachments.length === 0) {
      return { failed: 0, unconfirmed: 0, twins: 0 };
    }
    const listed = async () => {
      const all: AttachmentMeta[] = [];
      for await (const attachment of listEventAttachments(client, this.owner, eventId)) {
        all.push(attachment);
      }
      return all;
    };
    const taken = new Set<string>();
    const fits = (file: { name: string; size: number }) => (candidate: AttachmentMeta) => {
      const size = candidate.size ?? -1;
      return (
        candidate.name === file.name &&
        !taken.has(candidate.id) &&
        size >= file.size &&
        size <= file.size + 64 * 1024
      );
    };
    let present = await listed();
    let failed = 0;
    const added: Array<{
      attachment: ManifestObject;
      id: string | undefined;
      note: string[];
      twin?: boolean;
    }> = [];
    for (const attachment of attachments) {
      throwIfAborted(ctx);
      const facts = attachmentFactsOf(attachment);
      if (facts.kind === "reference") {
        ledger.skipped(
          attachment,
          "not_restorable",
          "link attachments (reference attachments) are kept in the backup but not re-created",
        );
        continue;
      }
      const isItem = facts.kind === "item";
      const file = {
        name: isItem && !/\.[A-Za-z0-9]{1,8}$/.test(facts.name) ? `${facts.name}.eml` : facts.name,
        contentType: facts.contentType ?? (isItem ? "message/rfc822" : "application/octet-stream"),
        size: attachment.size,
        isInline: facts.isInline,
        contentId: facts.contentId,
      };
      const note = isItem ? ["an attached item is restored as a message file (.eml)"] : [];
      const earlier = present.find(fits(file));
      if (earlier !== undefined) {
        taken.add(earlier.id);
        added.push({
          attachment,
          id: earlier.id,
          note: [...note, "added by an earlier attempt of this job"],
        });
        continue;
      }
      const source = new ObjectRangeSource(reader, attachment);
      try {
        let id: string | undefined;
        let twin = false;
        try {
          id = (
            await addEventFileAttachment(
              client,
              this.owner,
              eventId,
              file,
              source.read,
              this.uploadOptions(),
            )
          ).id;
        } catch (error) {
          if (!isWriteOutcomeUnknown(error)) {
            throw error;
          }
          const made = await lookAfterUnknownOutcome(
            ctx,
            async () => {
              present = await listed();
              return present.find(fits(file));
            },
            this.o.unknownOutcomeLooksMs,
          );
          // The source reads again from its chunks: sent once more only when nothing arrived.
          id = made?.id;
          if (made === undefined) {
            id = (
              await addEventFileAttachment(
                client,
                this.owner,
                eventId,
                file,
                source.read,
                this.uploadOptions(),
              ).catch((retryError: unknown) => {
                throw isWriteOutcomeUnknown(retryError)
                  ? outcomeUnknownError(`the attachment ${file.name}`, retryError)
                  : retryError;
              })
            ).id;
            if (id !== undefined) {
              taken.add(id);
            }
            // The first POST may still have gone through after the last look.
            const late = (await listed()).find(fits(file));
            if (late !== undefined) {
              taken.add(late.id);
              twin = true;
            }
          }
        }
        if (id !== undefined) {
          taken.add(id);
        }
        added.push({ attachment, id, note, ...(twin ? { twin } : {}) });
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        failed++;
        ledger.failed(attachment, this.legacyReplaceError(error), failureCodeOf(error));
      } finally {
        await source.close();
      }
    }
    // Confirm by what the event holds now.
    const after = added.length > 0 ? await listed() : [];
    let unconfirmed = 0;
    let twins = 0;
    const confirmedIds = new Set<string>();
    for (const entry of added) {
      const facts = attachmentFactsOf(entry.attachment);
      const name =
        facts.kind === "item" && !/\.[A-Za-z0-9]{1,8}$/.test(facts.name)
          ? `${facts.name}.eml`
          : facts.name;
      const match =
        after.find((candidate) => entry.id !== undefined && candidate.id === entry.id) ??
        after.find(
          (candidate) =>
            !confirmedIds.has(candidate.id) &&
            candidate.name === name &&
            (candidate.size ?? -1) >= entry.attachment.size,
        );
      if (match !== undefined) {
        confirmedIds.add(match.id);
      } else {
        unconfirmed++;
      }
      if (entry.twin === true) {
        twins++;
      }
      ledger.restored(entry.attachment, {
        targetRef: match?.id ?? entry.id,
        bytes: entry.attachment.size,
        verified: match !== undefined && entry.twin !== true,
        note:
          [
            ...entry.note,
            ...(match === undefined ? ["the restored event does not list this attachment"] : []),
            ...(entry.twin === true
              ? [
                  "Exchange did not answer the first add and showed no attachment for two minutes; it was sent once more, and then the first add went through after all: the event holds this attachment twice",
                ]
              : []),
          ].join("; ") || undefined,
      });
    }
    return { failed, unconfirmed, twins };
  }

  /** Re-apply a backed-up exception to the matching occurrence of the recreated series. */
  private async applyException(masterId: string, exception: Event): Promise<boolean> {
    const { client } = this.o;
    const originalStart = exception.originalStart ?? exception.start?.dateTime;
    if (!originalStart) {
      return false;
    }
    const occurrence = await findOccurrenceByOriginalStart(
      client,
      this.owner,
      masterId,
      originalStart,
    );
    if (!occurrence?.id) {
      return false;
    }
    const { recurrence: _recurrence, ...patch } = toCreatableEvent(exception, {
      keepAttendees: this.o.keepAttendees,
    });
    await updateEvent(client, this.owner, occurrence.id, patch);
    return true;
  }

  /**
   * The target calendar's display name, or undefined for the default
   * calendar. Rename mode never writes into an existing calendar: the default
   * calendar's events go to a calendar named like the restore folder, other
   * calendars' to `<restore folder> (<calendar>)`. A group mailbox has only
   * its one calendar, so a restore into a group always writes there (in rename
   * mode next to the existing events, as copies).
   */
  private calendarNameFor(facts: CalendarFacts): string | undefined {
    if (isGroupOwner(this.owner)) {
      return undefined;
    }
    if (this.o.mode !== "rename") {
      return facts.isDefault || facts.name === undefined ? undefined : facts.name;
    }
    return facts.isDefault || facts.name === undefined
      ? this.o.restoreFolderName
      : `${this.o.restoreFolderName} (${facts.name})`;
  }

  /** The id of the calendar an event (or calendar folder) goes into, created on demand. */
  async calendarFor(facts: CalendarFacts): Promise<string> {
    const { client } = this.o;
    const owner = this.owner;
    const wanted = this.calendarNameFor(facts);
    const key = wanted?.toLowerCase() ?? "";
    const cached = this.calendarIds.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let id: string;
    if (wanted === undefined) {
      id = (await getDefaultCalendar(client, owner)).id;
    } else {
      if (!this.calendars) {
        this.calendars = await collect(listCalendars(client, owner));
      }
      const found = this.calendars.find((calendar) => (calendar.name ?? "").toLowerCase() === key);
      id = found ? found.id : (await createCalendar(client, owner, wanted)).id;
    }
    this.calendarIds.set(key, id);
    return id;
  }

  private async findEventsByICalUId(calendarId: string, uid: string): Promise<ExistingEvent[]> {
    const url = `${calendarPath(this.owner, calendarId)}/events${query({
      $filter: `iCalUId eq ${odataString(uid)}`,
      $select: "id,subject",
    })}`;
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
        // Skip mode leaves every backed-up contact alone that the folder
        // already had under this key. Rename mode writes into the restore
        // folder of this job: what it held before this run is what an earlier
        // attempt restored, contact for contact (as MessageIdDuplicates does
        // for mail), so each backed-up contact claims one of those copies and
        // only a contact that found one is skipped.
        const matches = (await this.existingContacts(folderId)).get(key) ?? [];
        const duplicate = this.o.mode === "skip" ? matches[0] : matches.shift();
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

      let created: Contact;
      let adopted = false;
      try {
        created = await createContact(client, userId, folderId, toCreatableContact(contact));
      } catch (error) {
        if (!isWriteOutcomeUnknown(error)) {
          throw error;
        }
        // A contact has no key Graph deduplicates by: never sent again. One
        // with its name and address that the folder did not have before this
        // run, and no other contact of this run took, is the one the POST made.
        const own =
          key.length > 0
            ? await lookAfterUnknownOutcome(
                ctx,
                () => this.findOwnContact(folderId, key),
                this.o.unknownOutcomeLooksMs,
              )
            : undefined;
        if (own === undefined) {
          throw outcomeUnknownError("the contact", error);
        }
        created = own;
        adopted = true;
      }
      if (!created.id) {
        throw new Error("Graph created the contact but returned no id");
      }
      const createdId = created.id;
      this.contactsCreated.add(createdId);
      const verified = contactKey(created) === key;
      ledger.restored(object, {
        targetRef: createdId,
        bytes: object.size,
        verified: adopted && verified ? undefined : verified,
        note: this.withLegacyReplaceNote(
          [
            ...(adopted
              ? [
                  "Exchange did not answer the create; the contact it had made was found by its name and address and kept, not created twice",
                ]
              : []),
            ...(verified
              ? []
              : ["name or e-mail address of the restored contact differs from the backup"]),
          ].join("; ") || undefined,
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

  /** A contact under `key` the folder did not hold before this run and this run did not count yet. */
  private async findOwnContact(
    folderId: string | null,
    key: string,
  ): Promise<ExistingContact | undefined> {
    await this.existingContacts(folderId);
    for await (const contact of listContacts(this.o.client, this.o.userId, folderId)) {
      if (
        contact.id &&
        contactKey(contact) === key &&
        !this.contactsCreated.has(contact.id) &&
        !this.contactsBefore.has(contact.id)
      ) {
        return { ...contact, id: contact.id };
      }
    }
    return undefined;
  }

  private async existingContacts(folderId: string | null): Promise<Map<string, ExistingContact[]>> {
    const cacheKey = folderId ?? "";
    const cached = this.contactsByFolder.get(cacheKey);
    if (cached) {
      return cached;
    }
    const index = new Map<string, ExistingContact[]>();
    for await (const contact of listContacts(this.o.client, this.o.userId, folderId)) {
      const key = contactKey(contact);
      if (contact.id) {
        this.contactsBefore.add(contact.id);
      }
      if (contact.id && key.length > 0) {
        const matches = index.get(key);
        const existing = { ...contact, id: contact.id };
        if (matches) {
          matches.push(existing);
        } else {
          index.set(key, [existing]);
        }
      }
    }
    this.contactsByFolder.set(cacheKey, index);
    return index;
  }
}
