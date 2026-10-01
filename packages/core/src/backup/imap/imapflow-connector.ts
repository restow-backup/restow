/**
 * The production {@link ImapConnector}, backed by imapflow.
 *
 * Transport rules (docs/IMAP.md): implicit TLS on `tls`, mandatory STARTTLS on
 * `starttls` (the connect fails when the server cannot upgrade, no silent
 * downgrade), and cleartext only for `none`, which the engine refuses unless
 * explicitly allowed for development. Authentication is LOGIN/PLAIN with a
 * password or SASL OAUTHBEARER/XOAUTH2 with an access token. Every command is
 * translated into the narrow {@link ImapSession} contract and every failure
 * into an {@link ImapSessionError} that says whether the connection is gone.
 */
import {
  ImapFlow,
  type ImapFlowOptions,
  type ListResponse,
  type MessageAddressObject,
  type MessageEnvelopeObject,
  type MessageStructureObject,
} from "imapflow";
import type { Logger } from "../../engine/types.js";
import {
  guardedLookup,
  isBlockedAddressError,
  refuseHostBeforeConnect,
} from "../../net/address-policy.js";
import {
  type ImapAccountConfig,
  ImapAuthError,
  ImapConfigError,
  type ImapConnectOptions,
  type ImapConnector,
  type ImapCredential,
  type ImapEnvelopeMeta,
  type ImapFolderInfo,
  type ImapFolderStatus,
  type ImapMessageFlags,
  type ImapMessageMeta,
  type ImapMessageProtection,
  type ImapMessageSource,
  type ImapSession,
  ImapSessionError,
} from "./types.js";

/** Envelope FETCH fields shared by the metadata and source fetches (docs/IMAP.md). */
const ENVELOPE_FETCH_OPTIONS = { envelope: true, bodyStructure: true } as const;

/** Sent with the ID extension so server logs can attribute the sessions. */
const CLIENT_INFO = { name: "Restow", vendor: "Restow backup" };

/** Sockets idle longer than this are considered dead (large FETCH batches keep the socket busy). */
const SOCKET_TIMEOUT_MS = 10 * 60 * 1000;
const CONNECTION_TIMEOUT_MS = 60 * 1000;
/** Mailbox names are limited to 8-bit strings; 1 GiB literals are far beyond any message a server accepts. */
const MAX_LITERAL_BYTES = 1024 * 1024 * 1024;

export interface ImapFlowConnectorOptions {
  /** Injectable client factory (tests only). */
  readonly createClient?: (options: ImapFlowOptions) => ImapFlow;
}

export class ImapFlowConnector implements ImapConnector {
  private readonly createClient: (options: ImapFlowOptions) => ImapFlow;

  constructor(options: ImapFlowConnectorOptions = {}) {
    this.createClient = options.createClient ?? ((clientOptions) => new ImapFlow(clientOptions));
  }

  async connect(
    account: ImapAccountConfig,
    credential: ImapCredential,
    options: ImapConnectOptions,
  ): Promise<ImapSession> {
    const client = this.createClient(buildClientOptions(account, credential));
    const logger = options.logger.child({ component: "imapflow", host: account.host });
    const session = new ImapFlowSession(client, logger);
    try {
      await client.connect();
    } catch (error) {
      throw translateConnectError(error);
    }
    if (account.security !== "none" && !client.secureConnection) {
      await session.logout();
      throw new ImapConfigError(
        `connection to ${account.host}:${account.port} is not encrypted; TLS is required`,
      );
    }
    if (!authzidWasHonoured(client, account, credential)) {
      // client.capabilities reflects what the server actually offered, so
      // this is checked regardless of which path imapflow silently took
      // (see authzidWasHonoured); closing and refusing here is the only way
      // to avoid handing back a session that reads or writes the wrong
      // mailbox under this object's name.
      await session.logout();
      throw new ImapConfigError(authzidNotHonouredMessage(account));
    }
    if (options.signal.aborted) {
      await session.logout();
      throw new ImapSessionError("aborted before the session could be used", true);
    }
    const onAbort = () => {
      client.close();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    client.once("close", () => options.signal.removeEventListener("abort", onAbort));
    return session;
  }
}

/**
 * Whether a connected client actually honoured a forced SASL PLAIN authzid
 * (master-user impersonation, docs/IMAP.md). `buildClientOptions` forces
 * `loginMethod: "AUTH=PLAIN"` when `account.authzid` is set, but imapflow
 * only reads that once it has already decided to attempt SASL at all: its
 * own gate (imap-flow.js authenticate()) is `capabilities.has("AUTH=LOGIN")
 * || capabilities.has("AUTH=PLAIN")`, checked before `loginMethod` is ever
 * read. A server that advertises neither falls through to the plain IMAP
 * LOGIN command instead, which has no notion of authzid: the session that
 * just connected is already authenticated as the master account itself, not
 * impersonating the mailbox. `client.capabilities` reflects what the server
 * actually offered, so this is accurate whichever path imapflow silently
 * took. Every connect path that can carry an authzid (backup and restore
 * alike) must call this right after `connect()`, before the session is
 * handed back to anything that reads or writes under the object's name.
 */
export function authzidWasHonoured(
  client: Pick<ImapFlow, "capabilities">,
  account: Pick<ImapAccountConfig, "authzid">,
  credential: Pick<ImapCredential, "kind">,
): boolean {
  if (credential.kind !== "password" || !account.authzid) {
    return true;
  }
  return client.capabilities.has("AUTH=PLAIN");
}

/** The refusal message for a connect path where {@link authzidWasHonoured} returns false. */
export function authzidNotHonouredMessage(
  account: Pick<ImapAccountConfig, "host" | "port">,
): string {
  return `${account.host}:${account.port} does not offer AUTH=PLAIN, so a master-user login cannot impersonate a mailbox (authzid) here; it would silently sign in as the master account itself instead. Configure a Dovecot separator login for this server instead of SASL authzid.`;
}

/**
 * The imapflow options for an account. The host goes through the address
 * policy (../../net/address-policy.ts): a refused literal or local-only name
 * throws an {@link ImapConfigError} here, and every name is resolved through
 * the guarded lookup, so the address that was checked is the one connected to.
 */
export function buildClientOptions(
  account: ImapAccountConfig,
  credential: ImapCredential,
): ImapFlowOptions {
  const allowPrivateNetwork = account.allowPrivateNetwork === true;
  const refused = refuseHostBeforeConnect(account.host, allowPrivateNetwork);
  if (refused) {
    throw new ImapConfigError(refused.message);
  }
  const auth =
    credential.kind === "password"
      ? {
          user: account.username,
          pass: credential.password,
          // SASL PLAIN authzid (master-user impersonation, docs/IMAP.md); imapflow
          // only supports it alongside a password, never with an OAuth2 token.
          // Forcing AUTH=PLAIN here matters: imapflow only threads authzid through
          // AUTH=PLAIN, and without a forced loginMethod a server that advertises
          // AUTH=LOGIN but not AUTH=PLAIN would use AUTH=LOGIN and silently drop
          // authzid. This alone is not enough, though: imapflow only attempts
          // SASL at all when the server advertises AUTH=LOGIN or AUTH=PLAIN: on a
          // server that advertises neither, it falls back to the plain IMAP LOGIN
          // command regardless of loginMethod, again silently dropping authzid
          // and signing in as the master account itself. `connect` below checks
          // `client.capabilities` after connecting and refuses that case loudly
          // instead of returning a session authenticated as the wrong identity.
          ...(account.authzid ? { authzid: account.authzid, loginMethod: "AUTH=PLAIN" } : {}),
        }
      : { user: account.username, accessToken: credential.accessToken };
  const transport: Pick<ImapFlowOptions, "secure" | "doSTARTTLS"> =
    account.security === "tls"
      ? { secure: true }
      : account.security === "starttls"
        ? { secure: false, doSTARTTLS: true }
        : { secure: false, doSTARTTLS: false };
  return {
    host: account.host,
    port: account.port,
    servername: account.servername,
    ...transport,
    tls: { lookup: guardedLookup(allowPrivateNetwork) },
    auth,
    logger: false,
    emitLogs: false,
    disableAutoIdle: true,
    clientInfo: CLIENT_INFO,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: SOCKET_TIMEOUT_MS,
    maxLiteralSize: MAX_LITERAL_BYTES,
  };
}

function translateConnectError(error: unknown): Error {
  const failure = error as { authenticationFailed?: boolean; response?: string; message?: string };
  if (failure?.authenticationFailed) {
    return new ImapAuthError("authentication failed", failure.response ?? null);
  }
  const tls = error as { tlsFailed?: boolean };
  if (tls?.tlsFailed) {
    return new ImapConfigError("server does not offer STARTTLS; TLS is required");
  }
  if (isBlockedAddressError(error)) {
    // A configuration problem, not a transient network failure: retrying cannot help.
    return new ImapConfigError(describe(error));
  }
  return new ImapSessionError(describe(error), true, { cause: error });
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: string }).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

class ImapFlowSession implements ImapSession {
  private lastError: Error | null = null;

  constructor(
    private readonly client: ImapFlow,
    private readonly logger: Logger,
  ) {
    // An unhandled 'error' event would crash the worker process.
    client.on("error", (error) => {
      this.lastError = error;
      this.logger.warn("imap connection error", { error });
    });
  }

  get usable(): boolean {
    return this.client.usable;
  }

  async listFolders(): Promise<ImapFolderInfo[]> {
    const listed = await this.guard(() => this.client.list());
    return listed.map(toFolderInfo);
  }

  async openFolder(path: string): Promise<ImapFolderStatus> {
    const mailbox = await this.guard(() => this.client.mailboxOpen(path, { readOnly: true }));
    return {
      path: mailbox.path,
      uidValidity: mailbox.uidValidity.toString(),
      uidNext: mailbox.uidNext,
      exists: mailbox.exists,
    };
  }

  async listFlags(): Promise<ImapMessageFlags[]> {
    const mailbox = this.client.mailbox;
    if (!mailbox || mailbox.exists === 0) {
      return [];
    }
    return this.guard(async () => {
      const result: ImapMessageFlags[] = [];
      for await (const message of this.client.fetch("1:*", { uid: true, flags: true })) {
        result.push({ uid: message.uid, flags: [...(message.flags ?? [])] });
      }
      return result;
    });
  }

  async fetchMeta(uids: readonly number[]): Promise<ImapMessageMeta[]> {
    if (uids.length === 0) {
      return [];
    }
    return this.guard(async () => {
      const base = { uid: true, size: true, flags: true, internalDate: true } as const;
      const messages = await this.client
        .fetchAll([...uids], { ...base, ...ENVELOPE_FETCH_OPTIONS }, { uid: true })
        .catch((error) => {
          if (!this.client.usable) {
            // A dropped connection is not this message's fault; let guard()/translate()
            // report connectionLost so the caller reconnects instead of retrying here.
            throw error;
          }
          // A malformed ENVELOPE or BODYSTRUCTURE on one message can make the server
          // refuse the whole batch; retry with the old, narrower field set so every
          // message in the batch still backs up (docs/IMAP.md: an unreadable envelope
          // is never an item failure). The caller sees these as envelope-missing, same
          // as a server that simply left ENVELOPE out of its answer.
          return this.client.fetchAll([...uids], base, { uid: true });
        });
      return messages.map((message) => ({
        uid: message.uid,
        size: message.size ?? 0,
        flags: [...(message.flags ?? [])],
        internalDate: toDate(message.internalDate),
        messageId: message.envelope?.messageId ?? null,
        envelope: deriveEnvelopeMeta(message.envelope, message.bodyStructure),
      }));
    });
  }

  /**
   * Byte-exact sources only; the envelope is not re-requested here (redundant with
   * {@link fetchMeta}, whose result the engine already holds for these UIDs before it
   * downloads bodies, and whose BODYSTRUCTURE check has its own failure fallback above -
   * a fallback this second FETCH would not get if it also asked for BODYSTRUCTURE).
   */
  async *fetchSources(uids: readonly number[]): AsyncIterable<ImapMessageSource> {
    if (uids.length === 0) {
      return;
    }
    const iterator = this.client.fetch(
      [...uids],
      { uid: true, source: true, size: true, flags: true, internalDate: true },
      { uid: true },
    );
    try {
      for await (const message of iterator) {
        if (!message.source) {
          continue;
        }
        yield {
          uid: message.uid,
          size: message.size ?? message.source.length,
          flags: [...(message.flags ?? [])],
          internalDate: toDate(message.internalDate),
          messageId: null,
          source: message.source,
        };
      }
    } catch (error) {
      throw this.translate(error);
    }
  }

  async closeFolder(): Promise<void> {
    if (!this.client.mailbox) {
      return;
    }
    await this.guard(() => this.client.mailboxClose());
  }

  async logout(): Promise<void> {
    try {
      if (this.client.usable) {
        await this.client.logout();
      }
    } catch {
      // Falls through to a hard close below.
    } finally {
      this.client.close();
    }
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): Error {
    if (error instanceof ImapSessionError) {
      return error;
    }
    const connectionLost = !this.client.usable;
    const message = connectionLost && this.lastError ? describe(this.lastError) : describe(error);
    return new ImapSessionError(message, connectionLost, { cause: error });
  }
}

function toFolderInfo(entry: ListResponse): ImapFolderInfo {
  const flags = entry.flags ?? new Set<string>();
  const selectable = !flags.has("\\Noselect") && !flags.has("\\NonExistent");
  const info: ImapFolderInfo = {
    path: entry.path,
    name: entry.name,
    parent: [...entry.parent],
    delimiter: entry.delimiter,
    selectable,
  };
  return entry.specialUse ? { ...info, specialUse: entry.specialUse } : info;
}

// ---------------------------------------------------------------------------
// Envelope metadata (docs/IMAP.md; the mail envelope contract shared with the
// Exchange engine, same key names and meaning - see ./paths.ts META).
//
// imapflow already decodes RFC 2047 encoded words in ENVELOPE subject and
// address names (libmime.decodeWords), so nothing here re-decodes them; this
// is purely the translation from imapflow's shapes into ours plus the
// BODYSTRUCTURE checks. A message whose ENVELOPE is missing (the FETCH
// answered without one, e.g. a server that refuses it for this message) backs
// up with the plain fields only: `deriveEnvelopeMeta` returns undefined and
// the caller never sees this as a failure.
// ---------------------------------------------------------------------------

const MAX_ADDRESS_LIST_ENTRIES = 20;

/**
 * Quote a display name that contains an RFC 5322 special (a bare comma most
 * commonly, e.g. a "Last, First" directory name), so 'Flores, Lucas <l@x>,
 * Doe, John <j@x>' still splits unambiguously downstream.
 */
function quoteDisplayName(name: string): string {
  return /[,;:<>()[\]@\\"]/.test(name) ? `"${name.replace(/[\\"]/g, "\\$&")}"` : name;
}

/** 'Display Name <address>' or the bare address (or the bare name for an RFC 5322 group marker). */
function formatAddress(address: MessageAddressObject): string | null {
  const name = address.name?.trim();
  const mailbox = address.address?.trim();
  if (name && mailbox) {
    return `${quoteDisplayName(name)} <${mailbox}>`;
  }
  return mailbox || name || null;
}

interface FormattedAddressList {
  readonly formatted: readonly string[];
  readonly count: number;
}

/** Formats up to {@link MAX_ADDRESS_LIST_ENTRIES} addresses; `count` is the full total. */
function formatAddressList(
  list: readonly MessageAddressObject[] | undefined,
): FormattedAddressList {
  const entries = list ?? [];
  const formatted: string[] = [];
  for (const address of entries) {
    if (formatted.length >= MAX_ADDRESS_LIST_ENTRIES) {
      break;
    }
    const value = formatAddress(address);
    if (value) {
      formatted.push(value);
    }
  }
  return { formatted, count: entries.length };
}

/** Translate imapflow's ENVELOPE/BODYSTRUCTURE into the shared envelope metadata, or undefined if unreadable. */
export function deriveEnvelopeMeta(
  envelope: MessageEnvelopeObject | undefined,
  bodyStructure: MessageStructureObject | undefined,
): ImapEnvelopeMeta | undefined {
  if (!envelope) {
    return undefined;
  }
  const to = formatAddressList(envelope.to);
  const cc = formatAddressList(envelope.cc);
  return {
    subject: envelope.subject ?? "",
    from: envelope.from?.[0] ? formatAddress(envelope.from[0]) : null,
    to: to.formatted,
    toCount: to.count,
    cc: cc.formatted,
    ccCount: cc.count,
    hasAttachments: bodyStructure !== undefined && structureHasAttachment(bodyStructure),
    sentDateTime: envelope.date instanceof Date ? envelope.date : null,
    protection: bodyStructure !== undefined ? protectionOfStructure(bodyStructure) : null,
  };
}

/** Leaf types that are part of an ordinary message, never counted as an attachment. */
const NON_ATTACHMENT_LEAF_TYPES = new Set([
  "text/plain",
  "text/html",
  // A meeting invite rendered inline, not a user-facing attachment.
  "text/calendar",
  // The detached signature of a clear-signed message.
  "application/pkcs7-signature",
  "application/pgp-signature",
]);

/** A leaf part beyond the primary text body, or explicitly marked as an attachment. */
function structureHasAttachment(node: MessageStructureObject): boolean {
  const disposition = node.disposition?.toLowerCase();
  if (disposition === "attachment") {
    return true;
  }
  const type = node.type.toLowerCase();
  if (type === "message/rfc822") {
    // A forwarded message kept as its own part (rather than quoted inline text) is a
    // user-facing attachment even with no explicit disposition; checked before the walk
    // into its own nested body structure below, which would otherwise hide it.
    return true;
  }
  const children = node.childNodes ?? [];
  if (children.length > 0) {
    return children.some((child) => structureHasAttachment(child));
  }
  if (NON_ATTACHMENT_LEAF_TYPES.has(type)) {
    return false;
  }
  if (node.id) {
    // Has a Content-ID: referenced inline (cid:) by the HTML body, not a user-facing attachment.
    return false;
  }
  return true;
}

const RPMSG_CONTENT_TYPE = "application/x-microsoft-rpmsg-message";
const PKCS7_MIME_TYPES = new Set(["application/pkcs7-mime", "application/x-pkcs7-mime"]);
const ENVELOPED_SMIME_TYPES = new Set(["enveloped-data", "authenveloped-data"]);

/**
 * Whole-tree BODYSTRUCTURE check for the two protection markers this engine
 * recognises: rights-protected (IRM/Purview, an rpmsg part) and S/MIME
 * enveloped data. A signed-only S/MIME part (opaque signing, RFC 8551 3.5.2:
 * `smime-type=signed-data`; or detached signing: `application/pkcs7-signature`)
 * matches neither and is left unflagged.
 */
function protectionOfStructure(node: MessageStructureObject): ImapMessageProtection | null {
  const own = protectionOfPart(node);
  if (own) {
    return own;
  }
  for (const child of node.childNodes ?? []) {
    const found = protectionOfStructure(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function protectionOfPart(part: MessageStructureObject): ImapMessageProtection | null {
  const type = part.type.toLowerCase();
  const name = (part.parameters?.name ?? part.dispositionParameters?.filename ?? "").toLowerCase();
  if (type === RPMSG_CONTENT_TYPE || name.endsWith(".rpmsg")) {
    return "rights-protected";
  }
  if (PKCS7_MIME_TYPES.has(type)) {
    const smimeType = part.parameters?.["smime-type"];
    if (smimeType !== undefined) {
      // An explicit smime-type is authoritative: only enveloped/authEnveloped data is
      // encrypted, even when the part is conventionally also named smime.p7m (opaque
      // signing uses that same name for signed, unencrypted content).
      return ENVELOPED_SMIME_TYPES.has(smimeType.toLowerCase()) ? "smime-encrypted" : null;
    }
    // No smime-type parameter at all: fall back to the conventional opaque-encrypted name.
    if (name === "smime.p7m") {
      return "smime-encrypted";
    }
  }
  return null;
}

function toDate(value: Date | string | undefined): Date | null {
  if (value === undefined) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
