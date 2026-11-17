import { type LookupFunction, connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { DbTlsFacts } from "../facts.js";
import type { DbErrorCode } from "../model.js";

/**
 * A small byte stream over a socket for the protocol probes (docs/DATABASES.md 3.1): exact reads
 * with a deadline, a look for bytes the server sends on its own (the MySQL greeting), and the
 * switch to TLS in the middle of a conversation (PostgreSQL SSLRequest, MySQL SSL request). The
 * certificate of the TLS session is kept as facts for the dialog (fingerprint, subject, issuer).
 *
 * Every connection of one probe belongs to a {@link DbProbeScope}: one deadline for the whole
 * probe, however many steps it takes, and every socket the probe opened is destroyed when the
 * probe ends or the deadline passes. A connection keeps at most {@link DB_CONN_MAX_BUFFERED}
 * unread bytes, and the probe reads at most {@link DB_PROBE_READ_BUDGET} over all its
 * connections; a server that sends more is cut off.
 */

/** The unread bytes one connection keeps at most. */
export const DB_CONN_MAX_BUFFERED = 2 * 1024 * 1024;
/** The bytes one probe reads at most, over all its connections. */
export const DB_PROBE_READ_BUDGET = 8 * 1024 * 1024;

export class DbConnError extends Error {
  constructor(
    readonly kind: "timeout" | "closed" | "connect" | "limit",
    message: string,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = "DbConnError";
  }
}

/**
 * The deadline of one probe and the sockets it opened. `close()` at the end of the probe destroys
 * every socket that is still open; when the deadline passes first, they are destroyed then and
 * every waiting read fails with a timeout.
 */
export class DbProbeScope {
  private readonly sockets = new Set<Socket>();
  private readonly timer: NodeJS.Timeout;
  private done = false;
  private received = 0;
  expired = false;

  constructor(
    readonly deadline: number,
    private readonly readBudget: number = DB_PROBE_READ_BUDGET,
  ) {
    this.timer = setTimeout(() => this.expire(), Math.max(0, deadline - Date.now()));
    this.timer.unref?.();
  }

  /** Milliseconds left until the deadline (0 once it passed). */
  remaining(): number {
    return this.expired || this.done ? 0 : Math.max(0, this.deadline - Date.now());
  }

  track(socket: Socket): void {
    if (this.done || this.expired) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  /** Count bytes received; false once the probe's read budget is spent. */
  consume(bytes: number): boolean {
    this.received += bytes;
    return this.received <= this.readBudget;
  }

  /** Sockets of this probe that are not closed yet (tests). */
  get openSockets(): number {
    return this.sockets.size;
  }

  private expire(): void {
    this.expired = true;
    this.destroyAll();
  }

  private destroyAll(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
  }

  /** The probe is over: no socket of it stays open. */
  close(): void {
    this.done = true;
    clearTimeout(this.timer);
    this.destroyAll();
  }
}

/** The probe stops with this code (a refused sign-in method, a changed certificate, ...). */
export class DbProbeAbort extends Error {
  constructor(
    readonly code: DbErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DbProbeAbort";
  }
}

export interface DbConnOptions {
  host: string;
  port: number;
  /** How long one step may wait; the scope's deadline bounds it further. */
  timeoutMs: number;
  /** The probe the connection belongs to: its deadline and its sockets. */
  scope?: DbProbeScope;
  /** Unread bytes kept at most (default {@link DB_CONN_MAX_BUFFERED}). */
  maxBufferedBytes?: number;
  /** The guarded lookup of the server executor (net/address-policy.ts). */
  lookup?: LookupFunction;
  /** Tests: a socket factory instead of the network. */
  connect?: (host: string, port: number) => Socket;
}

function certName(name: unknown): string | null {
  if (!name || typeof name !== "object") {
    return null;
  }
  const parts = Object.entries(name as Record<string, unknown>)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : String(value)}`)
    .join(", ");
  return parts.length > 0 ? parts.slice(0, 512) : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function probeTimeout(): DbConnError {
  return new DbConnError("timeout", "the probe did not finish in time");
}

export class DbConn {
  private socket: Socket;
  private chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private tlsFacts: Omit<DbTlsFacts, "offered"> = {
    used: false,
    fingerprintSha256: null,
    subject: null,
    issuer: null,
    notAfter: null,
  };

  private constructor(
    socket: Socket,
    private readonly options: DbConnOptions,
  ) {
    this.socket = socket;
    this.attach(socket);
  }

  private get maxBuffered(): number {
    return this.options.maxBufferedBytes ?? DB_CONN_MAX_BUFFERED;
  }

  /** The step's wait, bounded by the probe's deadline. */
  private stepMs(timeoutMs: number): number {
    const scope = this.options.scope;
    return scope ? Math.min(timeoutMs, scope.remaining()) : timeoutMs;
  }

  /** Connect within the deadline; a refused or blocked address is a {@link DbConnError} of kind `connect`. */
  static open(options: DbConnOptions): Promise<DbConn> {
    return new Promise((resolve, reject) => {
      const scope = options.scope;
      if (scope && scope.remaining() <= 0) {
        reject(probeTimeout());
        return;
      }
      const socket =
        options.connect?.(options.host, options.port) ??
        netConnect({
          host: options.host,
          port: options.port,
          ...(options.lookup ? { lookup: options.lookup } : {}),
        });
      scope?.track(socket);
      let settled = false;
      const settle = (error: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.off("error", fail);
        socket.off("close", closed);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          resolve(new DbConn(socket, options));
        }
      };
      const waitMs = scope ? Math.min(options.timeoutMs, scope.remaining()) : options.timeoutMs;
      const timer = setTimeout(() => {
        settle(
          scope?.expired || (scope && scope.remaining() <= 0)
            ? probeTimeout()
            : new DbConnError("timeout", `no answer from ${options.host}:${options.port}`),
        );
      }, waitMs);
      const fail = (error: Error & { code?: string }) => {
        settle(
          error.code === "BLOCKED_ADDRESS"
            ? error
            : new DbConnError("connect", error.message, error.code),
        );
      };
      const closed = () => {
        settle(scope?.expired ? probeTimeout() : new DbConnError("connect", "connection closed"));
      };
      socket.once("error", fail);
      socket.once("close", closed);
      socket.once("connect", () => settle(null));
    });
  }

  /** The address the socket is connected to (after the guarded lookup). */
  get remoteAddress(): string | null {
    const raw = (this.socket as TLSSocket).remoteAddress;
    return raw ?? null;
  }

  /** The port the socket is connected to. */
  get remotePort(): number | null {
    return this.socket.remotePort ?? null;
  }

  get tls(): Omit<DbTlsFacts, "offered"> {
    return this.tlsFacts;
  }

  private attach(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      if (this.failure) {
        return;
      }
      const withinBudget = this.options.scope?.consume(chunk.length) ?? true;
      if (!withinBudget || this.buffered + chunk.length > this.maxBuffered) {
        // More than any answer the probe reads: the connection is cut off.
        this.failure = new DbConnError("limit", "the server sent more data than the probe reads");
        this.chunks = [];
        this.buffered = 0;
        socket.destroy();
        this.notify();
        return;
      }
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      this.notify();
    });
    socket.on("end", () => {
      this.ended = true;
      this.notify();
    });
    socket.on("close", () => {
      this.ended = true;
      this.notify();
    });
    socket.on("error", (error) => {
      this.failure ??= error;
      this.notify();
    });
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  private waitForData(deadline: number): Promise<"data" | "timeout"> {
    return new Promise((resolve) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        resolve("timeout");
        return;
      }
      const timer = setTimeout(() => {
        this.wake = null;
        resolve("timeout");
      }, remaining);
      this.wake = () => {
        clearTimeout(timer);
        resolve("data");
      };
    });
  }

  /** Take `length` bytes off the front (there are at least that many). */
  private take(length: number): Buffer {
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const head = this.chunks[0] as Buffer;
      const need = length - copied;
      if (head.length <= need) {
        head.copy(out, copied);
        copied += head.length;
        this.chunks.shift();
      } else {
        head.copy(out, copied, 0, need);
        this.chunks[0] = head.subarray(need);
        copied += need;
      }
    }
    this.buffered -= length;
    return out;
  }

  private assertUsable(): void {
    const scope = this.options.scope;
    if (scope && (scope.expired || scope.remaining() <= 0)) {
      throw probeTimeout();
    }
    if (this.failure) {
      throw this.failure instanceof DbConnError
        ? this.failure
        : new DbConnError("closed", this.failure.message);
    }
  }

  /** Exactly `length` bytes within the step's deadline (and the probe's). */
  async read(length: number, timeoutMs = this.options.timeoutMs): Promise<Buffer> {
    if (length > this.maxBuffered) {
      throw new DbConnError("limit", "the server announced more data than the probe reads");
    }
    const deadline = Date.now() + this.stepMs(timeoutMs);
    while (this.buffered < length) {
      this.assertUsable();
      if (this.ended) {
        throw new DbConnError("closed", "the server closed the connection");
      }
      if ((await this.waitForData(deadline)) === "timeout" && this.buffered < length) {
        this.assertUsable();
        throw new DbConnError("timeout", "the server did not answer in time");
      }
    }
    return this.take(length);
  }

  /** Whatever the server sends on its own within `ms`; empty when it sends nothing. */
  async peek(ms: number): Promise<Buffer> {
    const deadline = Date.now() + this.stepMs(ms);
    while (this.buffered === 0 && !this.ended && !this.failure) {
      if ((await this.waitForData(deadline)) === "timeout") {
        break;
      }
    }
    if (this.chunks.length > 1) {
      this.chunks = [Buffer.concat(this.chunks, this.buffered)];
    }
    return Buffer.from(this.chunks[0] ?? Buffer.alloc(0));
  }

  /** Whether the server closed the connection (or it failed). */
  get closed(): boolean {
    return this.ended || this.failure !== null;
  }

  write(data: Buffer): void {
    this.socket.write(data);
  }

  /** Switch to TLS; the certificate is checked by its fingerprint (pinned), not by a CA. */
  async startTls(servername: string | null): Promise<void> {
    if (this.buffered > 0) {
      // Bytes before the handshake would be taken as if they came over TLS.
      throw new DbProbeAbort("db_probe_failed", "the server sent data before the TLS handshake");
    }
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("end");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    this.assertUsable();
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        plain.destroy();
        reject(
          this.options.scope?.expired
            ? probeTimeout()
            : new DbConnError("timeout", "the TLS handshake did not finish in time"),
        );
      }, this.stepMs(this.options.timeoutMs));
      const socket = tlsConnect({
        socket: plain,
        // Restow pins the certificate by its fingerprint (3.2): a self-signed certificate is
        // the rule for databases, and a changed one turns the connection red.
        rejectUnauthorized: false,
        ...(servername ? { servername } : {}),
        minVersion: "TLSv1.2",
      });
      this.options.scope?.track(socket);
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(new DbConnError("connect", `TLS: ${error.message}`));
      });
      socket.once("close", () => {
        clearTimeout(timer);
        reject(
          this.options.scope?.expired
            ? probeTimeout()
            : new DbConnError("closed", "the server closed the connection during TLS"),
        );
      });
    });
    this.socket = secure;
    this.chunks = [];
    this.buffered = 0;
    this.ended = false;
    this.attach(secure);
    const certificate = secure.getPeerCertificate();
    this.tlsFacts = {
      used: true,
      fingerprintSha256:
        typeof certificate?.fingerprint256 === "string"
          ? certificate.fingerprint256.toUpperCase()
          : null,
      subject: certName(certificate?.subject),
      issuer: certName(certificate?.issuer),
      notAfter: isoOrNull(certificate?.valid_to),
    };
  }

  close(): void {
    this.socket.destroy();
  }
}
