import { z } from "zod";
import {
  type Blocker,
  type DumpInfo,
  LEAD_TIME_PRESETS,
  type MaintenanceStatus,
  type Run,
} from "../../updater/protocol.js";

/**
 * Request and response documents of the Updates feature
 * (docs/ARCHITECTURE.md, Updates):
 *
 *   GET    /api/v1/updates                       the Updates tab: settings, check, releases, updater
 *   PATCH  /api/v1/updates/settings              enable the check, source, channel, access token
 *   POST   /api/v1/updates/check                 "Check now"
 *   POST   /api/v1/updates/maintenance           announce an update (version + lead time)
 *   DELETE /api/v1/updates/maintenance           cancel it (until it starts)
 *   POST   /api/v1/updates/maintenance/dismiss   clear a finished run from the tab
 *   GET    /api/v1/maintenance                   the maintenance state, for every signed-in user
 *
 * The access token is write-only: it is accepted by the PATCH and never appears in
 * any response, log line or audit entry (only `tokenSet`).
 */

export const UPDATE_CHANNELS = ["stable", "beta"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

/** Longest source URL and token the settings accept. */
export const MAX_SOURCE_URL_LENGTH = 300;
export const MAX_TOKEN_LENGTH = 500;

export const updateSettingsInputSchema = z
  .object({
    /** Turn the daily check and "Check now" on or off. */
    enabled: z.boolean().optional(),
    channel: z.enum(UPDATE_CHANNELS).optional(),
    /** A repository URL (GitHub, Forgejo or Gitea); null goes back to the default source. */
    sourceUrl: z.string().trim().max(MAX_SOURCE_URL_LENGTH).nullable().optional(),
    /** An access token for a private repository: a string sets or replaces it, null removes it. */
    token: z.string().trim().min(1).max(MAX_TOKEN_LENGTH).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "Nothing to change.",
  });
export type UpdateSettingsInput = z.infer<typeof updateSettingsInputSchema>;

export const scheduleUpdateInputSchema = z
  .object({
    /** The release to install: one of `releases[].version` of the last check. */
    version: z.string().trim().min(1).max(64),
    /** Seconds until the update starts; one of `leadTimes`. */
    leadSeconds: z
      .number()
      .int()
      .refine((value) => (LEAD_TIME_PRESETS as readonly number[]).includes(value), {
        message: "Choose one of the offered lead times.",
      }),
  })
  .strict();
export type ScheduleUpdateInput = z.infer<typeof scheduleUpdateInputSchema>;

/** Why a check found nothing: machine-readable, translated by the client. */
export const CHECK_ERROR_CODES = [
  "rate_limited",
  "unauthorized",
  "not_found",
  "forbidden",
  "server_error",
  "network",
  "timeout",
  "invalid_response",
  "no_release",
  "redirect",
] as const;
export type CheckErrorCode = (typeof CHECK_ERROR_CODES)[number];

export interface CheckError {
  code: CheckErrorCode;
  /** The HTTP status when the server answered. */
  status: number | null;
  /** When a rate limit is lifted, if the server said. */
  retryAt: string | null;
  /** A short technical hint (never a header, a URL with credentials or the token). */
  detail: string | null;
}

export interface ReleaseView {
  /** `1.2.3` or `1.2.3-rc.1` (no `v`). */
  version: string;
  /** The tag as published (`v1.2.3`). */
  tag: string;
  name: string | null;
  publishedAt: string | null;
  /** The release page (release notes). */
  url: string | null;
  /** Marked as pre-release or carries a semantic-version pre-release tag. */
  prerelease: boolean;
  /** Release notes as Markdown source, cut at 20,000 characters. Render sanitized. */
  notes: string | null;
  notesTruncated: boolean;
  /** Image digests the release published (`sha256:...`), when it did. */
  digests: { app?: string; web?: string };
}

export type SourceProvider = "github" | "forgejo" | "feed";
export type SourceOrigin = "default" | "settings" | "environment";

export interface SourceView {
  origin: SourceOrigin;
  /** The repository URL, or the feed URL for a feed-only environment override. */
  url: string;
  provider: SourceProvider;
  /** `owner/repo` when the source is a repository. */
  repository: string | null;
  isDefault: boolean;
}

export type UpdaterAvailability = "unavailable" | "ready" | "blocked" | "busy" | "demo";

export interface UpdaterView {
  /**
   * unavailable  no updater answers (not started: show the manual steps)
   * ready        an update can be announced
   * blocked      it answers but cannot update (see `blockers`)
   * busy         an update is announced or running
   * demo         the demo installation is read-only
   */
  state: UpdaterAvailability;
  blockers: Blocker[];
  /**
   * The updater answers but speaks a protocol this version does not understand
   * (it was not restarted after an update): `state` is `unavailable` and the tab
   * says to recreate the updater (`docker compose --profile updater up -d updater`).
   */
  incompatible: boolean;
  /** Version of the running updater; differs from `running` when the updater was not restarted after an update. */
  version: string | null;
  runner: "cli" | "helper" | null;
  dumps: DumpInfo[];
  checkedAt: string | null;
}

/** What the browser sees while a maintenance is announced or running (any signed-in user). */
export type MaintenanceView = MaintenanceStatus & {
  /** The version the api answering this request runs; a change means the update took effect. */
  runningVersion: string | null;
};

/** The current or last run as an administrator sees it (`requestedBy.ip` removed). */
export type RunView = Omit<Run, "requestedBy"> & {
  requestedBy: { userId: string | null; label: string };
};

export interface UpdatesView {
  running: string | null;
  demo: boolean;
  settings: {
    /** The stored switch of the update check. */
    enabled: boolean;
    channel: UpdateChannel;
    /** The stored repository URL; null means the default source. */
    sourceUrl: string | null;
    /** An access token is stored (its value is never returned). */
    tokenSet: boolean;
  };
  /** `RESTOW_UPDATE_CHECK_URL` when set and valid: it wins over the stored source and switch. */
  environmentOverride: { url: string } | null;
  source: SourceView;
  /** `image` pulls the release image, `source` builds it from the repository; derived from the source. */
  mode: "image" | "source";
  /**
   * Whether the updater would install from this source: always for `image` mode;
   * for `source` mode only when the operator named the repository in
   * RESTOW_UPDATER_SOURCE_HOSTS. null when no updater answers (or the demo).
   */
  sourceAllowed: boolean | null;
  check: {
    /** The check runs (the stored switch is on, or the environment override is set). */
    enabled: boolean;
    state: "disabled" | "pending" | "ok" | "failed";
    checkedAt: string | null;
    nextCheckAt: string | null;
    /** Why the last check failed; the last good result stays visible next to it. */
    error: CheckError | null;
  };
  /** Newest release of the channel, when the check ran. */
  latest: ReleaseView | null;
  updateAvailable: boolean | null;
  /** Releases newer than the running version in this channel, newest first (at most 10). */
  releases: ReleaseView[];
  updater: UpdaterView;
  leadTimes: readonly number[];
  maintenance: MaintenanceView;
  /** The current or last update run; null when there never was one. */
  run: RunView | null;
}
