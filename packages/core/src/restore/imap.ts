/**
 * IMAP restore: messages of an IMAP snapshot back into an IMAP account by
 * APPEND with the original internal date and flags (docs/IMAP.md). Target
 * mailboxes are created when missing; duplicates are detected by Message-ID
 * before a message is appended, against what the mailbox held before this
 * run wrote to it (./duplicates.ts: two backed-up messages may share one
 * Message-ID); every appended message whose UID the server reports (UIDPLUS)
 * is fetched back and compared byte for byte by SHA-256. A retried
 * rename-mode job recognises its own earlier copies by content.
 *
 * An IMAP restore never replaces an original (docs/ARCHITECTURE.md, Restore):
 * nothing is ever deleted, overwritten or moved. The API refuses a new
 * restore request with mode "replace" for an IMAP target
 * (apps/api/src/features/restore/service.ts); the `restore_mode` database
 * enum keeps the value for history, so a job queued before that change may
 * still carry it — this engine runs it exactly as "rename" instead and notes
 * that on every message outcome (restored, skipped as a duplicate, or
 * failed), so the downgrade is visible even when a legacy job restores
 * nothing (./common.ts, mailboxRestoreMode).
 *
 * Mailboxes are found by meaning where the source recorded one: a message
 * from the source's `\Sent` mailbox lands in the target's `\Sent` mailbox,
 * whether that is called "Sent", "Sent Items" or "Gesendet". In rename mode
 * everything goes below a fresh restore mailbox instead.
 *
 * The engine talks to the small {@link ImapRestoreSession} interface so tests
 * run against an in-memory server; ./imap-flow.ts adapts imapflow for
 * production.
 */
import { createHash } from "node:crypto";
import type { ChunkReader } from "../engine/chunkstore.js";
import type {
  JobContext,
  ProtectedObjectRef,
  RestoreEngine,
  RestoreRequest,
  RestoreTarget,
} from "../engine/types.js";
import type { ManifestObject } from "../manifest.js";
import { type FolderStep, type SnapshotCatalog, splitAtAnchor } from "./catalog.js";
import {
  chunkReaderFor,
  LEGACY_REPLACE_MODE_NOTE,
  mailboxRestoreMode,
  restoreFolderNameFor,
  throwIfAborted,
} from "./common.js";
import { imapFlagsOf, imapInternalDateOf } from "./conventions.js";
import { type DuplicateSlot, MessageIdDuplicates } from "./duplicates.js";
import {
  type GmailUnit,
  gmailLabelFolderNote,
  placedIn,
  planGmailMail,
  reportGmailCopies,
} from "./gmail.js";
import { RESTORED_BY_EARLIER_ATTEMPT, RestoreProgress } from "./progress.js";
import {
  describeRestoreError,
  failureCodeOf,
  isAbortError,
  RestoreLedger,
  type RestoreReport,
} from "./results.js";
import { planRestore, type RestorePlan, resolveRestoreSource } from "./selection.js";

/**
 * What the restore needs from one authenticated IMAP connection. Deliberately
 * has no primitive to delete, flag \Deleted or move a message: an IMAP
 * restore never touches an existing message, so nothing here can (defence in
 * depth, docs/ARCHITECTURE.md, Restore).
 */
export interface ImapRestoreSession {
  /** The server's hierarchy delimiter (`/` or `.` on most servers). */
  readonly delimiter: string;
  /**
   * The mailbox this server uses for a SPECIAL-USE (`\Sent`, `\Trash`,
   * `\Inbox`, ...). Sessions without SPECIAL-USE knowledge omit it; mailboxes
   * are then matched by name.
   */
  specialUseMailbox?(use: string): string | undefined;
  /**
   * Create a mailbox and its parents when missing. `path` joins the hierarchy
   * levels with {@link delimiter}; the result is the path as the server names
   * it (a namespace prefix such as `INBOX.` may have been added).
   */
  ensureMailbox(path: string): Promise<string>;
  /** UIDs of messages in `mailbox` whose Message-ID header equals `messageId`. */
  findByMessageId(mailbox: string, messageId: string): Promise<number[]>;
  /**
   * UIDs of messages in `mailbox` that may be `message` (same size, an
   * internal date within a day of it: servers judge the day in their own
   * time zone), for a message without Message-ID on a retried job; the
   * caller compares SHA-256. Sessions that cannot search omit it.
   */
  findSimilar?(
    mailbox: string,
    message: { readonly internalDate: Date | undefined; readonly size: number },
  ): Promise<number[]>;
  /**
   * True for a Gmail account (`[Gmail]/All Mail` with `\All` in LIST): a
   * message is restored once and gets its other labels by {@link copy}
   * (./gmail.ts). Sessions that cannot tell omit it.
   */
  readonly isGmail?: boolean;
  /**
   * COPY one message into another mailbox. Only used on Gmail, where a COPY
   * adds a label to the same message instead of making a second one. Never
   * removes the message from its mailbox (no MOVE).
   */
  copy?(mailbox: string, uid: number, destination: string): Promise<void>;
  /**
   * PERMANENTFLAGS of `mailbox` (contains `\*` when new keywords are kept),
   * or undefined when the server does not say. Sessions that cannot tell omit it.
   */
  permanentFlags?(mailbox: string): Promise<readonly string[] | undefined>;
  /** APPEND one message; the UID is known when the server supports UIDPLUS. */
  append(
    mailbox: string,
    content: Buffer,
    flags: readonly string[],
    internalDate: Date | undefined,
  ): Promise<{ uid: number | undefined }>;
  /**
   * SHA-256 (hex) of the stored message, or null when the server did not
   * return it. Sessions that cannot fetch omit it; appends are then reported
   * without a byte comparison.
   */
  fetchSha256?(mailbox: string, uid: number): Promise<string | null>;
  /**
   * True once the connection is gone (the server closed it, an idle or session
   * limit, a network drop). Every later command would fail the same way, so the
   * run stops treating errors as item failures and fails the job instead: the
   * queue retries it on a fresh connection, and the Message-ID duplicate check
   * skips what this attempt already appended. Sessions that cannot tell omit it.
   */
  readonly connectionLost?: boolean;
  /** Log out and close the connection. Never throws. */
  close(): Promise<void>;
}

/**
 * Opens a session for the account a restore writes into. For `original` that
 * is the protected object's own account; for `other`, `target.ref` names the
 * account (the worker resolves it against the tenant's IMAP sources).
 */
export type ImapSessionFactory = (
  ctx: JobContext,
  protectedObject: ProtectedObjectRef,
  target: RestoreTarget,
) => Promise<ImapRestoreSession>;

export interface ImapRestoreEngineOptions {
  readonly imap: ImapSessionFactory;
}

/** Thrown for commands an IMAP server refused. */
export class ImapRestoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImapRestoreError";
  }
}

/**
 * Flags a restore does not set: `\Recent` belongs to the server, and a
 * message appended with `\Deleted` would vanish at the next EXPUNGE of any
 * client, undoing the restore.
 */
const WITHHELD_FLAGS = new Set(["\\recent", "\\deleted"]);

export function appendableFlags(flags: readonly string[]): { flags: string[]; withheld: string[] } {
  const unique = [...new Set(flags)];
  return {
    flags: unique.filter((flag) => !WITHHELD_FLAGS.has(flag.toLowerCase())),
    withheld: unique.filter((flag) => WITHHELD_FLAGS.has(flag.toLowerCase())),
  };
}

/** A name as one hierarchy level: the target's delimiter inside it would split it. */
function asComponent(name: string, delimiter: string): string {
  return delimiter.length === 0 ? name : name.split(delimiter).join("_");
}

/**
 * The target mailbox of a folder chain, as hierarchy components: below the
 * restore mailbox in rename mode, otherwise anchored on the target's own
 * special-use mailbox where the source recorded one.
 */
export function targetMailboxComponents(
  chain: readonly FolderStep[],
  session: Pick<ImapRestoreSession, "delimiter" | "specialUseMailbox">,
  restoreFolder: string | null,
): string[] {
  const delimiter = session.delimiter;
  const { anchor, below, names } = splitAtAnchor(chain);
  const clean = (list: readonly string[]) => list.map((name) => asComponent(name, delimiter));
  if (restoreFolder !== null) {
    return [asComponent(restoreFolder, delimiter), ...clean(names)];
  }
  if (anchor !== undefined) {
    // Gmail's All Mail goes into an archive mailbox where the target has no \All.
    const anchorPath =
      session.specialUseMailbox?.(anchor) ??
      (anchor.toLowerCase() === "\\all" ? session.specialUseMailbox?.("\\Archive") : undefined);
    if (anchorPath !== undefined) {
      const anchorComponents =
        delimiter.length === 0
          ? [anchorPath]
          : anchorPath.split(delimiter).filter((c) => c.length > 0);
      return [...anchorComponents, ...clean(below)];
    }
  }
  return clean(names);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class ImapRestoreEngine implements RestoreEngine {
  readonly kind = "imap" as const;

  constructor(private readonly options: ImapRestoreEngineOptions) {}

  async run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport> {
    if (request.target.type === "download") {
      throw new Error("download restores are produced by the download engine");
    }
    if (request.target.type === "other" && !request.target.ref?.trim()) {
      throw new Error("a restore into another IMAP account needs the target account");
    }
    const logger = ctx.logger.child({
      component: "restore-imap",
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
    ctx.progress.total(plan.objects.length);
    logger.info("restore planned", {
      messages: plan.mail.length,
      folders: plan.folders.length,
      target: request.target.type,
      mode,
    });

    const progress = await RestoreProgress.open(ctx.cursor, {
      restoreJobId: request.restoreJobId,
      retry: ctx.attempt > 0,
    });
    const session = await this.options.imap(ctx, request.protectedObject, request.target);
    try {
      const run = new ImapRestoreRun(
        ctx,
        session,
        plan.catalog,
        ledger,
        mode === "rename" ? restoreFolderNameFor(ctx, request) : null,
        mode,
        legacyReplace,
        progress,
      );
      await run.restorePlan(plan);
    } finally {
      // What this attempt restored stays known to the next one, also when it failed.
      await progress.flush().catch((error: unknown) =>
        logger.warn("could not save the restore progress", {
          error: describeRestoreError(error),
        }),
      );
      await session.close();
    }

    ledger.settle(plan.objects);
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
}

class ImapRestoreRun {
  private readonly reader: ChunkReader;
  private readonly mailboxes = new Map<string, string>();

  constructor(
    private readonly ctx: JobContext,
    private readonly session: ImapRestoreSession,
    private readonly catalog: SnapshotCatalog,
    private readonly ledger: RestoreLedger,
    private readonly restoreFolderName: string | null,
    /** A mailbox restore only ever restores or skips; "replace" never reaches here. */
    private readonly mode: "rename" | "skip",
    /** The stored request asked for the discontinued "replace" mode; ran as "rename" instead. */
    private readonly legacyReplace: boolean,
    /** What earlier attempts of this job restored (./progress.ts). */
    private readonly progress: RestoreProgress,
  ) {
    this.reader = chunkReaderFor(ctx);
  }

  /** Copies of messages without Message-ID this run took as an earlier attempt's, per mailbox. */
  private readonly takenSimilar = new Map<string, Set<number>>();

  /** Prepend {@link LEGACY_REPLACE_MODE_NOTE} for a job that asked for the discontinued "replace" mode. */
  private withLegacyReplaceNote(note: string | undefined): string | undefined {
    if (!this.legacyReplace) {
      return note;
    }
    return note ? `${LEGACY_REPLACE_MODE_NOTE}; ${note}` : LEGACY_REPLACE_MODE_NOTE;
  }

  /**
   * Same as {@link withLegacyReplaceNote}, for a reason that is never empty
   * (a skip). A legacy-replace job that skips or fails every message must
   * still say, somewhere, that it ran as "rename" instead of the "replace"
   * it was queued with.
   */
  private legacyNote(note: string): string {
    return this.legacyReplace ? `${LEGACY_REPLACE_MODE_NOTE}; ${note}` : note;
  }

  /**
   * Wrap a thrown error's message with {@link LEGACY_REPLACE_MODE_NOTE} for a
   * legacy-replace job, so a failed message's reason says so too. Callers
   * derive the failure code from the original error first: the wrapper is a
   * plain `Error` and would otherwise mis-classify an IMAP or integrity
   * failure as a generic one.
   *
   * The cause comes first and the note after, using the raw message rather
   * than `describeRestoreError` (results.ts): `RestoreLedger.failed`
   * truncates the reason to its own length limit once more when it calls
   * `describeRestoreError` on whatever this returns, and a cause-first
   * ordering means a long cause trims the (purely informational) note
   * instead of losing its own tail.
   */
  private legacyReplaceError(error: unknown): unknown {
    if (!this.legacyReplace) {
      return error;
    }
    const cause = error instanceof Error ? error.message : String(error);
    return new Error(`${cause} (${LEGACY_REPLACE_MODE_NOTE})`, { cause: error });
  }

  async restorePlan(plan: RestorePlan): Promise<void> {
    if (plan.folders.length > 0) {
      this.ctx.progress.phase("folders");
      for (const folder of plan.folders) {
        await this.recreateFolder(folder);
      }
    }
    if (plan.mail.length > 0) {
      this.ctx.progress.phase("mail");
      // A Gmail message once, not once per label (./gmail.ts).
      const gmail = planGmailMail(
        plan.mail,
        this.catalog,
        this.session.isGmail === true ? "gmail" : "imap",
      );
      const duplicates = new MessageIdDuplicates<number>(gmail.mail, (message) =>
        this.mailboxPath(message),
      );
      for (const message of gmail.mail) {
        await this.restoreMessage(message, duplicates.slot(message));
        const unit = gmail.units.get(message.path);
        if (unit !== undefined) {
          await this.finishGmailMessage(unit);
        }
      }
    }
    const foreign = [
      ...plan.events,
      ...plan.contacts,
      ...plan.files,
      ...plan.versions,
      ...plan.informational,
      ...plan.orphanAttachments,
      ...[...plan.attachmentsByMessage.values()].flat(),
      ...[...plan.attachmentsByEvent.values()].flat(),
    ];
    for (const object of foreign) {
      this.ledger.failed(
        object,
        new Error("only messages and mailboxes can be restored into an IMAP account"),
        "wrong_target",
      );
    }
    for (const object of plan.unknown) {
      this.ledger.failed(
        object,
        new Error(`objects of type "${object.type ?? ""}" cannot be restored into an IMAP account`),
        "not_restorable",
      );
    }
  }

  /** The target mailbox of an object as a path, before it is created or looked up. */
  private mailboxPath(object: ManifestObject): string {
    return targetMailboxComponents(
      this.catalog.imapFolderChain(object),
      this.session,
      this.restoreFolderName,
    ).join(this.session.delimiter);
  }

  private async mailboxFor(object: ManifestObject): Promise<string> {
    const path = this.mailboxPath(object);
    const cached = this.mailboxes.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const mailbox = await this.session.ensureMailbox(path);
    this.mailboxes.set(path, mailbox);
    return mailbox;
  }

  private async recreateFolder(folder: ManifestObject): Promise<void> {
    throwIfAborted(this.ctx);
    const label = gmailLabelFolderNote(
      folder,
      this.catalog,
      this.session.isGmail === true ? "gmail" : "imap",
    );
    if (label !== undefined) {
      this.ledger.skipped(folder, "exists", this.legacyNote(label));
      return;
    }
    try {
      const mailbox = await this.mailboxFor(folder);
      this.ledger.restored(folder, { targetRef: mailbox, bytes: 0, verified: true });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      this.throwIfConnectionLost(error);
      this.ledger.failed(folder, this.legacyReplaceError(error), failureCodeOf(error));
    }
  }

  private async restoreMessage(
    message: ManifestObject,
    duplicates: DuplicateSlot<number>,
  ): Promise<void> {
    const { session, ledger } = this;
    throwIfAborted(this.ctx);
    try {
      const mailbox = await this.mailboxFor(message);
      // The copies the mailbox had before this run wrote to it under this Message-ID.
      const existing = await duplicates.existing(mailbox, (messageId) =>
        session.findByMessageId(mailbox, messageId),
      );
      const recorded = this.progress.get(message.path);
      if (recorded?.state === "done") {
        // This job's own record: restored by an earlier attempt, with its verdict.
        const uid = Number(recorded.targetRef?.slice(recorded.targetRef.lastIndexOf(":") + 1));
        if (Number.isInteger(uid) && uid > 0) {
          duplicates.claim(uid);
        } else {
          await duplicates.claimEarlierCopy((copy) => this.sameContent(mailbox, copy, message));
        }
        duplicates.settle();
        ledger.restored(message, {
          targetRef: recorded.targetRef ?? mailbox,
          bytes: message.size,
          verified: recorded.verified,
          note: this.withLegacyReplaceNote(RESTORED_BY_EARLIER_ATTEMPT),
        });
        return;
      }
      if (duplicates.messageId === undefined && this.progress.isRetry) {
        const earlier = await this.earlierCopyWithoutMessageId(mailbox, message);
        if (earlier !== undefined && this.mode === "skip") {
          // The original mailbox: the copy may be one it held before this job, not this
          // job's work. It is there all the same, so the message is not appended twice.
          duplicates.settle();
          ledger.skipped(
            message,
            "exists",
            this.legacyNote(
              "an identical message (same day, size and SHA-256; it has no Message-ID) is already in the target mailbox, from before this job or from an earlier attempt of it",
            ),
            `${mailbox}:${earlier}`,
          );
          return;
        }
        if (earlier !== undefined) {
          // The restore mailbox belongs to this job: the copy is an earlier attempt's.
          duplicates.settle();
          ledger.restored(message, {
            targetRef: `${mailbox}:${earlier}`,
            bytes: message.size,
            verified: true,
            note: this.withLegacyReplaceNote(
              `${RESTORED_BY_EARLIER_ATTEMPT} (found by its content, it has no Message-ID)`,
            ),
          });
          await this.progress.done(message.path, true, `${mailbox}:${earlier}`);
          return;
        }
      }
      if (existing.length > 0 && this.mode === "skip") {
        duplicates.settle();
        ledger.skipped(
          message,
          "exists",
          this.legacyNote("a message with this Message-ID already exists in the target mailbox"),
          `${mailbox}:${existing[0]}`,
        );
        return;
      }
      if (existing.length > 0 && this.mode === "rename") {
        // The restore mailbox belongs to this job: what it holds under this
        // Message-ID was restored by an earlier attempt, message for message.
        // A copy known to differ is taken too (a server that re-renders what
        // it stores, such as Exchange over IMAP), but only while unclaimed
        // copies are left: each copy stands for one message.
        const earlier = await duplicates.claimEarlierCopy(
          (uid) => this.sameContent(mailbox, uid, message),
          { acceptDiffering: true },
        );
        if (earlier !== undefined) {
          duplicates.settle();
          ledger.skipped(
            message,
            "exists",
            this.legacyNote(
              earlier.confirmed
                ? "this message was already restored into this mailbox, with the same content (the job was retried)"
                : earlier.differs
                  ? "a message with this Message-ID was already restored into this mailbox (the job was retried); the server re-rendered the message, so its content could not be compared"
                  : "a message with this Message-ID was already restored into this mailbox (the job was retried)",
            ),
            `${mailbox}:${earlier.copy}`,
          );
          return;
        }
      }

      // Reading verifies size and SHA-256; nothing is written before it succeeded.
      const content = await this.reader.readObjectToBuffer(message);
      const appendable = appendableFlags(imapFlagsOf(message));
      const { withheld } = appendable;
      const notes: string[] = [];
      const { flags, dropped } = await this.keepableFlags(mailbox, appendable.flags);
      if (dropped.length > 0) {
        this.droppedKeywords.set(message.path, dropped);
        notes.push(
          `the keywords ${dropped.join(" ")} are not kept: the server takes no new keywords in this mailbox`,
        );
      }
      const { uid } = await session.append(mailbox, content, flags, imapInternalDateOf(message));
      duplicates.wrote(mailbox, uid);

      let verified: boolean | undefined;
      if (uid !== undefined && session.fetchSha256 !== undefined) {
        const stored = await session.fetchSha256(mailbox, uid);
        if (stored !== null) {
          verified = stored === sha256Hex(content);
          if (!verified) {
            notes.push("the server stores different bytes than were appended");
          }
        }
      }
      if (withheld.length > 0) {
        notes.push(`${withheld.join(" ")} not set again`);
      }
      duplicates.settle();
      await this.progress.done(
        message.path,
        verified,
        uid === undefined ? undefined : `${mailbox}:${uid}`,
      );
      ledger.restored(message, {
        targetRef: uid === undefined ? mailbox : `${mailbox}:${uid}`,
        bytes: content.length,
        verified,
        note: this.withLegacyReplaceNote(notes.join("; ") || undefined),
      });
    } catch (error) {
      duplicates.settle();
      if (isAbortError(error)) {
        throw error;
      }
      this.throwIfConnectionLost(error);
      ledger.failed(message, this.legacyReplaceError(error), failureCodeOf(error));
    }
  }

  /** Keywords a mailbox would not keep, by the message they were meant for. */
  private readonly droppedKeywords = new Map<string, string[]>();
  private readonly permanentFlagsByMailbox = new Map<string, readonly string[] | undefined>();

  /**
   * The flags `mailbox` keeps: a server whose PERMANENTFLAGS lack `\*` drops
   * new keywords without a word, so they are not sent and the caller says so.
   */
  private async keepableFlags(
    mailbox: string,
    flags: readonly string[],
  ): Promise<{ flags: string[]; dropped: string[] }> {
    const keywords = flags.filter((flag) => !flag.startsWith("\\"));
    if (keywords.length === 0 || this.session.permanentFlags === undefined) {
      return { flags: [...flags], dropped: [] };
    }
    if (!this.permanentFlagsByMailbox.has(mailbox)) {
      this.permanentFlagsByMailbox.set(mailbox, await this.session.permanentFlags(mailbox));
    }
    const permanent = this.permanentFlagsByMailbox.get(mailbox);
    if (permanent === undefined || permanent.includes("\\*")) {
      return { flags: [...flags], dropped: [] };
    }
    const known = new Set(permanent.map((flag) => flag.toLowerCase()));
    const dropped = keywords.filter((keyword) => !known.has(keyword.toLowerCase()));
    return { flags: flags.filter((flag) => !dropped.includes(flag)), dropped };
  }

  /**
   * After a Gmail message was written once: its other labels into a Gmail
   * account by COPY, and the outcome of the objects that stood for its other
   * labels (./gmail.ts). A rename-mode retry that finds the message an
   * earlier attempt appended adds the labels as well: that attempt may have
   * ended between the APPEND and the COPYs, and a COPY to a label the message
   * has already changes nothing in Gmail.
   */
  private async finishGmailMessage(unit: GmailUnit): Promise<void> {
    const outcome = this.ledger.resultOf(unit.object.path);
    const kept = new Map<string, string>();
    const lost = new Map<string, string>();
    const notes: string[] = [];
    let labelFailed = false;
    const foundOnRetry =
      outcome?.status === "skipped" &&
      outcome.code === "exists" &&
      this.mode === "rename" &&
      outcome.targetRef !== undefined &&
      unit.copyLabels.length > 0;
    if (outcome?.status === "restored" || foundOnRetry) {
      const dropped = new Set(this.droppedKeywords.get(unit.object.path) ?? []);
      const asKeywords: string[] = [];
      for (const { label, keyword } of unit.keywords) {
        if (dropped.has(keyword)) {
          lost.set(label, "the server takes no new keywords");
        } else {
          kept.set(label, `is kept as the keyword "${keyword}"`);
          asKeywords.push(keyword);
        }
      }
      if (asKeywords.length > 0) {
        notes.push(`Gmail labels kept as keywords: ${asKeywords.join(" ")}`);
      }
      const ref = outcome.targetRef ?? "";
      const split = ref.lastIndexOf(":");
      const mailbox = split === -1 ? ref : ref.slice(0, split);
      const uid = split === -1 ? Number.NaN : Number(ref.slice(split + 1));
      const added: string[] = [];
      for (const place of unit.copyLabels) {
        const name = place.label.replace(/^\\+/, "");
        if (!Number.isInteger(uid) || uid <= 0 || this.session.copy === undefined) {
          lost.set(
            place.label,
            "the server did not name the restored message, so no label was added",
          );
          labelFailed = true;
          continue;
        }
        try {
          const destination = await this.mailboxFor(placedIn(unit.object, place));
          await this.session.copy(mailbox, uid, destination);
          kept.set(place.label, `was added to it (COPY to ${destination})`);
          added.push(name);
        } catch (error) {
          if (isAbortError(error)) {
            throw error;
          }
          this.throwIfConnectionLost(error);
          lost.set(place.label, describeRestoreError(error));
          labelFailed = true;
        }
      }
      if (added.length > 0) {
        notes.push(`Gmail labels added: ${added.join(", ")}`);
      }
      if (lost.size > 0) {
        notes.push(
          `Gmail labels not kept: ${[...lost.entries()].map(([label, why]) => `${label.replace(/^\\+/, "")} (${why})`).join(", ")}`,
        );
      }
      if (notes.length > 0 && foundOnRetry) {
        this.ledger.amendSkipped(unit.object.path, notes.join("; "));
      } else if (notes.length > 0) {
        this.ledger.amendRestored(unit.object.path, notes.join("; "), labelFailed);
      }
    }
    reportGmailCopies(unit, outcome, { kept, lost }, this.ledger);
  }

  /**
   * A command failed because the connection is gone: not this item's fault,
   * and every remaining item would fail the same way and the job would still
   * end "completed with issues". Thrown out of the run instead, so the engine
   * closes the session and the worker fails the attempt and pg-boss retries
   * it; the retry recognises what this attempt already appended by Message-ID.
   */
  private throwIfConnectionLost(error: unknown): void {
    if (this.session.connectionLost === true) {
      throw new ImapRestoreError(`the IMAP connection was lost: ${describeRestoreError(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * On a retried job, a message without Message-ID cannot be found by it: a
   * stored message of the same internal date and size whose SHA-256 is the
   * backup's, and that no other message of this run took, is the copy an
   * earlier attempt appended.
   */
  private async earlierCopyWithoutMessageId(
    mailbox: string,
    message: ManifestObject,
  ): Promise<number | undefined> {
    if (this.session.findSimilar === undefined || message.sha256 === undefined) {
      return undefined;
    }
    const taken = this.takenSimilar.get(mailbox) ?? new Set<number>();
    this.takenSimilar.set(mailbox, taken);
    const candidates = await this.session.findSimilar(mailbox, {
      internalDate: imapInternalDateOf(message),
      size: message.size,
    });
    for (const uid of candidates) {
      if (!taken.has(uid) && (await this.sameContent(mailbox, uid, message)) === true) {
        taken.add(uid);
        return uid;
      }
    }
    return undefined;
  }

  /**
   * Whether the stored message `uid` holds exactly the backed-up bytes: true
   * or false by SHA-256, undefined when the server or the backup cannot tell.
   */
  private async sameContent(
    mailbox: string,
    uid: number,
    message: ManifestObject,
  ): Promise<boolean | undefined> {
    if (message.sha256 === undefined || this.session.fetchSha256 === undefined) {
      return undefined;
    }
    const stored = await this.session.fetchSha256(mailbox, uid);
    return stored === null ? undefined : stored.toLowerCase() === message.sha256.toLowerCase();
  }
}
