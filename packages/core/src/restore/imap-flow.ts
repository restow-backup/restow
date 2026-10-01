/**
 * The production {@link ImapRestoreSession}, backed by imapflow, and the
 * factory the worker hands to the IMAP restore engine.
 *
 * Connection rules are the backup's (backup/imap): the same client options,
 * credentials resolved from the tenant's secret store (password or OAuth2),
 * TLS mandatory unless explicitly allowed for development, and the job's
 * abort signal closes the socket. Account lookup is the worker's: it knows
 * which `sources` row an original or other target refers to.
 */
import { createHash } from "node:crypto";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { CredentialSource } from "../backup/imap/connections.js";
import {
  authzidNotHonouredMessage,
  authzidWasHonoured,
  buildClientOptions,
} from "../backup/imap/imapflow-connector.js";
import type { FetchLike } from "../backup/imap/oauth2.js";
import type { ImapAccountConfig } from "../backup/imap/types.js";
import type { JobContext, ProtectedObjectRef, RestoreTarget } from "../engine/types.js";
import { ImapRestoreError, type ImapRestoreSession, type ImapSessionFactory } from "./imap.js";

/**
 * The part of imapflow a restore session uses (narrow so tests can fake it).
 * Deliberately excludes `messageDelete` and every other destructive method:
 * an IMAP restore never deletes, flags \Deleted or moves an existing message
 * (defence in depth, docs/ARCHITECTURE.md, Restore), so the adapter cannot
 * reach for one even by mistake.
 */
export type ImapFlowClient = Pick<
  ImapFlow,
  | "list"
  | "mailboxCreate"
  | "getMailboxLock"
  | "search"
  | "append"
  | "fetchOne"
  | "logout"
  | "close"
>;

function isAlreadyExists(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { serverResponseCode?: string } | null)?.serverResponseCode ?? "";
  return /ALREADYEXISTS/i.test(code) || /ALREADYEXISTS|already exists/i.test(text);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** {@link ImapRestoreSession} over a connected imapflow client. */
export class ImapFlowRestoreSession implements ImapRestoreSession {
  /** Mailbox path by its components joined with the delimiter, as the server names it. */
  private readonly known = new Map<string, string>();
  private readonly specialUse = new Map<string, string>();

  private constructor(
    private readonly client: ImapFlowClient,
    readonly delimiter: string,
  ) {}

  /** Wrap an already-connected client; the delimiter and mailbox list come from LIST. */
  static async open(client: ImapFlowClient): Promise<ImapFlowRestoreSession> {
    const listed = await client.list();
    const delimiter = listed.find((box) => box.delimiter)?.delimiter ?? "/";
    const session = new ImapFlowRestoreSession(client, delimiter);
    session.known.set("INBOX", "INBOX");
    session.specialUse.set("\\inbox", "INBOX");
    for (const box of listed) {
      session.known.set(box.path, box.path);
      if (box.specialUse && box.specialUse.toLowerCase() !== "\\inbox") {
        const key = box.specialUse.toLowerCase();
        if (!session.specialUse.has(key)) {
          session.specialUse.set(key, box.path);
        }
      }
    }
    return session;
  }

  specialUseMailbox(use: string): string | undefined {
    return this.specialUse.get(use.toLowerCase());
  }

  async ensureMailbox(target: string): Promise<string> {
    const components = target.split(this.delimiter).filter((component) => component.length > 0);
    let path = "";
    for (let depth = 1; depth <= components.length; depth++) {
      const key = components.slice(0, depth).join(this.delimiter);
      const known = this.known.get(key);
      if (known !== undefined) {
        path = known;
        continue;
      }
      try {
        // imapflow joins the levels with the delimiter and adds a namespace prefix if needed.
        path = (await this.client.mailboxCreate(components.slice(0, depth))).path;
      } catch (error) {
        if (!isAlreadyExists(error)) {
          throw new ImapRestoreError(`creating mailbox ${key} failed: ${describe(error)}`, {
            cause: error,
          });
        }
        path = key;
      }
      this.known.set(key, path);
    }
    if (path.length === 0) {
      throw new ImapRestoreError("a mailbox needs at least one name");
    }
    return path;
  }

  private async withMailbox<T>(mailbox: string, action: () => Promise<T>): Promise<T> {
    const lock = await this.client.getMailboxLock(mailbox);
    try {
      return await action();
    } finally {
      lock.release();
    }
  }

  async findByMessageId(mailbox: string, messageId: string): Promise<number[]> {
    return this.withMailbox(mailbox, async () => {
      const found = await this.client.search(
        { header: { "message-id": messageId } },
        { uid: true },
      );
      return Array.isArray(found) ? found : [];
    });
  }

  async append(
    mailbox: string,
    content: Buffer,
    flags: readonly string[],
    internalDate: Date | undefined,
  ): Promise<{ uid: number | undefined }> {
    const result = await this.client.append(mailbox, content, [...flags], internalDate);
    if (result === false) {
      throw new ImapRestoreError(`the server rejected the APPEND to ${mailbox}`);
    }
    return { uid: result.uid };
  }

  async fetchSha256(mailbox: string, uid: number): Promise<string | null> {
    return this.withMailbox(mailbox, async () => {
      const message = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
      if (message === false || !message.source) {
        return null;
      }
      return createHash("sha256").update(message.source).digest("hex");
    });
  }

  async close(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      this.client.close();
    }
  }
}

/** The account a restore writes into: the protected object's own, or the one `target.ref` names. */
export type ImapRestoreAccountResolver = (
  ctx: JobContext,
  protectedObject: ProtectedObjectRef,
  target: RestoreTarget,
) => Promise<ImapAccountConfig>;

export interface ImapFlowSessionFactoryOptions {
  readonly resolveAccount: ImapRestoreAccountResolver;
  /** Permit `security: "none"` accounts (development only). */
  readonly allowInsecure?: boolean;
  /** Persist a rotated OAuth2 refresh token (the worker writes it back to `secrets`). */
  readonly onRefreshTokenRotated?: (secretId: string, secretJson: string) => Promise<void>;
  /** Injectable HTTP client for the OAuth2 token endpoint (tests only). */
  readonly fetch?: FetchLike;
  /** Injectable client factory (tests only). */
  readonly createClient?: (options: ImapFlowOptions) => ImapFlow;
}

/** An {@link ImapSessionFactory} that connects with imapflow. */
export function createImapFlowSessionFactory(
  options: ImapFlowSessionFactoryOptions,
): ImapSessionFactory {
  const createClient = options.createClient ?? ((clientOptions) => new ImapFlow(clientOptions));
  return async (ctx, protectedObject, target) => {
    const account = await options.resolveAccount(ctx, protectedObject, target);
    if (account.security === "none" && options.allowInsecure !== true) {
      throw new ImapRestoreError(
        `${account.username}@${account.host} has transport security "none"; TLS is required`,
      );
    }
    const logger = ctx.logger.child({ component: "imap-restore", host: account.host });
    const credentials = new CredentialSource({
      secrets: ctx.secrets,
      account,
      fetch: options.fetch,
      onRefreshTokenRotated: options.onRefreshTokenRotated,
      logger,
    });
    const credential = await credentials.resolve();
    const client = createClient(buildClientOptions(account, credential));
    // An unhandled 'error' event would crash the worker process.
    client.on("error", (error: unknown) => {
      logger.warn("imap connection error", { error: describe(error) });
    });
    try {
      await client.connect();
    } catch (error) {
      const failure = error as { authenticationFailed?: boolean };
      throw new ImapRestoreError(
        failure?.authenticationFailed
          ? `authentication as ${account.username} failed`
          : `connecting to ${account.host}:${account.port} failed: ${describe(error)}`,
        { cause: error },
      );
    }
    if (account.security !== "none" && !client.secureConnection) {
      client.close();
      throw new ImapRestoreError(
        `the connection to ${account.host}:${account.port} is not encrypted; TLS is required`,
      );
    }
    if (!authzidWasHonoured(client, account, credential)) {
      // Without this, a server offering neither AUTH=LOGIN nor AUTH=PLAIN
      // would silently sign this restore in as the master account itself
      // (see authzidWasHonoured), and the APPEND below would land in the
      // wrong mailbox while the job still reports success.
      client.close();
      throw new ImapRestoreError(authzidNotHonouredMessage(account));
    }
    const onAbort = () => client.close();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    client.once("close", () => ctx.signal.removeEventListener("abort", onAbort));
    try {
      return await ImapFlowRestoreSession.open(client);
    } catch (error) {
      client.close();
      throw new ImapRestoreError(`listing mailboxes failed: ${describe(error)}`, { cause: error });
    }
  };
}
