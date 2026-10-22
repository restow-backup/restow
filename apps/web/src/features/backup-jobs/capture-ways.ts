import type { GatedFeature } from "@/lib/api";

import type { ArchiveCaptureSettings, CaptureKind } from "./api.js";

/**
 * The archive's capture ways in a mail job (docs/ARCHIVE.md "Erfassungswege"), as data: which
 * ways fit which kind of mail object, the defaults, and what the API refuses. Mirrors
 * packages/db archive-capture.ts; pure, so it is tested without a browser.
 */

/** The key a capture kind's ways are stored under (`imap_microsoft` shares the IMAP ways). */
export type CaptureSettingsKey = keyof ArchiveCaptureSettings;

/** A job's ways with every kind present. */
export type CaptureWays = Required<ArchiveCaptureSettings>;

export const CAPTURE_SETTINGS_KEYS: readonly CaptureSettingsKey[] = ["m365", "imap", "google"];

/** The ways of a kind the job does not mention (packages/db `DEFAULT_ARCHIVE_CAPTURE`). */
export const DEFAULT_CAPTURE_WAYS: CaptureWays = {
  m365: { graph: true, journal: false },
  imap: { sync: true, forward: false },
  google: { sync: true, forward: false },
};

export function captureSettingsKey(kind: CaptureKind): CaptureSettingsKey {
  return kind === "m365" ? "m365" : kind === "google" ? "google" : "imap";
}

/** The ways with the defaults filled in for every kind the settings leave out. */
export function effectiveCaptureWays(
  settings: ArchiveCaptureSettings | null | undefined,
): CaptureWays {
  return {
    m365: { ...(settings?.m365 ?? DEFAULT_CAPTURE_WAYS.m365) },
    imap: { ...(settings?.imap ?? DEFAULT_CAPTURE_WAYS.imap) },
    google: { ...(settings?.google ?? DEFAULT_CAPTURE_WAYS.google) },
  };
}

/** `echt` (at transport, before any user can touch the mail) or `zeitnah` (from the mailbox). */
export type CaptureAssurance = "transport" | "mailbox";

/** One way a kind of mail object can be captured by. */
export interface CaptureWayOption {
  /** The field in the kind's settings. */
  field: "graph" | "journal" | "sync" | "forward";
  assurance: CaptureAssurance;
  /** The gated feature (`/me` features) the way needs. */
  feature: GatedFeature;
}

/**
 * The ways each kind offers, strongest first: Microsoft 365 by Graph or Exchange journaling;
 * IMAP accounts (and Google Workspace) by IMAP sync or a copy the provider forwards.
 */
export const CAPTURE_WAY_OPTIONS: Readonly<
  Record<CaptureSettingsKey, readonly CaptureWayOption[]>
> = {
  m365: [
    { field: "graph", assurance: "mailbox", feature: "archive.mailboxCapture" },
    { field: "journal", assurance: "transport", feature: "archive.smtpCapture" },
  ],
  imap: [
    { field: "sync", assurance: "mailbox", feature: "archive.mailboxCapture" },
    { field: "forward", assurance: "transport", feature: "archive.smtpCapture" },
  ],
  google: [
    { field: "sync", assurance: "mailbox", feature: "archive.mailboxCapture" },
    { field: "forward", assurance: "transport", feature: "archive.smtpCapture" },
  ],
};

/** Whether a way is chosen in the job's settings. */
export function wayChosen(
  ways: CaptureWays,
  key: CaptureSettingsKey,
  field: CaptureWayOption["field"],
): boolean {
  return Boolean((ways[key] as Record<string, boolean>)[field]);
}

/** The settings with one way switched. */
export function withWay(
  ways: CaptureWays,
  key: CaptureSettingsKey,
  field: CaptureWayOption["field"],
  on: boolean,
): CaptureWays {
  return { ...ways, [key]: { ...ways[key], [field]: on } } as CaptureWays;
}

/** The setting keys of the kinds, each once, in the order the editor shows them. */
export function captureKeysOf(kinds: Iterable<CaptureKind>): CaptureSettingsKey[] {
  const present = new Set([...kinds].map(captureSettingsKey));
  return CAPTURE_SETTINGS_KEYS.filter((key) => present.has(key));
}

/** The keys of the kinds that have no way chosen: the API refuses those (archive_capture_no_way). */
export function keysWithoutWay(
  ways: CaptureWays,
  kinds: Iterable<CaptureKind>,
): CaptureSettingsKey[] {
  return captureKeysOf(kinds).filter((key) =>
    CAPTURE_WAY_OPTIONS[key].every((option) => !wayChosen(ways, key, option.field)),
  );
}

/** Whether two settings choose the same ways (the defaults filled in). */
export function sameCaptureWays(
  a: ArchiveCaptureSettings | null | undefined,
  b: ArchiveCaptureSettings | null | undefined,
): boolean {
  const left = effectiveCaptureWays(a);
  const right = effectiveCaptureWays(b);
  return CAPTURE_SETTINGS_KEYS.every((key) =>
    CAPTURE_WAY_OPTIONS[key].every(
      (option) => wayChosen(left, key, option.field) === wayChosen(right, key, option.field),
    ),
  );
}

/**
 * The capture kinds a mail job covers: for scope "all" every kind the tenant has
 * (`mailSourceKinds` of the defaults), else the kinds of the chosen objects (an object whose
 * kind is not known yet counts once its list has loaded).
 */
export function captureKindsOfScope(
  scopeMode: "all" | "selected",
  selected: readonly { captureKind?: CaptureKind | null }[],
  mailSourceKinds: readonly CaptureKind[] | undefined,
): CaptureKind[] {
  const kinds =
    scopeMode === "all"
      ? (mailSourceKinds ?? [])
      : selected.flatMap((member) => (member.captureKind ? [member.captureKind] : []));
  return [...new Set(kinds)];
}

/** Whether the job asks for a way that needs an address Restow hands out (journal or forwarding). */
export function needsJournal(ways: CaptureWays, kinds: readonly CaptureKind[]): boolean {
  return kinds.includes("m365") && ways.m365.journal;
}

export function forwardingChosen(ways: CaptureWays, kinds: readonly CaptureKind[]): boolean {
  return captureKeysOf(kinds).some((key) => key !== "m365" && wayChosen(ways, key, "forward"));
}

/**
 * The kinds a refused save names (problem path `["archiveCapture", key]`) among those the
 * editor shows; empty when the editor shows none of them (the message then stands on top).
 */
export function serverCaptureKeys(
  path: readonly string[] | undefined,
  kinds: readonly CaptureKind[],
): CaptureSettingsKey[] {
  const shown = captureKeysOf(kinds);
  const named = path?.[1];
  return shown.filter((key) => key === named);
}
