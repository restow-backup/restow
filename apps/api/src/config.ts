import { docsTroubleshootingUrl, mailfiles } from "@restow/core";
import { PRODUCT_NAME_ENV, configureProductName, normalizeProductName } from "@restow/i18n";
import { trustedProxyEntries } from "./lib/forwarded.js";

/**
 * Runtime configuration, read from the environment.
 *
 * No secret value is ever hardcoded here: every secret is read from the process
 * environment (see the repo `.env.example`) and only referenced, never logged.
 * Missing required values are reported by {@link missingRequiredConfig}; the api
 * refuses to start while any is missing (server.ts).
 */

export type OperatingMode = "local" | "public";
export type MailTransport = "smtp" | "graph";

/** How an SMTP connection uses TLS, as chosen in the setup wizard or the settings. */
export type SmtpSecurityMode = "starttls" | "implicit" | "none";

export interface SmtpConfig {
  host: string | undefined;
  port: number | undefined;
  /** Implicit TLS (port 465). STARTTLS is negotiated on the plain port otherwise. */
  secure: boolean;
  /**
   * The operator's explicit choice (setup wizard, settings): `starttls` refuses
   * to send without the upgrade, `none` never upgrades. Unset for configuration
   * from the environment, where STARTTLS is used whenever the server offers it.
   */
  security?: SmtpSecurityMode;
  username: string | undefined;
  /** Secret; only held in memory for the transport, never persisted to `settings`. */
  password: string | undefined;
  from: string | undefined;
}

/**
 * Entra app registrations from the environment. The backup app's values are
 * optional: without them the registration saved under Settings → Microsoft 365
 * is used (features/sources/entra.ts resolves which one applies).
 */
export interface EntraConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  clientCertPath: string | undefined;
  /** ENTRA_AUTHORITY_HOST, for sovereign clouds. */
  authorityHost: string | undefined;
  ssoClientId: string | undefined;
  ssoClientSecret: string | undefined;
  /**
   * `RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN=true`: switches the Microsoft (Entra ID)
   * sign-in on, for developers only. It is off in every normal installation even
   * with the SSO app configured above: nothing in this release links an account to
   * a Microsoft identity, and sign-in never creates one, so nobody could use the
   * button. While it is off the login page, the invitation dialog and the sign-in
   * endpoints behave as if the sign-in did not exist.
   */
  ssoExperimental: boolean;
}

export interface Config {
  nodeEnv: string;
  port: number;
  /** Public origin the browser uses (origin only), e.g. https://restow.example.com. */
  publicUrl: string | undefined;
  /** Internal API base URL. */
  apiUrl: string | undefined;
  /**
   * `RESTOW_EDGE_TRUSTED_PROXIES`: the reverse proxies in front of the Caddy
   * edge whose `X-Forwarded-For` entries are believed (lib/forwarded.ts). The
   * same variable the edge reads, with the same default (loopback only) and
   * the same `private_ranges` shorthand, already expanded here.
   */
  trustedProxies: string[];
  /**
   * `RESTOW_PRODUCT_NAME`: the product name every text, mail, report and the
   * web app show (the branding; White Label builds on it). Normalized, never
   * empty: the default (`DEFAULT_PRODUCT_NAME`) when the variable is unset.
   */
  productName: string;
  operatingMode: OperatingMode | undefined;
  /**
   * The application role: subject to Row Level Security, used for everything
   * a tenant does (`withTenantTx`). Never a superuser, never BYPASSRLS.
   */
  databaseUrl: string;
  /**
   * The installation role (BYPASSRLS): only for the lookups made before a
   * tenant is known and for installation-level data (packages/db/sql/rls.sql).
   */
  databaseProviderUrl: string;
  betterAuthSecret: string;
  /**
   * `RESTOW_SETUP_TOKEN`: the one-time setup token the wizard asks for
   * (lib/setup-token.ts). Unset, the api generates one and prints it to its
   * log while the installation is not set up.
   */
  setupToken: string | undefined;
  /**
   * Base64 32-byte key-encryption key (KEK) that wraps every tenant DEK and seals
   * provider-level secrets. Held only in memory; never logged.
   */
  masterKey: string | undefined;
  entra: EntraConfig;
  /** Entra tenant id used for the notification `graph` transport (client credentials). */
  graphMailTenantId: string | undefined;
  mailTransport: MailTransport | undefined;
  smtp: SmtpConfig;
  graphMailSender: string | undefined;
  /**
   * `IMAP_ALLOW_PRIVATE_NETWORKS`: every IMAP source may reach loopback and
   * private networks. Off by default; then only a provider admin can connect a
   * source to an internal server (features/sources/imap-host.ts).
   */
  imapAllowPrivateNetworks: boolean;
  /**
   * `RESTOW_DOCS_TROUBLESHOOTING_URL`: where the failure explanations point for
   * more help. The one place this address lives (defaults to the public docs);
   * an installation may point it at its own runbook.
   */
  docsTroubleshootingUrl: string;
  demo: DemoConfig;
  journal: JournalConfig;
  imports: ImportConfig;
  exports: ExportConfig;
  preview: PreviewConfig;
}

/**
 * Mail file export (docs/IMPORT.md): how long a finished export stays
 * downloadable. The worker sets `mail_exports.expires_at` when the file is
 * complete; the API only reads it and falls back to this lifetime for a
 * completed export that has none yet.
 */
export interface ExportConfig {
  /** `EXPORT_TTL_HOURS`: hours a finished export file is kept. */
  ttlHours: number;
  /**
   * `EXPORT_MAX_TENANT_BYTES`: bytes all unexpired export files of one tenant may take together.
   * A request is refused while the tenant is at the limit, an export that would cross it fails.
   */
  maxTenantBytes: number;
}

export const DEFAULT_EXPORT_TTL_HOURS = 24;
export const DEFAULT_EXPORT_MAX_TENANT_BYTES = 50 * 1024 * 1024 * 1024;

/**
 * The mail preview and the attachment download parse stored (possibly imported, hostile) messages
 * in child processes with a memory and a time limit (features/snapshots/preview-isolated.ts).
 */
export interface PreviewConfig {
  /** `PREVIEW_PARSE_WORKERS`: processes that parse at the same time, 1 to 8. */
  workers: number;
  /**
   * `PREVIEW_TIMEOUT_MS`: how long the formatted view of one message may take before its process is
   * killed; the plain-text fallback gets half of it.
   */
  timeoutMs: number;
}

export const DEFAULT_PREVIEW_PARSE_WORKERS = 2;
export const DEFAULT_PREVIEW_TIMEOUT_MS = 10_000;

/**
 * Mail file import (docs/IMPORT.md): the server-side import folder and the
 * limits of chunked uploads. The worker reads the same variables.
 */
export interface ImportConfig {
  /** `IMPORT_DIR`: the server-side import folder; the feature is off while it is not a readable directory. */
  dir: string;
  /** `IMPORT_MAX_FILE_BYTES`: largest single upload. */
  maxFileBytes: number;
  /** `IMPORT_UPLOAD_TTL_HOURS`: how long an unfinished or unused upload is kept. */
  uploadTtlHours: number;
  /**
   * `IMPORT_MAX_STAGING_BYTES`: declared bytes of all uploads of one tenant that still hold staged
   * segments (open uploads and the files of an import that has not ended). A new upload is refused
   * beyond it.
   */
  maxStagingBytes: number;
  /** `IMPORT_SEGMENT_BYTES`: plaintext bytes of one upload segment (clamped to the supported range). */
  segmentBytes: number;
  /** `IMPORT_MAX_MESSAGE_BYTES`: largest single message an import reads into memory. */
  maxMessageBytes: number;
}

export const DEFAULT_IMPORT_DIR = "/var/lib/restow/import";
export const DEFAULT_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_IMPORT_UPLOAD_TTL_HOURS = 48;
export const DEFAULT_IMPORT_MAX_STAGING_BYTES = 100 * 1024 * 1024 * 1024;
export const DEFAULT_IMPORT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;

/**
 * The archive's SMTP journal receiver (docs/IMAP.md, "SMTP-Journal-Empfänger";
 * docs/ARCHITECTURE.md: it runs inside the `api` role). Off (no listener
 * started) unless `JOURNAL_SMTP_PORT` is set — a fresh install never opens an
 * unconfigured mail port.
 */
export interface JournalConfig {
  port: number | undefined;
  /** The MX hostname reports arrive at (`archive.<domain>`), used to build the setup page's address. */
  hostname: string | undefined;
  /**
   * STARTTLS certificate chain and private key, PEM files on disk (never
   * committed, see .gitignore). Without both, the receiver does not start
   * (receiver state reason `tls_not_configured`) unless `allowInsecure` is
   * set: it never falls back to a built-in certificate.
   */
  tlsCertPath: string | undefined;
  tlsKeyPath: string | undefined;
  /**
   * `JOURNAL_ALLOW_INSECURE=true`: start the receiver without a certificate and
   * without offering STARTTLS at all. For local development and the release
   * smoke only, never for a production installation: Exchange Online requires
   * TLS and would not deliver, and mail would cross the network unencrypted.
   * Ignored while a certificate is configured (a broken certificate never
   * degrades to plain text).
   */
  allowInsecure: boolean;
  /** Maximum accepted message size in bytes (docs/IMAP.md: 150 MB default). */
  maxSizeBytes: number;
}

/**
 * Public demo mode (deploy/demo/README.md): a read-only, self-resetting
 * installation for demo.restowbackup.com. `enabled` gates the demo guard
 * (middleware/demo-guard.ts) and the TOTP bypass for the demo account alone
 * (lib/session-assurance.ts); every other account keeps full enforcement.
 * Off by default, so a normal deployment is unaffected (see demo.test.ts).
 */
export interface DemoConfig {
  enabled: boolean;
  /** The one account the demo guard exempts from TOTP; created by the seed. */
  email: string | undefined;
  /**
   * Shown next to `email` on the login page's demo panel (prefilled,
   * one-click sign-in). Intentionally public: a demo has no real secret to
   * keep, only a public URL and synthetic data.
   */
  password: string | undefined;
  /**
   * Shared secret the deploy/demo seed process sends as
   * `X-Restow-Demo-Seed-Token` to bootstrap the demo tenants, sources and
   * schedules through the same guarded endpoints a visitor uses
   * (middleware/demo-guard.ts). Unset outside the demo compose.
   */
  seedToken: string | undefined;
}

type Env = Record<string, string | undefined>;

function str(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function int(env: Env, name: string): number | undefined {
  const value = str(env, name);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** A positive integer from the environment; anything else (unset, zero, negative, text) is the default. */
function positiveInt(env: Env, name: string, fallback: number): number {
  const value = int(env, name);
  return value !== undefined && value > 0 ? value : fallback;
}

function bool(env: Env, name: string): boolean {
  return (str(env, name) ?? "").toLowerCase() === "true";
}

function toOperatingMode(value: string | undefined): OperatingMode | undefined {
  return value === "local" || value === "public" ? value : undefined;
}

function toMailTransport(value: string | undefined): MailTransport | undefined {
  return value === "smtp" || value === "graph" ? value : undefined;
}

/** Build the configuration from an environment map (defaults to `process.env`). */
export function loadConfig(env: Env = process.env): Config {
  return {
    nodeEnv: str(env, "NODE_ENV") ?? "development",
    port: int(env, "PORT") ?? 3000,
    publicUrl: str(env, "RESTOW_PUBLIC_URL"),
    apiUrl: str(env, "RESTOW_API_URL"),
    trustedProxies: trustedProxyEntries(str(env, "RESTOW_EDGE_TRUSTED_PROXIES")),
    productName: normalizeProductName(str(env, PRODUCT_NAME_ENV)),
    operatingMode: toOperatingMode(str(env, "RESTOW_MODE")),
    databaseUrl: str(env, "DATABASE_URL") ?? "",
    databaseProviderUrl: str(env, "DATABASE_PROVIDER_URL") ?? "",
    betterAuthSecret: str(env, "BETTER_AUTH_SECRET") ?? "",
    setupToken: str(env, "RESTOW_SETUP_TOKEN")?.trim() || undefined,
    masterKey: str(env, "RESTOW_MASTER_KEY"),
    entra: {
      clientId: str(env, "ENTRA_CLIENT_ID"),
      clientSecret: str(env, "ENTRA_CLIENT_SECRET"),
      clientCertPath: str(env, "ENTRA_CLIENT_CERT_PATH"),
      authorityHost: str(env, "ENTRA_AUTHORITY_HOST"),
      ssoClientId: str(env, "ENTRA_SSO_CLIENT_ID"),
      ssoClientSecret: str(env, "ENTRA_SSO_CLIENT_SECRET"),
      ssoExperimental: bool(env, "RESTOW_EXPERIMENTAL_MICROSOFT_SIGN_IN"),
    },
    graphMailTenantId: str(env, "GRAPH_MAIL_TENANT_ID"),
    mailTransport: toMailTransport(str(env, "MAIL_TRANSPORT")),
    smtp: {
      host: str(env, "SMTP_HOST"),
      port: int(env, "SMTP_PORT"),
      secure: bool(env, "SMTP_SECURE"),
      username: str(env, "SMTP_USER"),
      password: str(env, "SMTP_PASSWORD"),
      from: str(env, "SMTP_FROM"),
    },
    graphMailSender: str(env, "GRAPH_MAIL_SENDER"),
    imapAllowPrivateNetworks: bool(env, "IMAP_ALLOW_PRIVATE_NETWORKS"),
    docsTroubleshootingUrl: docsTroubleshootingUrl(str(env, "RESTOW_DOCS_TROUBLESHOOTING_URL")),
    demo: {
      enabled: bool(env, "RESTOW_DEMO"),
      email: str(env, "RESTOW_DEMO_EMAIL"),
      password: str(env, "RESTOW_DEMO_PASSWORD"),
      seedToken: str(env, "RESTOW_DEMO_SEED_TOKEN"),
    },
    journal: {
      port: int(env, "JOURNAL_SMTP_PORT"),
      hostname: str(env, "JOURNAL_HOSTNAME"),
      tlsCertPath: str(env, "JOURNAL_TLS_CERT_PATH"),
      tlsKeyPath: str(env, "JOURNAL_TLS_KEY_PATH"),
      allowInsecure: bool(env, "JOURNAL_ALLOW_INSECURE"),
      maxSizeBytes:
        int(env, "JOURNAL_MAX_SIZE_MB") !== undefined
          ? (int(env, "JOURNAL_MAX_SIZE_MB") as number) * 1024 * 1024
          : 150 * 1024 * 1024,
    },
    imports: {
      dir: str(env, "IMPORT_DIR") ?? DEFAULT_IMPORT_DIR,
      maxFileBytes: positiveInt(env, "IMPORT_MAX_FILE_BYTES", DEFAULT_IMPORT_MAX_FILE_BYTES),
      uploadTtlHours: positiveInt(env, "IMPORT_UPLOAD_TTL_HOURS", DEFAULT_IMPORT_UPLOAD_TTL_HOURS),
      maxStagingBytes: positiveInt(
        env,
        "IMPORT_MAX_STAGING_BYTES",
        DEFAULT_IMPORT_MAX_STAGING_BYTES,
      ),
      segmentBytes: mailfiles.clampSegmentSize(int(env, "IMPORT_SEGMENT_BYTES")),
      maxMessageBytes: positiveInt(
        env,
        "IMPORT_MAX_MESSAGE_BYTES",
        DEFAULT_IMPORT_MAX_MESSAGE_BYTES,
      ),
    },
    exports: {
      ttlHours: positiveInt(env, "EXPORT_TTL_HOURS", DEFAULT_EXPORT_TTL_HOURS),
      maxTenantBytes: positiveInt(env, "EXPORT_MAX_TENANT_BYTES", DEFAULT_EXPORT_MAX_TENANT_BYTES),
    },
    preview: {
      workers: Math.min(
        8,
        positiveInt(env, "PREVIEW_PARSE_WORKERS", DEFAULT_PREVIEW_PARSE_WORKERS),
      ),
      timeoutMs: positiveInt(env, "PREVIEW_TIMEOUT_MS", DEFAULT_PREVIEW_TIMEOUT_MS),
    },
  };
}

/** Names of required environment values that are not set. */
export function missingRequiredConfig(config: Config): string[] {
  const missing: string[] = [];
  if (config.databaseUrl.length === 0) {
    missing.push("DATABASE_URL");
  }
  if (config.databaseProviderUrl.length === 0) {
    missing.push("DATABASE_PROVIDER_URL");
  }
  if (config.betterAuthSecret.length === 0) {
    missing.push("BETTER_AUTH_SECRET");
  }
  if (config.masterKey === undefined) {
    missing.push("RESTOW_MASTER_KEY");
  }
  return missing;
}

/**
 * A dangerous half-configured demo state: `RESTOW_DEMO_EMAIL`/
 * `RESTOW_DEMO_PASSWORD` are set (typically left over from a previous demo
 * phase or copied from deploy/demo/.env.example by mistake) but
 * `RESTOW_DEMO` is not exactly `"true"`. Demo mode being off must never
 * quietly leave a TOTP-free password account reachable in what looks like an
 * ordinary installation (security review finding 5); server.ts refuses to
 * start while this is non-null. Null whenever the configuration is
 * consistent, demo mode on or off.
 */
export function demoConfigConflict(config: Config): string | null {
  if (config.demo.enabled) {
    return null;
  }
  if (config.demo.email === undefined && config.demo.password === undefined) {
    return null;
  }
  return (
    'RESTOW_DEMO_EMAIL/RESTOW_DEMO_PASSWORD are set but RESTOW_DEMO is not "true". ' +
    "That would leave a password-only, TOTP-exempt account reachable outside demo mode. " +
    "Either set RESTOW_DEMO=true or remove RESTOW_DEMO_EMAIL/RESTOW_DEMO_PASSWORD."
  );
}

/** Process-wide configuration singleton. */
export const config: Config = loadConfig();

// The product name is branding, not a per-call value: set once here, so every
// text the api renders (mails, reports, problem details) names the same product.
configureProductName(config.productName);
