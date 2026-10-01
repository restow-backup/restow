/**
 * IMAP backup contracts.
 *
 * The engine talks to a mail server only through {@link ImapSession}, a small
 * read-only view of what the backup needs (folder list, EXAMINE, flags, sizes,
 * byte-exact sources). The production implementation wraps imapflow
 * (./imapflow-connector.ts); the tests use an in-process fake (./testing/).
 * Keeping the seam this narrow is what makes incremental behaviour, UIDVALIDITY
 * handling and resume testable without a network (docs/TESTING.md).
 */
import type { JobContext, Logger, ProtectedObjectRef } from "../../engine/types.js";

// ---------------------------------------------------------------------------
// Account configuration (mirrors the `sources` columns for kind = imap)
// ---------------------------------------------------------------------------

/** Transport security. `none` is a development-only escape hatch (docs/IMAP.md: TLS is mandatory). */
export type ImapSecurity = "tls" | "starttls" | "none";

/** How the stored secret is used: as a password or as an OAuth2 refresh-token bundle. */
export type ImapAuthKind = "password" | "oauth2";

export interface ImapAccountConfig {
  readonly host: string;
  readonly port: number;
  readonly security: ImapSecurity;
  /**
   * The IMAP login: the mailbox's own login (shared, per-mailbox), or the
   * master account's login (master-user with the Dovecot separator style
   * already folded in, or the bare master login for the SASL authzid style,
   * see {@link authzid}).
   */
  readonly username: string;
  readonly authKind: ImapAuthKind;
  /**
   * `secrets.id` of the password (authKind `password`) or of the OAuth2 bundle
   * (authKind `oauth2`, see ./oauth2.ts for its JSON layout). For master-user
   * auth this is the master account's own secret; for per-mailbox auth it is
   * the mailbox's own sealed password.
   */
  readonly secretId: string;
  /**
   * SASL PLAIN authorization identity: set only for master-user auth in the
   * `sasl_authzid` style, where {@link username}/the credential authenticate
   * as the master account but the session is authorized as this mailbox
   * (docs/IMAP.md). Absent for every other auth mode and for OAuth2.
   */
  readonly authzid?: string;
  /** TLS server name for SNI when `host` is an IP literal. */
  readonly servername?: string;
  /**
   * Permit a host in a loopback or private network (../../net/address-policy.ts).
   * Only the operator decides this: the installation flag, or a provider admin
   * who saved the internal host. Link-local and reserved addresses stay refused.
   */
  readonly allowPrivateNetwork?: boolean;
}

/**
 * Resolves the account behind a protected object. The worker implements this
 * against the `sources` table (core never queries Postgres); tests return a
 * literal.
 */
export type ImapAccountResolver = (
  ctx: JobContext,
  protectedObject: ProtectedObjectRef,
) => Promise<ImapAccountConfig>;

/** A resolved credential. Plaintext lives only on the way into the connector. */
export type ImapCredential =
  | { readonly kind: "password"; readonly password: string }
  | { readonly kind: "oauth2"; readonly accessToken: string };

// ---------------------------------------------------------------------------
// Session (what the engine needs from a connection)
// ---------------------------------------------------------------------------

export interface ImapFolderInfo {
  /** Full mailbox path as the server names it (with its own delimiter). */
  readonly path: string;
  /** Last path component. */
  readonly name: string;
  /** Parent path components, outermost first. */
  readonly parent: readonly string[];
  readonly delimiter: string;
  /** SPECIAL-USE flag when known ("\\Sent", "\\Trash", ...; INBOX reports "\\Inbox"). */
  readonly specialUse?: string;
  /** False for `\Noselect` / `\NonExistent` containers that cannot hold messages. */
  readonly selectable: boolean;
}

export interface ImapFolderStatus {
  readonly path: string;
  /** UIDVALIDITY as a decimal string (32-bit unsigned; kept as string for JSON safety). */
  readonly uidValidity: string;
  readonly uidNext: number;
  /** Message count (EXISTS). */
  readonly exists: number;
}

export interface ImapMessageFlags {
  readonly uid: number;
  readonly flags: readonly string[];
}

/** How a message is protected against casual reading, detected without a full MIME parse. */
export type ImapMessageProtection = "rights-protected" | "smime-encrypted";

/**
 * Mail envelope metadata for the restore explorer, derived from IMAP ENVELOPE
 * and BODYSTRUCTURE. Absent on {@link ImapMessageMeta} when
 * the server's envelope could not be read; the message still backs up with the
 * fields above only (never an item failure, see ./engine.ts).
 */
export interface ImapEnvelopeMeta {
  readonly subject: string;
  /** 'Display Name <address>' or the bare address; null when the From: header is empty. */
  readonly from: string | null;
  /** Formatted like `from`, capped at 20 entries; `toCount` carries the full total. */
  readonly to: readonly string[];
  readonly toCount: number;
  /** Formatted like `to`; `ccCount` carries the full total. */
  readonly cc: readonly string[];
  readonly ccCount: number;
  readonly hasAttachments: boolean;
  /** The envelope's header date (Date:), next to the existing `internalDate`. */
  readonly sentDateTime: Date | null;
  readonly protection: ImapMessageProtection | null;
}

export interface ImapMessageMeta extends ImapMessageFlags {
  /** RFC822.SIZE as reported by the server (may differ slightly from the real byte count). */
  readonly size: number;
  readonly internalDate: Date | null;
  /** Message-ID header as reported in the ENVELOPE, or null. */
  readonly messageId: string | null;
  /** Absent when ENVELOPE/BODYSTRUCTURE could not be read for this message. */
  readonly envelope?: ImapEnvelopeMeta;
}

export interface ImapMessageSource extends ImapMessageMeta {
  /** The complete RFC 5322 message exactly as the server stores it (BODY.PEEK[]). */
  readonly source: Buffer;
}

/**
 * One authenticated connection. Methods are called sequentially per session;
 * the engine never issues two commands on one session at the same time.
 */
export interface ImapSession {
  /** LIST with SPECIAL-USE where available. */
  listFolders(): Promise<ImapFolderInfo[]>;
  /** EXAMINE (read-only select). */
  openFolder(path: string): Promise<ImapFolderStatus>;
  /** UID and flags of every message in the open folder (one FETCH 1:* (UID FLAGS)). */
  listFlags(): Promise<ImapMessageFlags[]>;
  /** Size, flags, internal date, Message-ID and envelope metadata of the given UIDs (no bodies). */
  fetchMeta(uids: readonly number[]): Promise<ImapMessageMeta[]>;
  /** Byte-exact sources of the given UIDs, in server order. UIDs the server does not return are simply absent. */
  fetchSources(uids: readonly number[]): AsyncIterable<ImapMessageSource>;
  closeFolder(): Promise<void>;
  /** True while the underlying connection can still take commands. */
  readonly usable: boolean;
  logout(): Promise<void>;
}

export interface ImapConnectOptions {
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

export interface ImapConnector {
  connect(
    account: ImapAccountConfig,
    credential: ImapCredential,
    options: ImapConnectOptions,
  ): Promise<ImapSession>;
}

// ---------------------------------------------------------------------------
// Engine state (manifest.state) and cursor (jobs.cursor)
// ---------------------------------------------------------------------------

/** Per-folder incremental state, stored in the manifest under `state.imap.folders[path]`. */
export interface ImapFolderState {
  readonly uidValidity: string;
  readonly uidNext: number;
  readonly delimiter: string;
  readonly specialUse?: string;
  /** Message count at the end of the run. */
  readonly messages: number;
}

export interface ImapEngineState {
  readonly imap: {
    readonly version: 1;
    readonly folders: Record<string, ImapFolderState>;
  };
}

/** Where a folder in progress stopped: every UID up to and including `lastUid` is in the partial manifest. */
export interface ImapActiveFolderCursor {
  readonly uidValidity: string;
  readonly lastUid: number;
}

/** Engine-specific part of the job cursor (see engine/types.ts Cursor). */
export interface ImapCursor {
  readonly completed: string[];
  readonly active: Record<string, ImapActiveFolderCursor>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The account configuration cannot be used (e.g. TLS disabled, unknown secret). */
export class ImapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapConfigError";
  }
}

/** The server rejected the credentials. Never carries the credentials themselves. */
export class ImapAuthError extends Error {
  constructor(
    message: string,
    readonly serverResponse: string | null = null,
  ) {
    super(message);
    this.name = "ImapAuthError";
  }
}

/**
 * A command failed at the protocol/transport level. `connectionLost` says
 * whether the session is dead (reconnect) or merely refused this command
 * (fall back, record the item, move on).
 */
export class ImapSessionError extends Error {
  constructor(
    message: string,
    readonly connectionLost: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImapSessionError";
  }
}

export function isImapSessionError(error: unknown): error is ImapSessionError {
  return error instanceof ImapSessionError;
}
