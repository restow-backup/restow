import { type LookupFunction, connect as netConnect, type Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import type { DbTlsFacts } from "../facts.js";

/**
 * A small byte stream over a socket for the protocol probes (docs/DATABASES.md 3.1): exact reads
 * with a deadline, a look for bytes the server sends on its own (the MySQL greeting), and the
 * switch to TLS in the middle of a conversation (PostgreSQL SSLRequest, MySQL SSL request). The
 * certificate of the TLS session is kept as facts for the dialog (fingerprint, subject, issuer).
 */

export class DbConnError extends Error {
  constructor(
    readonly kind: "timeout" | "closed" | "connect",
    message: string,
    readonly causeCode?: string,
  ) {
    super(message);
    this.name = "DbConnError";
  }
}

export interface DbConnOptions {
  host: string;
  port: number;
  timeoutMs: number;
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

export class DbConn {
  private socket: Socket;
  private buffer = Buffer.alloc(0);
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

  /** Connect within the deadline; a refused or blocked address is a {@link DbConnError} of kind `connect`. */
  static open(options: DbConnOptions): Promise<DbConn> {
    return new Promise((resolve, reject) => {
      const socket =
        options.connect?.(options.host, options.port) ??
        netConnect({
          host: options.host,
          port: options.port,
          ...(options.lookup ? { lookup: options.lookup } : {}),
        });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DbConnError("timeout", `no answer from ${options.host}:${options.port}`));
      }, options.timeoutMs);
      const fail = (error: Error & { code?: string }) => {
        clearTimeout(timer);
        socket.destroy();
        reject(
          error.code === "BLOCKED_ADDRESS"
            ? error
            : new DbConnError("connect", error.message, error.code),
        );
      };
      socket.once("error", fail);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.off("error", fail);
        resolve(new DbConn(socket, options));
      });
    });
  }

  /** The address the socket is connected to (after the guarded lookup). */
  get remoteAddress(): string | null {
    const raw = (this.socket as TLSSocket).remoteAddress;
    return raw ?? null;
  }

  get tls(): Omit<DbTlsFacts, "offered"> {
    return this.tlsFacts;
  }

  private attach(socket: Socket): void {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
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
      this.failure = error;
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

  /** Exactly `length` bytes within the connection's deadline. */
  async read(length: number, timeoutMs = this.options.timeoutMs): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    while (this.buffer.length < length) {
      if (this.failure) {
        throw new DbConnError("closed", this.failure.message);
      }
      if (this.ended) {
        throw new DbConnError("closed", "the server closed the connection");
      }
      if ((await this.waitForData(deadline)) === "timeout" && this.buffer.length < length) {
        throw new DbConnError("timeout", "the server did not answer in time");
      }
    }
    const out = this.buffer.subarray(0, length);
    this.buffer = this.buffer.subarray(length);
    return Buffer.from(out);
  }

  /** Whatever the server sends on its own within `ms`; empty when it sends nothing. */
  async peek(ms: number): Promise<Buffer> {
    const deadline = Date.now() + ms;
    while (this.buffer.length === 0 && !this.ended && !this.failure) {
      if ((await this.waitForData(deadline)) === "timeout") {
        break;
      }
    }
    return Buffer.from(this.buffer);
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
    const plain = this.socket;
    plain.removeAllListeners("data");
    plain.removeAllListeners("end");
    plain.removeAllListeners("close");
    plain.removeAllListeners("error");
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        plain.destroy();
        reject(new DbConnError("timeout", "the TLS handshake did not finish in time"));
      }, this.options.timeoutMs);
      const socket = tlsConnect({
        socket: plain,
        // Restow pins the certificate by its fingerprint (3.2): a self-signed certificate is
        // the rule for databases, and a changed one turns the connection red.
        rejectUnauthorized: false,
        ...(servername ? { servername } : {}),
        minVersion: "TLSv1.2",
      });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new DbConnError("connect", `TLS: ${error.message}`));
      });
    });
    this.socket = secure;
    this.buffer = Buffer.alloc(0);
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
