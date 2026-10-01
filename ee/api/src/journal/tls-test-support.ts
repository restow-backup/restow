/**
 * Test support for the journal receiver's TLS tests: throwaway certificates
 * (written with node:crypto by the release smoke's generator, so no openssl is
 * needed) and a small raw SMTP client to look at what the receiver says before
 * and after STARTTLS.
 */
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
  type SelfSignedCertificate,
  type SelfSignedOptions,
  createSelfSignedCertificate,
} from "../../../../scripts/smoke/lib/selfsigned.mjs";

export type { SelfSignedCertificate };

export const HOUR_MS = 60 * 60 * 1000;

export function certificate(options: SelfSignedOptions = {}): SelfSignedCertificate {
  return createSelfSignedCertificate({ commonName: "archive.example.com", ...options });
}

/** SHA-256 fingerprint of a certificate, as TLS sockets report it. */
export function fingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

export interface CertificateDir {
  readonly dir: string;
  readonly certPath: string;
  readonly keyPath: string;
  /** Write (or replace) the certificate and key files. */
  write(pair: SelfSignedCertificate): void;
  remove(): void;
}

/** A temporary directory laid out like the release stack's `journal-tls` volume. */
export function certificateDir(initial?: SelfSignedCertificate): CertificateDir {
  const dir = mkdtempSync(join(tmpdir(), "restow-journal-tls-"));
  const certPath = join(dir, "fullchain.pem");
  const keyPath = join(dir, "privkey.pem");
  const files: CertificateDir = {
    dir,
    certPath,
    keyPath,
    write(pair) {
      writeFileSync(certPath, pair.certPem);
      writeFileSync(keyPath, pair.keyPem, { mode: 0o600 });
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
  if (initial) {
    files.write(initial);
  }
  return files;
}

export interface SmtpReply {
  readonly code: number;
  readonly text: string;
}

export interface RawSmtpSession {
  /** Send one command line and read the complete reply. */
  send(line: string): Promise<SmtpReply>;
  /** Write bytes to the socket without waiting for a reply. */
  write(data: string): void;
  /** The greeting the server sent on connect. */
  readonly banner: SmtpReply;
  /** Upgrade the connection after a 220 to STARTTLS; returns the certificate the server presented. */
  upgrade(): Promise<string>;
  close(): void;
}

/** Connect and read the banner; a minimal SMTP client that shows the raw replies. */
export async function rawSmtp(port: number): Promise<RawSmtpSession> {
  let socket: net.Socket = net.connect({ host: "127.0.0.1", port });
  let buffer = "";
  let wake: (() => void) | null = null;

  function attach(target: net.Socket) {
    target.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      wake?.();
    });
    target.on("close", () => wake?.());
    target.on("error", () => wake?.());
  }
  attach(socket);

  async function reply(): Promise<SmtpReply> {
    for (;;) {
      const lines = buffer.split("\r\n");
      const last = lines.findIndex((line) => /^\d{3} /u.test(line));
      if (last !== -1) {
        const text = lines.slice(0, last + 1).join("\r\n");
        buffer = lines.slice(last + 1).join("\r\n");
        return { code: Number(lines[last]?.slice(0, 3)), text };
      }
      if (socket.destroyed) {
        throw new Error("the SMTP connection closed");
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  const banner = await reply();
  return {
    banner,
    async send(line) {
      socket.write(`${line}\r\n`);
      return reply();
    },
    write(data) {
      socket.write(data);
    },
    async upgrade() {
      const plain = socket;
      plain.removeAllListeners("data");
      const secure = tls.connect({ socket: plain, rejectUnauthorized: false });
      await new Promise<void>((resolve, reject) => {
        secure.once("secureConnect", () => resolve());
        secure.once("error", reject);
      });
      socket = secure;
      attach(secure);
      return secure.getPeerCertificate().fingerprint256;
    },
    close() {
      socket.destroy();
    },
  };
}
