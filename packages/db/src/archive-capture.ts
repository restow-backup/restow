/**
 * Which capture ways fit a mail object, and which ways a mail job asks for (docs/ARCHIVE.md
 * "Erfassungswege", 0.4.4).
 *
 * The capture kind of a mail object decides which ways the job editor offers for it:
 *
 *   m365            a Microsoft 365 mailbox: Graph capture and/or Exchange journaling
 *   google          an IMAP account at Google (an OAuth2 source of Google, or the Gmail
 *                   IMAP host): IMAP sync and/or Workspace routing to the archive address
 *   imap_microsoft  an IMAP account on a Microsoft host: IMAP ways are offered, a Microsoft
 *                   365 source is recommended instead
 *   imap            any other IMAP account: IMAP sync and/or a forwarded copy
 *   (null)          OneDrive, sites and imported mailboxes: nothing to capture
 *
 * The kind is derived, never stored: {@link captureKindOf} for one object (the API's job
 * DTO) and {@link captureKindSql} for many (the worker's reconcile, one statement), both
 * the same rules.
 */
import { type SQL, sql } from "drizzle-orm";
import type { ArchiveCaptureSettings } from "./schema/backup-jobs.js";

export type CaptureKind = "m365" | "google" | "imap" | "imap_microsoft";

export const CAPTURE_KINDS: readonly CaptureKind[] = ["m365", "google", "imap", "imap_microsoft"];

/** Microsoft's IMAP servers (Microsoft 365 and Outlook.com). */
export const MICROSOFT_IMAP_HOSTS: readonly string[] = [
  "outlook.office365.com",
  "outlook.office.com",
  "imap-mail.outlook.com",
  "imap.outlook.com",
];

/** Google's IMAP servers (Gmail and Google Workspace). */
export const GOOGLE_IMAP_HOSTS: readonly string[] = ["imap.gmail.com", "imap.googlemail.com"];

function normalizeHost(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/\.+$/, "");
}

/** Whether `host` is one of Microsoft's IMAP servers. */
export function isMicrosoftImapHost(host: string | null | undefined): boolean {
  return MICROSOFT_IMAP_HOSTS.includes(normalizeHost(host));
}

/** Whether `host` is one of Google's IMAP servers. */
export function isGoogleImapHost(host: string | null | undefined): boolean {
  return GOOGLE_IMAP_HOSTS.includes(normalizeHost(host));
}

/** What the capture kind is derived from. */
export interface CaptureKindInput {
  /** `protected_objects.kind`. */
  readonly objectKind: string;
  /** `sources.kind`. */
  readonly sourceKind: string;
  /** `sources.host` (IMAP). */
  readonly host?: string | null;
  /** `sources.config` (authKind, oauth2Provider). */
  readonly config?: { readonly authKind?: string; readonly oauth2Provider?: string } | null;
}

/** The capture kind of one mail object (see the module docstring); null = none. */
export function captureKindOf(input: CaptureKindInput): CaptureKind | null {
  if (input.objectKind === "mailbox") {
    return "m365";
  }
  if (input.objectKind !== "imap" || input.sourceKind !== "imap") {
    return null;
  }
  const config = input.config ?? {};
  if (
    (config.authKind === "oauth2" && config.oauth2Provider === "google") ||
    isGoogleImapHost(input.host)
  ) {
    return "google";
  }
  return isMicrosoftImapHost(input.host) ? "imap_microsoft" : "imap";
}

function hostList(hosts: readonly string[]): SQL {
  return sql.join(
    hosts.map((host) => sql`${host}`),
    sql`, `,
  );
}

/**
 * {@link captureKindOf} as a SQL expression (text, or null) over a `protected_objects` and
 * a `sources` row, given the aliases they have in the statement.
 */
export function captureKindSql(object: string, source: string): SQL {
  const po = sql.raw(`"${object}"`);
  const s = sql.raw(`"${source}"`);
  const host = sql`rtrim(lower(btrim(coalesce(${s}.host, ''))), '.')`;
  return sql`(case
    when ${po}.kind = 'mailbox' then 'm365'
    when ${po}.kind = 'imap' and ${s}.kind = 'imap' then (case
      when (${s}.config->>'authKind' = 'oauth2' and ${s}.config->>'oauth2Provider' = 'google')
        or ${host} in (${hostList(GOOGLE_IMAP_HOSTS)}) then 'google'
      when ${host} in (${hostList(MICROSOFT_IMAP_HOSTS)}) then 'imap_microsoft'
      else 'imap' end)
    else null end)`;
}

/** The key of {@link ArchiveCaptureSettings} a capture kind's ways are under. */
export function captureSettingsKey(kind: CaptureKind): keyof ArchiveCaptureSettings {
  return kind === "m365" ? "m365" : kind === "google" ? "google" : "imap";
}

/** The ways a job with archive on uses for a kind it does not mention. */
export const DEFAULT_ARCHIVE_CAPTURE: Required<ArchiveCaptureSettings> = {
  m365: { graph: true, journal: false },
  imap: { sync: true, forward: false },
  google: { sync: true, forward: false },
};

/** A job's capture ways with the defaults filled in for every kind it does not mention. */
export function effectiveArchiveCapture(
  settings: ArchiveCaptureSettings | null | undefined,
): Required<ArchiveCaptureSettings> {
  return {
    m365: settings?.m365 ?? DEFAULT_ARCHIVE_CAPTURE.m365,
    imap: settings?.imap ?? DEFAULT_ARCHIVE_CAPTURE.imap,
    google: settings?.google ?? DEFAULT_ARCHIVE_CAPTURE.google,
  };
}

/** The mailbox way (stream) a capture kind is captured by, if the job chose it. */
export function mailboxCaptureWay(
  kind: CaptureKind,
  settings: ArchiveCaptureSettings | null | undefined,
): "graph_sync" | "imap_sync" | null {
  const ways = effectiveArchiveCapture(settings);
  if (kind === "m365") {
    return ways.m365.graph ? "graph_sync" : null;
  }
  const imap = kind === "google" ? ways.google : ways.imap;
  return imap.sync ? "imap_sync" : null;
}

/**
 * Whether a kind's ways still wait for a choice: an IMAP or Google kind of a job that archived
 * before 0.4.4 (migration 0062 marked it `pending`), with no way chosen since.
 */
export function captureChoicePending(
  settings: ArchiveCaptureSettings | null | undefined,
  kind: CaptureKind,
): boolean {
  if (kind === "m365") {
    return false;
  }
  const ways = kind === "google" ? settings?.google : settings?.imap;
  return ways?.pending === true && !ways.sync && !ways.forward;
}

/**
 * The settings to store for a job: a kind keeps its `pending` marker only while it still has no
 * way and the job had the marker before (`before`; nothing for a new job). Nobody sets the
 * marker through the API; choosing a way clears it.
 */
export function withPendingMarkers(
  next: ArchiveCaptureSettings,
  before: ArchiveCaptureSettings | null | undefined,
): ArchiveCaptureSettings {
  const result: ArchiveCaptureSettings = { ...next };
  for (const key of ["imap", "google"] as const) {
    const ways = next[key];
    if (!ways) {
      continue;
    }
    const { pending: _pending, ...plain } = ways;
    const keep =
      ways.pending === true && !ways.sync && !ways.forward && before?.[key]?.pending === true;
    result[key] = keep ? { ...plain, pending: true } : plain;
  }
  return result;
}

/**
 * Whether the settings give every kind in `kinds` at least one way; returns the kinds that
 * have none (the API refuses those). A kind still waiting for a choice since the update to
 * 0.4.4 ({@link captureChoicePending}) is not missing: the job stays as it was until someone
 * chooses.
 */
export function kindsWithoutWay(
  settings: ArchiveCaptureSettings | null | undefined,
  kinds: Iterable<CaptureKind>,
): CaptureKind[] {
  const ways = effectiveArchiveCapture(settings);
  const missing: CaptureKind[] = [];
  for (const kind of new Set(kinds)) {
    const none =
      kind === "m365"
        ? !ways.m365.graph && !ways.m365.journal
        : !(kind === "google" ? ways.google : ways.imap).sync &&
          !(kind === "google" ? ways.google : ways.imap).forward;
    if (none && !captureChoicePending(settings, kind)) {
      missing.push(kind);
    }
  }
  return missing;
}
