/**
 * The contract between the archive capture service (./service.ts, the framework) and the
 * capture ways that plug into it: Graph (`graph_sync`, ./graph.ts) and IMAP (`imap_sync`,
 * ./imap.ts). A way is registered in ./registry.ts with one line; nothing else of the
 * framework changes for a new way.
 *
 * What the framework does for every way:
 *
 *   - keeps one stream per archived mailbox and way (`archive_capture_streams`), wanted or
 *     not by the mail jobs (./reconcile.ts), and claims due streams across worker processes
 *     with `FOR UPDATE SKIP LOCKED` and a lease it renews while a pass runs (./streams.ts);
 *   - limits the passes per process and per tenant, serializes the passes of one mailbox,
 *     and idles while the gate `archive.mailboxCapture` is closed, during a shutdown or an
 *     update drain, and while the tenant's storage switches targets;
 *   - persists what a pass returns (state, next due time), counts failures with backoff and
 *     records the classified failure on the stream;
 *   - queues the one-time backfill as an `archive` job (`mode: "backfill"`) once a way has
 *     activated a stream, and runs it through {@link CaptureWay.backfill};
 *   - appends every captured mail through the shared archive append (./append.ts: dedupe
 *     across ways, the chain lock, mailbox assignment) via {@link CaptureContext.append}.
 *
 * What a way does: everything that talks to the mail service. A pass is
 *
 *   1. {@link CaptureWay.ensure}   live capture is set up and healthy (Graph: the
 *                                  subscription exists and is renewed; IMAP: folders and
 *                                  their UIDVALIDITY known). For a `pending` stream this is
 *                                  the activation: it returns `activated: true` once live
 *                                  capture works, and the framework sets `activated_at`,
 *                                  moves the stream to `backfilling` and queues the backfill.
 *   2. {@link CaptureWay.drain}    fetch what notifications announced
 *                                  (`archive_capture_pending`, Graph); the framework deletes
 *                                  the refs the way reports handled.
 *   3. {@link CaptureWay.catchUp}  the reconciling pass (Graph delta over every folder, IMAP
 *                                  STATUS/UID scan). The way decides from its own state
 *                                  whether one is due; `reason === "resync"` forces it.
 *
 * and {@link CaptureWay.release} when no job wants the stream any more. Each step returns
 * the way's new state (stored as `archive_capture_streams.state`, the way's own JSON) and
 * when it wants the next pass. A step that throws ends the pass: the state of the steps
 * before it is kept, the failure is recorded (a `FailureRecord` when the error carries a
 * classified cause, see @restow/core failures) and the stream is retried with backoff.
 *
 * Long-lived connections (IMAP IDLE) are not a pass: a way may start a background
 * component with {@link CaptureWay.start}, which gets {@link CaptureWayServices} to mark
 * streams due when the server announces new mail; the pass then fetches it.
 *
 * State keys starting with `_` and `resyncRequestedAt` are the framework's: `_mode` and
 * `_pollReason` (from {@link EnsureResult}, read by the status page), `resyncRequestedAt`
 * (set by the API's resync, cleared after the catch-up that honoured it). A way keeps its
 * own keys and passes the others through unchanged.
 *
 * Abort: every step gets {@link CaptureContext.signal}. It fires when the lease is lost,
 * on shutdown or update drain, when the gate closes and when the tenant's storage switch
 * begins. A way stops at the next mail boundary and returns (or throws `JobAbortedError`);
 * nothing it appended is lost, its state up to the last {@link CaptureContext.checkpoint}
 * is kept.
 */
import type { archive, Logger, StorageTargets, TenantKeyring } from "@restow/core";
import type {
  ArchiveCaptureWay,
  ArchiveStreamState,
  ArchiveStreamStatus,
  Database,
} from "@restow/db";
import type { WorkerJobContext } from "../handlers/framework.js";

export type { ArchiveStreamState };

/** The mailbox ways (the SMTP ways need no stream). */
export type MailboxWay = ArchiveCaptureWay;

/** Why the framework runs a pass now. */
export type PassReason =
  /** The stream was due by its own schedule (`next_due_at`). */
  | "scheduled"
  /** A notification, a background component or the API marked it dirty. */
  | "notified"
  /** An administrator asked for a resync (`POST /archive/capture/mailboxes/:id/resync`). */
  | "resync";

/** One stream as a way sees it. */
export interface CaptureStream {
  readonly id: string;
  readonly tenantId: string;
  readonly protectedObjectId: string;
  readonly sourceId: string;
  readonly way: MailboxWay;
  readonly status: ArchiveStreamStatus;
  /** When live capture started; mail received before it is captured late (backfill). */
  readonly activatedAt: Date | null;
  readonly backfillCompletedAt: Date | null;
  /** The way's own state as last persisted. */
  readonly state: ArchiveStreamState;
  readonly dirtySince: Date | null;
  readonly consecutiveFailures: number;
  readonly lastCaptureAt: Date | null;
}

/** One captured mail, handed to {@link CaptureContext.append}. */
export interface CapturedMail {
  /** The mail, byte-exact (Graph `$value`, IMAP `BODY.PEEK[]`). */
  readonly original: Buffer;
  /** Where the way found it: Graph immutable id, IMAP `<folder>;<uidvalidity>;<uid>`. */
  readonly externalRef: string;
  /**
   * When the mail service received it (Graph `receivedDateTime`, IMAP INTERNALDATE).
   * Earlier than the stream's `activatedAt` marks the item `captured-late`.
   */
  readonly receivedByService?: Date | null;
  /** Further flags (beyond `captured-late`, which the framework sets). */
  readonly flags?: readonly archive.ArchiveFlag[];
}

/** What every step of a way gets. */
export interface CaptureContext {
  readonly db: Database;
  readonly tenantId: string;
  readonly stream: CaptureStream;
  readonly reason: PassReason;
  /** The tenant's keyring and storage (cached per tenant by the framework). */
  readonly keys: TenantKeyring;
  readonly storage: StorageTargets;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  readonly now: () => Date;
  /**
   * Archive one mail of this stream's mailbox: parsed for search, deduplicated across
   * ways (a mail the archive already holds as strongly becomes a capture row, no second
   * item), chained, assigned to the mailbox. Throws only for infrastructure failures.
   */
  append(mail: CapturedMail): Promise<archive.CaptureArchiveItemResult>;
  /**
   * Which of the given refs and Message-IDs the archive already holds for this mailbox
   * (as an item, an assignment or a capture row): check before downloading a mail.
   */
  alreadyCaptured(query: {
    readonly externalRefs?: readonly string[];
    readonly messageIds?: readonly string[];
  }): Promise<{ externalRefs: Set<string>; messageKeys: Set<string> }>;
  /** Persist `state` now, mid-step (a long catch-up), so an abort resumes from here. */
  checkpoint(state: ArchiveStreamState): Promise<void>;
}

/** What {@link CaptureWay.ensure} reports. */
export interface EnsureResult {
  readonly state?: ArchiveStreamState;
  /**
   * The stream works live now. For a `pending` stream this is the activation (the
   * framework records `activated_at` and queues the backfill); later passes return it as
   * long as live capture works.
   */
  readonly activated: boolean;
  /**
   * How mail is noticed: `notifications` (Graph subscriptions, IMAP IDLE) or `poll`
   * (no public HTTPS for Graph, no IDLE). Shown on the status page with `pollReason`.
   */
  readonly mode: "notifications" | "poll";
  /** A failure code of the catalog (e.g. `graph.notification_url_unavailable`) when `poll`. */
  readonly pollReason?: string;
  /** The way wants a pass no later than this (a subscription to renew). */
  readonly nextDueAt?: Date;
}

export interface DrainResult {
  readonly state?: ArchiveStreamState;
  /** Refs that are done (captured, already archived, gone at the service): deleted from pending. */
  readonly handled: readonly string[];
  readonly captured: number;
}

export interface CatchUpResult {
  readonly state?: ArchiveStreamState;
  readonly captured: number;
  /** When the next catch-up is due (the framework passes again no later than this). */
  readonly nextDueAt: Date;
}

/** What the backfill job gives a way. */
export interface BackfillContext extends CaptureContext {
  /** The `archive` job running the backfill: its cursor (continuation) and progress. */
  readonly job: WorkerJobContext;
}

export interface BackfillResult {
  /** Mail appended as new items or capture rows. */
  readonly captured: number;
  /** Mail skipped because the archive already held it for this mailbox. */
  readonly skipped: number;
  /**
   * True when every folder was taken over. False when the job stopped early (abort, time
   * budget): the framework queues it again and it resumes from `job.cursor`.
   */
  readonly completed: boolean;
}

/** What a way's background component gets (see {@link CaptureWay.start}). */
export interface CaptureWayServices {
  readonly db: Database;
  readonly providerDb: Database;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** Mark streams due now (a pass follows within a poll interval). */
  markDue(streamIds: readonly string[]): Promise<void>;
  /**
   * The tenant's keyring (cached by the framework): a component that logs in to the mail
   * service itself (IMAP IDLE) opens the account's sealed credential with it.
   */
  keyring(tenantId: string): Promise<TenantKeyring>;
  /**
   * Whether the service works right now: the gate is open and no update drains the
   * worker. A background component holds no connections while this is false.
   */
  active(): boolean;
}

/** A capture way (see the module docstring). */
export interface CaptureWay {
  readonly way: MailboxWay;
  ensure(ctx: CaptureContext): Promise<EnsureResult>;
  drain(ctx: CaptureContext, refs: readonly string[]): Promise<DrainResult>;
  catchUp(ctx: CaptureContext): Promise<CatchUpResult>;
  /** No job wants the stream any more: remove what the way set up (a subscription). Best effort. */
  release?(ctx: CaptureContext): Promise<void>;
  /** The one-time takeover of the mailbox's existing mail, checkpointed in `ctx.job.cursor`. */
  backfill(ctx: BackfillContext): Promise<BackfillResult>;
  /** Start a background component (IMAP IDLE); stopped by `services.signal`. */
  start?(services: CaptureWayServices): void;
}
