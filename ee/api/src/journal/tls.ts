/**
 * TLS for the journal receiver: which certificate it serves, whether it may
 * start without one, and how a renewed certificate reaches a running listener.
 *
 * The receiver offers STARTTLS because Exchange Online's connector is set to
 * always use TLS. smtp-server falls back to a built-in test certificate whose
 * private key is public when it is given none, which looks encrypted and is
 * not, so this module decides, before a listener exists, whether there is a
 * certificate worth serving. Nothing here ever hands smtp-server a certificate
 * it did not get from the operator's files.
 */
import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";

/** Why a configured certificate cannot be served. */
export type JournalTlsFailure = "tls_invalid" | "tls_expired";

export interface JournalTlsPaths {
  readonly certPath: string;
  readonly keyPath: string;
}

/** A certificate chain and private key that passed {@link loadJournalTls}. */
export interface JournalTlsMaterial {
  /** PEM certificate chain, leaf first. */
  readonly cert: Buffer;
  /** PEM private key, unencrypted. */
  readonly key: Buffer;
  readonly subject: string;
  readonly notBefore: Date;
  readonly notAfter: Date;
}

export type JournalTlsLoad =
  | { readonly ok: true; readonly material: JournalTlsMaterial }
  | { readonly ok: false; readonly reason: JournalTlsFailure; readonly message: string };

export type ReadFile = (path: string) => Buffer;

export interface JournalLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

const CERTIFICATE_PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/u;
const PRIVATE_KEY_PEM =
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC )?PRIVATE KEY-----/u;

function invalid(message: string): JournalTlsLoad {
  return { ok: false, reason: "tls_invalid", message };
}

function readOrMessage(
  read: ReadFile,
  path: string,
  what: string,
): { bytes: Buffer } | { message: string } {
  try {
    return { bytes: read(path) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { message: `the ${what} file ${path} cannot be read (${code ?? "unknown error"})` };
  }
}

/**
 * Read the certificate and key files and check that they can be served: both
 * readable, PEM (an unencrypted private key, a certificate), the key belonging
 * to the certificate, and the certificate valid now. The messages name files
 * and dates, never file contents.
 */
export function loadJournalTls(
  paths: JournalTlsPaths,
  now: Date,
  read: ReadFile = readFileSync,
): JournalTlsLoad {
  const certFile = readOrMessage(read, paths.certPath, "certificate");
  if ("message" in certFile) {
    return invalid(certFile.message);
  }
  const keyFile = readOrMessage(read, paths.keyPath, "private key");
  if ("message" in keyFile) {
    return invalid(keyFile.message);
  }
  if (!CERTIFICATE_PEM.test(certFile.bytes.toString("latin1"))) {
    return invalid(`the certificate file ${paths.certPath} holds no PEM certificate`);
  }
  if (!PRIVATE_KEY_PEM.test(keyFile.bytes.toString("latin1"))) {
    return invalid(
      `the private key file ${paths.keyPath} holds no unencrypted PEM private key (an encrypted key cannot be used)`,
    );
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certFile.bytes);
  } catch {
    return invalid(`the certificate file ${paths.certPath} is not a valid certificate`);
  }
  let matches: boolean;
  try {
    matches = certificate.checkPrivateKey(createPrivateKey(keyFile.bytes));
  } catch {
    return invalid(`the private key file ${paths.keyPath} is not a valid private key`);
  }
  if (!matches) {
    return invalid(
      `the private key in ${paths.keyPath} does not belong to the certificate in ${paths.certPath}`,
    );
  }

  const notBefore = new Date(certificate.validFrom);
  const notAfter = new Date(certificate.validTo);
  if (now.getTime() >= notAfter.getTime()) {
    return {
      ok: false,
      reason: "tls_expired",
      message: `the certificate in ${paths.certPath} expired on ${notAfter.toISOString()}`,
    };
  }
  if (now.getTime() < notBefore.getTime()) {
    return invalid(
      `the certificate in ${paths.certPath} is not valid before ${notBefore.toISOString()}`,
    );
  }
  return {
    ok: true,
    material: {
      cert: certFile.bytes,
      key: keyFile.bytes,
      subject: certificate.subject.replaceAll("\n", ", "),
      notBefore,
      notAfter,
    },
  };
}

/** What the receiver does about TLS when it starts. */
export type JournalTlsPlan =
  /** Serve STARTTLS with this certificate and refuse plain-text sessions. */
  | { readonly start: true; readonly mode: "tls"; readonly material: JournalTlsMaterial }
  /** The explicit opt-out: no certificate, STARTTLS not offered at all. */
  | { readonly start: true; readonly mode: "insecure" }
  /** Do not start a listener; `reason` is the receiver state the setup page shows. */
  | {
      readonly start: false;
      readonly reason: "tls_not_configured" | JournalTlsFailure;
      readonly message: string;
    };

export interface JournalTlsPlanInput {
  readonly tlsCertPath: string | undefined;
  readonly tlsKeyPath: string | undefined;
  /** `JOURNAL_ALLOW_INSECURE=true`. */
  readonly allowInsecure: boolean;
  readonly now: Date;
  readonly read?: ReadFile;
}

/**
 * The start decision, the same in every environment:
 *
 * - certificate and key configured: serve them, or (unreadable, not PEM, key
 *   mismatch, expired, not yet valid) do not start. A configured certificate
 *   that does not work never degrades to plain text, whatever the opt-out says.
 * - only one of the two configured: do not start (`tls_invalid`).
 * - neither configured: do not start (`tls_not_configured`), unless
 *   `allowInsecure` is set, which starts a listener without STARTTLS.
 */
export function planJournalTls(input: JournalTlsPlanInput): JournalTlsPlan {
  const { tlsCertPath, tlsKeyPath } = input;
  if (tlsCertPath && tlsKeyPath) {
    const loaded = loadJournalTls(
      { certPath: tlsCertPath, keyPath: tlsKeyPath },
      input.now,
      input.read,
    );
    return loaded.ok
      ? { start: true, mode: "tls", material: loaded.material }
      : { start: false, reason: loaded.reason, message: loaded.message };
  }
  if (tlsCertPath || tlsKeyPath) {
    return {
      start: false,
      reason: "tls_invalid",
      message: "JOURNAL_TLS_CERT_PATH and JOURNAL_TLS_KEY_PATH must both be set",
    };
  }
  if (input.allowInsecure) {
    return { start: true, mode: "insecure" };
  }
  return {
    start: false,
    reason: "tls_not_configured",
    message:
      "no TLS certificate is configured: set JOURNAL_TLS_CERT_PATH and JOURNAL_TLS_KEY_PATH (Exchange Online requires TLS)",
  };
}

export type JournalTlsStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: JournalTlsFailure; readonly message: string };

export interface JournalCertificateWatcher {
  /** Look at the files now (the interval does this on its own). */
  check(): void;
  stop(): void;
}

export interface JournalCertificateWatcherOptions {
  readonly paths: JournalTlsPaths;
  /** The certificate the listener was started with. */
  readonly initial: JournalTlsMaterial;
  /** Hand a new certificate to the listener (smtp-server `updateSecureContext`). */
  readonly apply: (material: JournalTlsMaterial) => void;
  /** Whether the certificate in use is good; called on every check. */
  readonly onStatus: (status: JournalTlsStatus) => void;
  readonly intervalMs?: number;
  readonly now?: () => Date;
  readonly read?: ReadFile;
  readonly logger?: JournalLogger;
}

/** How often the certificate files are looked at for a renewal. */
export const CERTIFICATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function sameMaterial(a: JournalTlsMaterial, b: JournalTlsMaterial): boolean {
  return a.cert.equals(b.cert) && a.key.equals(b.key);
}

/**
 * Picks a renewed certificate up without a restart. The files are re-read on
 * an interval and compared by content, not watched with `fs.watch`: a watch
 * misses atomic renames, symlink swaps (the layout of Let's Encrypt clients
 * and Caddy), and changes on bind mounts and network file systems, and a
 * renewal that nobody notices is an outage 60 to 90 days later.
 *
 * A new pair replaces the one in use only after it passed
 * {@link loadJournalTls} as a whole, so a renewal client that has written the
 * certificate but not yet the key (or an expired or broken file) changes
 * nothing; the listener keeps serving the certificate it has and the next
 * check tries again. `onStatus` reports `tls_expired` when the certificate in
 * use has run out and no usable replacement is there, so the setup page says
 * why Exchange Online cannot deliver.
 */
export function watchJournalCertificate(
  options: JournalCertificateWatcherOptions,
): JournalCertificateWatcher {
  const now = options.now ?? (() => new Date());
  let current = options.initial;
  let lastProblem: string | null = null;

  function check(): void {
    const at = now();
    const loaded = loadJournalTls(options.paths, at, options.read);
    if (loaded.ok) {
      if (!sameMaterial(current, loaded.material)) {
        try {
          options.apply(loaded.material);
          current = loaded.material;
          options.logger?.info("journal TLS certificate reloaded", {
            subject: loaded.material.subject,
            notAfter: loaded.material.notAfter.toISOString(),
          });
        } catch (error) {
          lastProblem = `the new certificate could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
          options.logger?.error("journal TLS certificate could not be reloaded", {
            errorMessage: lastProblem,
          });
          report(at);
          return;
        }
      }
      lastProblem = null;
      options.onStatus({ ok: true });
      return;
    }
    if (loaded.message !== lastProblem) {
      lastProblem = loaded.message;
      options.logger?.error(
        "journal TLS certificate on disk is not usable; the receiver keeps the certificate it has",
        { errorMessage: loaded.message, inUseValidUntil: current.notAfter.toISOString() },
      );
    }
    report(at);
  }

  function report(at: Date): void {
    if (at.getTime() >= current.notAfter.getTime()) {
      options.onStatus({
        ok: false,
        reason: "tls_expired",
        message: `the certificate in use expired on ${current.notAfter.toISOString()} and no usable replacement is in the certificate files${lastProblem ? ` (${lastProblem})` : ""}`,
      });
      return;
    }
    options.onStatus({ ok: true });
  }

  const timer = setInterval(check, options.intervalMs ?? CERTIFICATE_CHECK_INTERVAL_MS);
  timer.unref();
  return { check, stop: () => clearInterval(timer) };
}
