/**
 * Credentials and the per-account connection budget.
 *
 * Many IMAP servers cap concurrent sessions per login (Exchange Online: 20,
 * Gmail: 15, many hosters: 2-5), and a backup must never crowd out the user's
 * own mail client, so the engine holds at most {@link MAX_CONNECTIONS_PER_ACCOUNT}
 * sessions (docs/IMAP.md). The pool connects lazily and hands broken sessions
 * back for replacement.
 */
import type { Logger, SecretReader } from "../../engine/types.js";
import {
  type FetchLike,
  type OAuth2AccessToken,
  parseOAuth2Secret,
  refreshAccessToken,
} from "./oauth2.js";
import {
  type ImapAccountConfig,
  ImapConfigError,
  type ImapConnector,
  type ImapCredential,
  type ImapSession,
} from "./types.js";

export const MAX_CONNECTIONS_PER_ACCOUNT = 2;

/** Access tokens are refreshed this long before they expire. */
const TOKEN_EXPIRY_SKEW_MS = 60 * 1000;

export interface CredentialSourceOptions {
  readonly secrets: SecretReader;
  readonly account: ImapAccountConfig;
  readonly fetch?: FetchLike;
  readonly now?: () => number;
  /** Persist a rotated refresh token (the worker writes it back to `secrets`). */
  readonly onRefreshTokenRotated?: (secretId: string, secretJson: string) => Promise<void>;
  readonly logger: Logger;
}

/** Resolves the credential for each connect; caches OAuth2 access tokens until shortly before expiry. */
export class CredentialSource {
  private token: OAuth2AccessToken | null = null;
  private refreshToken: string | null = null;

  constructor(private readonly options: CredentialSourceOptions) {}

  async resolve(): Promise<ImapCredential> {
    const { account, secrets } = this.options;
    const raw = await secrets.get(account.secretId);
    if (raw === null) {
      throw new ImapConfigError(
        `secret ${account.secretId} for ${account.username} does not exist`,
      );
    }
    if (account.authKind === "password") {
      return { kind: "password", password: raw };
    }
    return { kind: "oauth2", accessToken: await this.accessToken(raw) };
  }

  /** Drop a cached access token, e.g. after the server rejected it. */
  invalidate(): void {
    this.token = null;
  }

  private async accessToken(rawSecret: string): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (this.token && this.token.expiresAt - TOKEN_EXPIRY_SKEW_MS > now) {
      return this.token.accessToken;
    }
    const stored = parseOAuth2Secret(rawSecret);
    // Prefer a refresh token rotated earlier in this run over the stored one.
    const secret = this.refreshToken ? { ...stored, refreshToken: this.refreshToken } : stored;
    const token = await refreshAccessToken(secret, {
      fetch: this.options.fetch,
      now: this.options.now,
    });
    this.token = token;
    if (token.rotatedRefreshToken) {
      this.refreshToken = token.rotatedRefreshToken;
      this.options.logger.info("oauth2 refresh token rotated", {
        secretId: this.options.account.secretId,
      });
      if (this.options.onRefreshTokenRotated) {
        const updated = JSON.stringify({ ...stored, refreshToken: token.rotatedRefreshToken });
        await this.options.onRefreshTokenRotated(this.options.account.secretId, updated);
      }
    }
    return token.accessToken;
  }
}

export interface SessionPoolOptions {
  readonly connector: ImapConnector;
  readonly account: ImapAccountConfig;
  readonly credentials: CredentialSource;
  readonly logger: Logger;
  readonly signal: AbortSignal;
  /** Upper bound on simultaneous sessions; never above {@link MAX_CONNECTIONS_PER_ACCOUNT}. */
  readonly maxConnections?: number;
}

/** A bounded set of sessions for one account. */
export class SessionPool {
  readonly maxConnections: number;
  private readonly open = new Set<ImapSession>();
  private closed = false;

  constructor(private readonly options: SessionPoolOptions) {
    const requested = options.maxConnections ?? MAX_CONNECTIONS_PER_ACCOUNT;
    this.maxConnections = Math.max(1, Math.min(MAX_CONNECTIONS_PER_ACCOUNT, requested));
  }

  get size(): number {
    return this.open.size;
  }

  /** Open a new session. Throws when the budget is exhausted; callers size their worker count by `maxConnections`. */
  async acquire(): Promise<ImapSession> {
    if (this.closed) {
      throw new Error("session pool is closed");
    }
    if (this.open.size >= this.maxConnections) {
      throw new Error(
        `connection budget exhausted (${this.maxConnections} per account); release a session first`,
      );
    }
    const credential = await this.options.credentials.resolve();
    const session = await this.options.connector.connect(this.options.account, credential, {
      logger: this.options.logger,
      signal: this.options.signal,
    });
    this.open.add(session);
    this.options.logger.debug("imap session opened", { sessions: this.open.size });
    return session;
  }

  /** Log out (or drop, when broken) and free the slot. Never throws. */
  async release(session: ImapSession): Promise<void> {
    if (!this.open.delete(session)) {
      return;
    }
    try {
      await session.logout();
    } catch (error) {
      this.options.logger.debug("imap logout failed", { error });
    }
  }

  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.open].map((session) => this.release(session)));
  }
}
