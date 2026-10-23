import { refuseHostBeforeConnect } from "@restow/core";
import type {
  Database,
  JobStartPause,
  PlannedUpdate,
  StoredUpdateCheck,
  StoredUpdateRelease,
} from "@restow/db";
import { notifications, settings } from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { loadInstallationTimeZone } from "../../lib/installation-time-zone.js";
import {
  hasPendingLicenseKey,
  removePendingLicenseKey,
  storePendingLicenseKey,
} from "../../lib/pending-license-key.js";
import { ProblemError } from "../../problem.js";
import { isUpdateAvailable, parseVersion } from "../../routes/v1/version.js";
import {
  defaultImageRepositories,
  fullBuildRepositories,
  imageVariantOf,
} from "../../updater/image-variant.js";
import {
  type Blocker,
  type JournalEvent,
  LEAD_TIME_PRESETS,
  type ScheduleRequest,
  type StateView,
} from "../../updater/protocol.js";
import {
  isSourceAllowed,
  isSourceHostListed,
  parseSourceAllowlist,
  SOURCE_ALLOWLIST_VARIABLE,
  sourceTargetOf,
} from "../../updater/source-policy.js";
import { announcedAgentVersion } from "../endpoints/distribution.js";
import { coveredReleaseOf, loadUpdateCoverage, type UpdateCoverage } from "./coverage.js";
import { type FetchLike, fetchReleases, releasesForChannel } from "./feed.js";
import {
  enterFleetPhase,
  type FleetCounts,
  type FleetStatus,
  fleetStatus,
  serverRunsPauseVersion,
  startFleetPhase,
} from "./fleet.js";
import {
  claimDrainedUpdate,
  insertJobPause,
  jobActivity,
  loadJobPause,
  removeJobPause,
  storedRequestOf,
} from "./job-pause.js";
import { raiseUpdateAvailable } from "./notify.js";
import {
  handoverAt,
  loadPlan,
  PLAN_LATE_LIMIT_MS,
  plannedStartsAt,
  storePlan,
  takePlan,
} from "./plan.js";
import type {
  CheckError,
  EditionView,
  JobActivityView,
  MaintenanceView,
  PendingLicenseKeyInput,
  PlannedUpdateView,
  ScheduleUpdateInput,
  SourceView,
  SwitchBuildInput,
  UpdaterView,
  UpdateSettingsInput,
  UpdatesView,
} from "./schemas.js";
import { loadUpdateRow, saveCheck, snapshotOf, type UpdateRow } from "./settings-store.js";
import { isDefaultSourceUrl, parseRepositoryUrl } from "./source.js";
import { newerThan, releasesOf, type UpdateStateCache } from "./state.js";
import { hasToken, removeToken, storeToken, tokenFor } from "./token.js";
import {
  type UpdaterClient,
  UpdaterRejectedError,
  UpdaterUnavailableError,
} from "./updater-client.js";
import {
  activePause,
  coverageViewOf,
  jobPauseViewOf,
  maintenanceSummaryOf,
  maintenanceViewOf,
  runToShow,
  toReleaseView,
  updaterViewOf,
} from "./views.js";

/**
 * The Updates feature (docs/ARCHITECTURE.md, Updates): the settings of the
 * update check, the check itself, the announcement of an update through the
 * updater, and the audit trail of all of it. The routes (routes.ts) are thin;
 * everything that decides something is here, with its collaborators injected
 * so the tests run it without a network, a database pool or a Docker daemon.
 */

export const UPDATE_AUDIT_ACTIONS = {
  check: "update.check",
  scheduled: "update.scheduled",
  cancelled: "update.cancelled",
  started: "update.started",
  succeeded: "update.succeeded",
  failed: "update.failed",
  settingsUpdated: "update.settings.updated",
  acknowledged: "update.acknowledged",
  /** A Community installation announced its switch to the full build. */
  switchScheduled: "update.build_switch.scheduled",
  /** New job starts paused for an update that waits for running jobs (#46). */
  jobsPaused: "update.jobs_paused",
  /** The pause of new job starts lifted (the update finished, was cancelled, failed or expired). */
  jobsResumed: "update.jobs_resumed",
  /** The server is updated; its Proxmox VE nodes and endpoint agents are told to update (0.4.2). */
  fleetStarted: "update.fleet_started",
  /** An update planned for a chosen time (0.4.2); cancelled with `update.cancelled`. */
  planned: "update.planned",
  /** A planned update could not be confirmed at its time (the reason is in the details). */
  planFailed: "update.plan_failed",
  /** A license key was stored for the full build, or removed again (never its text). */
  pendingLicenseKeyStored: "license.pending_key.stored",
  pendingLicenseKeyRemoved: "license.pending_key.removed",
} as const;

export const UPDATE_PROBLEMS = {
  invalidSource: "urn:restow:problem:invalid-update-source",
  overridden: "urn:restow:problem:update-settings-overridden",
  checkDisabled: "urn:restow:problem:update-check-disabled",
  updaterUnavailable: "urn:restow:problem:updater-unavailable",
  updaterBlocked: "urn:restow:problem:updater-blocked",
  busy: "urn:restow:problem:update-busy",
  running: "urn:restow:problem:update-running",
  notScheduled: "urn:restow:problem:update-not-scheduled",
  versionUnknown: "urn:restow:problem:update-version-unknown",
  runningUnknown: "urn:restow:problem:update-running-unknown",
  sourceUnsupported: "urn:restow:problem:update-source-unsupported",
  sourceNotAllowed: "urn:restow:problem:update-source-not-allowed",
  notVerifiable: "urn:restow:problem:update-not-verifiable",
  updaterError: "urn:restow:problem:updater-error",
  /** "Update nodes and agents now" with none reachable behind the server (0.4.3). */
  fleetCurrent: "urn:restow:problem:update-fleet-current",
  setupIncomplete: "urn:restow:problem:setup-incomplete",
  /** The build switch is refused: not a Community installation, or not the published images. */
  switchRefused: "urn:restow:problem:build-switch-refused",
  /** "Start now" while no update waits for running jobs. */
  notWaiting: "urn:restow:problem:update-not-waiting",
  /** The chosen time is not a valid moment: past, too far ahead, or skipped by a clock change. */
  invalidTime: "urn:restow:problem:update-invalid-time",
  /** The license key belongs on the license page of the full build. */
  licenseKeyNotPending: "urn:restow:problem:license-key-not-pending",
  /** The installed licence key does not cover the release (its update period ended before it). */
  notCovered: "urn:restow:problem:update-not-covered",
} as const;

/** The check runs once a day; after a failure it tries again after an hour at the earliest. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_RETRY_MS = 60 * 60 * 1000;
/** How often the pause of new job starts is advanced (#46). */
export const PAUSE_STEP_MS = 10_000;
/** A pause whose update was just handed over is not lifted on an idle updater before this. */
export const ANNOUNCE_GRACE_MS = 30_000;

export interface Actor {
  id: string | null;
  email: string;
  ip: string | null;
}

export const SYSTEM_ACTOR: Actor = { id: null, email: "system", ip: null };

export interface UpdateServiceDeps {
  /** The installation pool (BYPASSRLS): the settings row and the installation audit chain. */
  db: Database;
  state: UpdateStateCache;
  updater: UpdaterClient;
  env?: Record<string, string | undefined>;
  /** The demo installation sends nothing anywhere and cannot update. */
  demo?: boolean;
  fetch?: FetchLike;
  now?: () => Date;
  log?: (level: "info" | "warn" | "error", message: string, fields?: object) => void;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

/**
 * Whether the check may reach loopback or a private network: only where the
 * operator decided so, in the environment (the override URL, or the host named
 * in RESTOW_UPDATER_SOURCE_HOSTS, typically an internal Forgejo). A source the
 * tab names is otherwise fetched from public addresses only (feed.ts).
 */
export function privateNetworksAllowedFor(
  releasesUrl: string,
  origin: string,
  env: Record<string, string | undefined>,
): boolean {
  if (origin === "environment") {
    return true;
  }
  const { entries } = parseSourceAllowlist(env[SOURCE_ALLOWLIST_VARIABLE]);
  return isSourceHostListed(entries, new URL(releasesUrl).hostname);
}

/**
 * Whether the updater would build from this source: `source` mode needs the
 * repository in the operator's allowlist (RESTOW_UPDATER_SOURCE_HOSTS, read by the
 * updater and reported in its capabilities). Image mode needs nothing; null when
 * no updater answers.
 */
export function sourceAllowedBy(
  state: StateView | null,
  source: { isDefault: boolean; isAlpha?: boolean; archiveUrl: (tag: string) => string | null },
): boolean | null {
  if (source.isDefault || source.isAlpha) {
    return true;
  }
  if (!state) {
    return null;
  }
  const archiveUrl = source.archiveUrl("v0.0.0");
  const target = archiveUrl ? sourceTargetOf(archiveUrl) : null;
  if (!target) {
    return false;
  }
  const { entries } = parseSourceAllowlist(state.capabilities.sourceAllowlist.join(","));
  return isSourceAllowed(entries, target);
}

/** When the next scheduled check is due, from the cached result. */
export function nextCheckAt(check: StoredUpdateCheck | null, now: Date): Date {
  if (!check) {
    return now;
  }
  const checkedAt = Date.parse(check.checkedAt);
  if (check.state === "ok") {
    return new Date(checkedAt + CHECK_INTERVAL_MS);
  }
  const retryAt = check.error?.retryAt ? Date.parse(check.error.retryAt) : Number.NaN;
  return new Date(Math.max(checkedAt + CHECK_RETRY_MS, Number.isNaN(retryAt) ? 0 : retryAt));
}

export class UpdateService {
  private checking: Promise<void> | null = null;
  private incompatible = false;

  constructor(private readonly deps: UpdateServiceDeps) {}

  private get env(): Record<string, string | undefined> {
    return this.deps.env ?? process.env;
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private get demo(): boolean {
    return this.deps.demo === true;
  }

  // -------------------------------------------------------------------------
  // Configuration state
  // -------------------------------------------------------------------------

  /** Load the settings and the environment into the shared state. */
  async reload(): Promise<UpdateRow | null> {
    const row = await loadUpdateRow(this.deps.db);
    this.deps.state.set(
      snapshotOf({
        row,
        env: this.env,
        demo: this.demo,
        maintenance: this.deps.state.get().maintenance,
      }),
    );
    return row;
  }

  // -------------------------------------------------------------------------
  // The check
  // -------------------------------------------------------------------------

  /** "Check now". */
  async checkNow(actor: Actor): Promise<UpdatesView> {
    const row = await this.reload();
    if (!row) {
      throw setupIncomplete();
    }
    if (!this.deps.state.get().enabled) {
      throw new ProblemError(409, "Update check is off", {
        type: UPDATE_PROBLEMS.checkDisabled,
        detail: "Turn the update check on before checking.",
      });
    }
    await this.performCheck("manual", actor);
    return this.view();
  }

  /** The scheduled check: runs when one is due. Never throws. */
  async runScheduledCheckIfDue(): Promise<void> {
    try {
      const row = await this.reload();
      if (!row) {
        return;
      }
      const snapshot = this.deps.state.get();
      if (!snapshot.enabled) {
        return;
      }
      // A cached result for another source or channel counts as no result.
      const stale =
        !snapshot.check ||
        snapshot.check.source !== snapshot.source.releasesUrl ||
        snapshot.check.channel !== snapshot.channel;
      if (stale || this.now() >= nextCheckAt(snapshot.check, this.now())) {
        await this.performCheck("scheduled", SYSTEM_ACTOR);
      }
    } catch (error) {
      this.deps.log?.("warn", "scheduled update check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private performCheck(trigger: "manual" | "scheduled", actor: Actor): Promise<void> {
    this.checking ??= this.check(trigger, actor).finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async check(trigger: "manual" | "scheduled", actor: Actor): Promise<void> {
    const { db, state } = this.deps;
    const row = await loadUpdateRow(db);
    if (!row) {
      return;
    }
    const snapshot = snapshotOf({
      row,
      env: this.env,
      demo: this.demo,
      maintenance: state.get().maintenance,
    });
    if (!snapshot.enabled) {
      return;
    }
    const { source, channel } = snapshot;
    // A token is sent only to the origin it was issued for, and never to an environment override.
    const token =
      snapshot.origin === "environment" || source.provider === "feed"
        ? null
        : await tokenFor(db, originOf(source.releasesUrl));
    const result = await fetchReleases({
      releasesUrl: source.releasesUrl,
      token,
      allowPrivateNetworks: privateNetworksAllowedFor(
        source.releasesUrl,
        snapshot.origin,
        this.env,
      ),
      // The digests of this installation's own build (full or Community images).
      imageVariant: imageVariantOf(this.env),
      fetch: this.deps.fetch,
      now: () => this.now().getTime(),
    });
    const checkedAt = this.now().toISOString();
    const previous =
      row.updateCheck &&
      row.updateCheck.source === source.releasesUrl &&
      row.updateCheck.channel === channel
        ? row.updateCheck
        : null;
    const check: StoredUpdateCheck = result.ok
      ? {
          source: source.releasesUrl,
          channel,
          state: "ok",
          checkedAt,
          lastOkAt: checkedAt,
          releases: releasesForChannel(result.releases, channel),
          error: null,
        }
      : {
          source: source.releasesUrl,
          channel,
          state: "failed",
          checkedAt,
          lastOkAt: previous?.lastOkAt ?? null,
          releases: previous?.releases ?? [],
          error: result.error,
        };
    await saveCheck(db, row.id, check);
    state.set({ ...snapshot, check });

    const latest = check.releases[0] ?? null;
    await audit(db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.check,
      target: latest?.version ?? null,
      targetType: "update",
      ip: actor.ip,
      details: {
        trigger,
        state: check.state,
        source: source.url,
        channel,
        latest: latest?.version ?? null,
        running: state.runningVersion(),
        errorCode: check.error?.code ?? null,
        errorStatus: check.error?.status ?? null,
      },
    });

    if (check.state === "ok" && latest) {
      try {
        // The bell and the alert rules announce the newest release the licence key covers;
        // one it does not cover stays on the Updates page only.
        const coverage = await loadUpdateCoverage(db);
        const announced = coverage
          ? (check.releases.find((release) => coverage.covers(coveredReleaseOf(release))) ?? null)
          : latest;
        if (announced && isUpdateAvailable(state.runningVersion(), announced.version)) {
          await raiseUpdateAvailable(
            db,
            { release: announced, running: state.runningVersion() },
            this.now(),
          );
        }
      } catch (error) {
        this.deps.log?.("warn", "raising the update alert failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The documents
  // -------------------------------------------------------------------------

  private async updaterState(fresh = false): Promise<StateView | null> {
    if (this.demo) {
      return null;
    }
    try {
      const view = await this.deps.updater.state({ fresh });
      this.incompatible = false;
      return view;
    } catch (error) {
      if (error instanceof UpdaterUnavailableError && error.reason === "incompatible") {
        this.incompatible = true;
        return null;
      }
      return null;
    }
  }

  /** The maintenance state every signed-in user may see. */
  async maintenance(): Promise<MaintenanceView> {
    const state = await this.updaterState();
    this.deps.state.setMaintenance(maintenanceSummaryOf(state));
    const view = maintenanceViewOf(
      state,
      this.deps.state.runningVersion(),
      this.now(),
      await this.jobPause(),
    );
    const plan = await this.plan();
    return { ...view, planned: plan ? { version: plan.version, startsAt: plan.startsAt } : null };
  }

  /** The update planned for a chosen time, or null (also when it cannot be read). */
  private async plan(): Promise<PlannedUpdate | null> {
    if (this.demo) {
      return null;
    }
    try {
      return await loadPlan(this.deps.db);
    } catch (error) {
      this.deps.log?.("warn", "reading the planned update failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The pause of new job starts, or null (also when it cannot be read). */
  private async jobPause(): Promise<JobStartPause | null> {
    if (this.demo) {
      return null;
    }
    try {
      return await loadJobPause(this.deps.db);
    } catch (error) {
      this.deps.log?.("warn", "reading the job pause failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** What runs and waits right now, in every tenant (the install dialog, #46). */
  async activity(): Promise<JobActivityView> {
    const counts = await jobActivity(this.deps.db);
    return { ...counts, checkedAt: this.now().toISOString() };
  }

  /** The Updates tab. */
  async view(): Promise<UpdatesView> {
    const { db, state: cache } = this.deps;
    const row = await this.reload();
    const updaterState = await this.updaterState();
    cache.setMaintenance(maintenanceSummaryOf(updaterState));
    const snapshot = cache.get();
    const running = cache.runningVersion();
    const info = cache.current();
    const pause = activePause(await this.jobPause(), this.now());
    const draining = pause?.phase === "draining";
    const releases = snapshot.enabled
      ? releasesOf(snapshot.check, snapshot.source, snapshot.channel)
      : [];
    const offered = newerThan(releases, running);
    const coverage = await loadUpdateCoverage(db);
    const now = this.now();
    const environment = snapshot.origin === "environment";
    const source: SourceView = {
      origin: snapshot.origin,
      url: snapshot.source.url,
      provider: snapshot.source.provider,
      repository: snapshot.source.repository,
      isDefault: snapshot.source.isDefault,
      isAlpha: snapshot.source.isAlpha,
    };
    return {
      running,
      demo: this.demo,
      settings: {
        enabled: row?.updateCheckEnabled ?? false,
        channel: snapshot.channel,
        sourceUrl: row?.updateSourceUrl ?? null,
        tokenSet: row ? await hasToken(db) : false,
      },
      environmentOverride:
        environment && this.env.RESTOW_UPDATE_CHECK_URL
          ? { url: this.env.RESTOW_UPDATE_CHECK_URL.trim() }
          : null,
      source,
      mode: snapshot.source.isDefault || snapshot.source.isAlpha ? "image" : "source",
      sourceAllowed: this.demo ? null : sourceAllowedBy(updaterState, snapshot.source),
      check: {
        enabled: snapshot.enabled,
        state: info.updateCheck,
        checkedAt: info.checkedAt,
        nextCheckAt:
          snapshot.enabled && snapshot.check && info.updateCheck !== "pending"
            ? nextCheckAt(snapshot.check, now).toISOString()
            : null,
        error:
          snapshot.enabled && info.updateCheck === "failed" && snapshot.check?.error
            ? (snapshot.check.error as CheckError)
            : null,
      },
      latest: releases[0] ? toReleaseView(releases[0], coverage) : null,
      updateAvailable: info.updateAvailable,
      releases: offered.map((release) => toReleaseView(release, coverage)),
      coverage: coverageViewOf(coverage, offered),
      updater: withDrain(
        updaterViewOf({
          state: updaterState,
          demo: this.demo,
          incompatible: this.incompatible,
          applicationImage: running
            ? `${defaultImageRepositories(imageVariantOf(this.env)).app}:${running}`
            : null,
        }),
        draining,
      ),
      leadTimes: LEAD_TIME_PRESETS,
      maintenance: {
        ...maintenanceViewOf(updaterState, running, now, pause),
        planned: plannedSummaryOf(await this.plan()),
      },
      run: runToShow(updaterState),
      edition: await this.editionView(running),
      jobPause: jobPauseViewOf(pause, now, draining ? await this.activity() : null),
      fleet: await this.fleet(),
      planned: plannedViewOf(await this.plan()),
      timeZone: (await loadInstallationTimeZone(this.deps.db, this.env)).timeZone,
    };
  }

  // -------------------------------------------------------------------------
  // The build: Community, and the switch to the full build
  // -------------------------------------------------------------------------

  private get build(): "full" | "community" {
    return imageVariantOf(this.env);
  }

  /**
   * The full build's repositories: the release images, or the full build's names next to a
   * mirror of the Community images (RESTOW_UPDATER_IMAGE_REPOSITORY in .env).
   */
  private fullRepositories(): { app: string; web: string } {
    const app = this.env.RESTOW_UPDATER_IMAGE_REPOSITORY?.trim();
    const web = this.env.RESTOW_UPDATER_WEB_IMAGE_REPOSITORY?.trim();
    const mirrored = app && web ? fullBuildRepositories({ app, web }) : null;
    return mirrored ?? defaultImageRepositories("full");
  }

  private async editionView(running: string | null): Promise<EditionView> {
    const build = this.build;
    const repositories = this.fullRepositories();
    let pending = false;
    if (build === "community" && !this.demo) {
      try {
        pending = await hasPendingLicenseKey(this.deps.db);
      } catch {
        pending = false;
      }
    }
    return {
      build,
      pendingLicenseKey: pending,
      fullImages:
        build === "community" && running
          ? { app: `${repositories.app}:${running}`, web: `${repositories.web}:${running}` }
          : null,
    };
  }

  private refuseOnFullBuild(detail: string): void {
    if (this.demo) {
      throw new ProblemError(403, "Demo installation is read-only", {
        type: "urn:restow:problem:demo-read-only",
        detail: "The demo installation cannot be changed.",
      });
    }
    if (this.build !== "community") {
      throw new ProblemError(409, "This installation runs the full build", {
        type: UPDATE_PROBLEMS.licenseKeyNotPending,
        detail,
      });
    }
  }

  /** Keep a license key for the full build (Community only). It is not verified here. */
  async storeLicenseKey(input: PendingLicenseKeyInput, actor: Actor): Promise<UpdatesView> {
    this.refuseOnFullBuild("Enter the license key on the License page.");
    const replaced = await hasPendingLicenseKey(this.deps.db);
    await storePendingLicenseKey(this.deps.db, input.key);
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.pendingLicenseKeyStored,
      target: null,
      targetType: "installation",
      ip: actor.ip,
      details: { replaced, verified: false },
    });
    return this.view();
  }

  async removeLicenseKey(actor: Actor): Promise<UpdatesView> {
    this.refuseOnFullBuild("Remove the license key on the License page.");
    if (await removePendingLicenseKey(this.deps.db)) {
      await audit(this.deps.db, {
        tenantId: null,
        actor: actor.email,
        actorUserId: actor.id,
        action: UPDATE_AUDIT_ACTIONS.pendingLicenseKeyRemoved,
        target: null,
        targetType: "installation",
        ip: actor.ip,
        details: {},
      });
    }
    return this.view();
  }

  /**
   * Announce the switch of this Community installation to the full build of the running
   * version: the updater verifies the full images against the release workflow's
   * signature of that tag and installs them like an update (backup, rollback). One way only.
   */
  async switchToFullBuild(input: SwitchBuildInput, actor: Actor): Promise<UpdatesView> {
    if (this.demo) {
      throw new ProblemError(403, "Demo installation is read-only", {
        type: "urn:restow:problem:demo-read-only",
        detail: "The demo installation cannot be changed.",
      });
    }
    if (this.build !== "community") {
      throw new ProblemError(409, "Already the full build", {
        type: UPDATE_PROBLEMS.switchRefused,
        detail: "Only a Community installation switches builds, and only to the full build.",
      });
    }
    const { db, state: cache } = this.deps;
    const row = await this.reload();
    if (!row) {
      throw setupIncomplete();
    }
    const snapshot = cache.get();
    const running = cache.runningVersion();
    if (!running || !parseVersion(running)) {
      throw new ProblemError(409, "Running version unknown", {
        type: UPDATE_PROBLEMS.runningUnknown,
        detail: "This build does not report a release version; switch by hand.",
      });
    }
    if (!snapshot.source.isDefault) {
      throw new ProblemError(409, "Only the published images switch builds", {
        type: UPDATE_PROBLEMS.switchRefused,
        detail:
          "This installation is updated from a custom source; switch by hand (change the two image lines in .env).",
      });
    }
    const state = await this.requireUpdater();
    if (state.phase === "scheduled" || state.phase === "running") {
      throw new ProblemError(409, "An update is already announced", {
        type: UPDATE_PROBLEMS.busy,
        detail: "An update is already announced or running.",
      });
    }
    if (!state.capabilities.ready) {
      throw blocked(state.capabilities.blockers);
    }
    // The digests of the full images, read from the notes of the running version's release
    // (this request reads the release list once, also when the daily check is off).
    const result = await fetchReleases({
      releasesUrl: snapshot.source.releasesUrl,
      token: null,
      allowPrivateNetworks: false,
      imageVariant: "full",
      fetch: this.deps.fetch,
      now: () => this.now().getTime(),
    });
    const release = result.ok
      ? result.releases.find((candidate) => candidate.version === running)
      : undefined;
    if (!release) {
      throw new ProblemError(409, "Release not found", {
        type: UPDATE_PROBLEMS.versionUnknown,
        detail: `The release of the running version ${running} could not be read from the update source; switch by hand.`,
      });
    }
    if (!release.digests.app || !release.digests.web) {
      throw new ProblemError(409, "This release cannot be verified", {
        type: UPDATE_PROBLEMS.notVerifiable,
        detail:
          "The release publishes no digests of the full images, so the updater cannot verify them. Switch by hand after checking the images.",
      });
    }
    const request: ScheduleRequest = {
      release: {
        version: release.version,
        tag: release.tag,
        url: release.url,
        prerelease: release.prerelease,
        digests: release.digests,
      },
      mode: "image",
      switchTo: "full",
      source: null,
      leadSeconds: input.leadSeconds,
      requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
    };
    const outcome = await this.handOver(request);
    if (outcome.kind !== "accepted") {
      throw outcome.problem;
    }
    const after = outcome.after;
    cache.setMaintenance(maintenanceSummaryOf(after));
    await audit(db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.switchScheduled,
      target: release.version,
      targetType: "update",
      ip: actor.ip,
      details: {
        version: release.version,
        tag: release.tag,
        from: "community",
        to: "full",
        leadSeconds: input.leadSeconds,
        startsAt: after.run?.startsAt ?? null,
        runId: after.run?.id ?? null,
      },
    });
    return this.view();
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async saveSettings(input: UpdateSettingsInput, actor: Actor): Promise<UpdatesView> {
    const { db } = this.deps;
    const environment =
      snapshotOf({
        row: null,
        env: this.env,
        demo: false,
        maintenance: null,
      }).origin === "environment";
    if (
      environment &&
      (input.enabled !== undefined || input.sourceUrl !== undefined || input.token !== undefined)
    ) {
      throw new ProblemError(409, "Set by the environment", {
        type: UPDATE_PROBLEMS.overridden,
        detail:
          "RESTOW_UPDATE_CHECK_URL is set and wins over these settings. Remove the variable to manage the update check here; the channel can still be changed.",
      });
    }

    const changed = await db.transaction(async (tx) => {
      const row = await loadUpdateRow(tx);
      if (!row) {
        throw setupIncomplete();
      }
      const before = snapshotOf({ row, env: this.env, demo: false, maintenance: null });

      let sourceUrl: string | null = row.updateSourceUrl;
      if (input.sourceUrl !== undefined) {
        const value = input.sourceUrl?.trim() ?? "";
        if (value === "") {
          sourceUrl = null;
        } else {
          const parsed = parseRepositoryUrl(value);
          if (!parsed.ok) {
            throw invalidSource(parsed.problem);
          }
          // An address on this server's own networks only where the operator listed the host
          // (the check would refuse it anyway; feed.ts judges every resolved address too).
          const host = new URL(parsed.source.releasesUrl).hostname;
          const { entries } = parseSourceAllowlist(this.env[SOURCE_ALLOWLIST_VARIABLE]);
          if (!isSourceHostListed(entries, host) && refuseHostBeforeConnect(host, false)) {
            throw invalidSource("private_address");
          }
          sourceUrl = isDefaultSourceUrl(value) ? null : parsed.source.url;
        }
      }
      const enabled = input.enabled ?? row.updateCheckEnabled;
      const channel = input.channel ?? row.updateChannel;
      const after = snapshotOf({
        row: {
          ...row,
          updateSourceUrl: sourceUrl,
          updateCheckEnabled: enabled,
          updateChannel: channel,
        },
        env: this.env,
        demo: false,
        maintenance: null,
      });

      let tokenAction: "set" | "replaced" | "removed" | "removed_source_changed" | null = null;
      const hadToken = await hasToken(tx);
      if (input.token === null) {
        if (hadToken) {
          await removeToken(tx);
          tokenAction = "removed";
        }
      } else if (typeof input.token === "string") {
        if (after.source.provider === "feed") {
          throw invalidSource("not_a_repository");
        }
        await storeToken(tx, originOf(after.source.releasesUrl), input.token);
        tokenAction = hadToken ? "replaced" : "set";
      } else if (
        hadToken &&
        originOf(before.source.releasesUrl) !== originOf(after.source.releasesUrl)
      ) {
        // The token was issued for another origin: it is dropped rather than sent elsewhere.
        await removeToken(tx);
        tokenAction = "removed_source_changed";
      }

      const sourceChanged = before.source.releasesUrl !== after.source.releasesUrl;
      const channelChanged = before.channel !== after.channel;
      const changes: string[] = [];
      if (enabled !== row.updateCheckEnabled) changes.push("enabled");
      if (channelChanged) changes.push("channel");
      if (sourceUrl !== row.updateSourceUrl) changes.push("source");
      if (tokenAction) changes.push("token");
      if (changes.length === 0) {
        return { changes, enabledNow: false };
      }
      await tx
        .update(settings)
        .set({
          updateCheckEnabled: enabled,
          updateSourceUrl: sourceUrl,
          updateChannel: channel,
          // A cache for another source or channel says nothing about this one.
          ...(sourceChanged || channelChanged ? { updateCheck: null } : {}),
        })
        .where(eq(settings.id, row.id));
      await audit(tx, {
        tenantId: null,
        actor: actor.email,
        actorUserId: actor.id,
        action: UPDATE_AUDIT_ACTIONS.settingsUpdated,
        target: "update",
        targetType: "settings",
        ip: actor.ip,
        details: {
          changed: changes,
          enabled,
          channel,
          source: after.source.url,
          tokenAction,
        },
      });
      return {
        changes,
        enabledNow: enabled && (!row.updateCheckEnabled || sourceChanged || channelChanged),
      };
    });

    await this.reload();
    if (changed.enabledNow) {
      // The first look at the new source, so the tab has something to show at once.
      try {
        await this.performCheck("manual", actor);
      } catch (error) {
        this.deps.log?.("warn", "update check after a settings change failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return this.view();
  }

  // -------------------------------------------------------------------------
  // Announcing, cancelling, acknowledging
  // -------------------------------------------------------------------------

  async schedule(input: ScheduleUpdateInput, actor: Actor): Promise<UpdatesView> {
    return this.scheduleAs(input, actor, false);
  }

  /**
   * Announce (or plan) an update. `fromPlan`: the plan's own confirmation at its time, which
   * must not be refused for the plan it carries out.
   */
  private async scheduleAs(
    input: ScheduleUpdateInput,
    actor: Actor,
    fromPlan: boolean,
  ): Promise<UpdatesView> {
    if (this.demo) {
      throw new ProblemError(403, "Demo installation is read-only", {
        type: "urn:restow:problem:demo-read-only",
        detail: "The demo installation cannot be updated.",
      });
    }
    const { db, state: cache } = this.deps;
    const row = await this.reload();
    if (!row) {
      throw setupIncomplete();
    }
    const snapshot = cache.get();
    const running = cache.runningVersion();
    if (!running || !parseVersion(running)) {
      throw new ProblemError(409, "Running version unknown", {
        type: UPDATE_PROBLEMS.runningUnknown,
        detail:
          "This build does not report a release version, so it cannot tell which update is newer. Update manually.",
      });
    }
    const candidates = newerThan(
      snapshot.enabled ? releasesOf(snapshot.check, snapshot.source, snapshot.channel) : [],
      running,
    );
    const release = candidates.find((candidate) => candidate.version === input.version);
    if (!release) {
      throw new ProblemError(422, "Unknown version", {
        type: UPDATE_PROBLEMS.versionUnknown,
        detail: "That version is not among the newer releases of the last check. Check again.",
      });
    }
    const state = await this.requireUpdater();
    if (state.phase === "scheduled" || state.phase === "running") {
      throw new ProblemError(409, "An update is already announced", {
        type: UPDATE_PROBLEMS.busy,
        detail: "An update is already announced or running.",
      });
    }
    if (!state.capabilities.ready) {
      throw blocked(state.capabilities.blockers);
    }
    if (activePause(await loadJobPause(db), this.now())?.phase === "draining") {
      throw new ProblemError(409, "An update is already announced", {
        type: UPDATE_PROBLEMS.busy,
        detail: "An update waits for running jobs. Cancel it or start it now.",
      });
    }
    if (!fromPlan && (await loadPlan(db))) {
      throw new ProblemError(409, "An update is already planned", {
        type: UPDATE_PROBLEMS.busy,
        detail: "An update is planned for a chosen time. Cancel it first.",
      });
    }
    // A release the installed licence key does not cover is not installed (docs/LICENSING.md,
    // "Updates"): its api would not start. Checked for a plan as well, and again when the plan
    // is carried out (the key may have changed in between).
    const coverage = await loadUpdateCoverage(db);
    if (coverage && !coverage.covers(coveredReleaseOf(release))) {
      throw notCovered(release.version, coverage, candidates);
    }
    if (input.at && !fromPlan) {
      return this.storeUpdatePlan(input, input.at, release.version, actor);
    }

    const mode = snapshot.source.isDefault || snapshot.source.isAlpha ? "image" : "source";
    if (mode === "image" && !release.digests.app) {
      // The updater installs a release image only by its published digest and signature.
      throw new ProblemError(409, "This release cannot be verified", {
        type: UPDATE_PROBLEMS.notVerifiable,
        detail:
          "The release publishes no image digest, so the updater cannot verify the image it would install. Update by hand after checking the release.",
      });
    }
    let source: ScheduleRequest["source"] = null;
    if (mode === "source") {
      const archiveUrl = snapshot.source.archiveUrl(release.tag);
      if (!archiveUrl || !snapshot.source.repository) {
        throw new ProblemError(409, "Source cannot be installed from", {
          type: UPDATE_PROBLEMS.sourceUnsupported,
          detail: "This update source is a release feed without a repository; update manually.",
        });
      }
      if (sourceAllowedBy(state, snapshot.source) !== true) {
        throw sourceNotAllowed();
      }
      source = {
        archiveUrl,
        repository: snapshot.source.repository,
        useToken:
          snapshot.origin !== "environment" &&
          (await tokenFor(db, originOf(snapshot.source.releasesUrl))) !== null,
      };
    }

    const request: ScheduleRequest = {
      release: {
        version: release.version,
        tag: release.tag,
        url: release.url,
        prerelease: release.prerelease,
        digests: release.digests,
      },
      mode,
      switchTo: null,
      source,
      leadSeconds: input.leadSeconds,
      requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
    };
    // New starts pause from now until the update is over (#46). With `wait` or `drain` and
    // jobs running, the update is announced only once they finished (advancePause).
    const jobs = input.jobs ?? "interrupt";
    const details = {
      version: release.version,
      tag: release.tag,
      from: running,
      mode,
      leadSeconds: input.leadSeconds,
      jobs,
      repository: snapshot.source.repository,
      digestPublished: Boolean(release.digests.app),
    };
    if (jobs !== "interrupt") {
      const activity = await jobActivity(db);
      if (activity.running > 0) {
        const pause = await insertJobPause(db, {
          mode: jobs,
          phase: "draining",
          request,
          requestedBy: request.requestedBy,
          now: this.now(),
        });
        await audit(db, {
          tenantId: null,
          actor: actor.email,
          actorUserId: actor.id,
          action: UPDATE_AUDIT_ACTIONS.jobsPaused,
          target: release.version,
          targetType: "update",
          ip: actor.ip,
          details: {
            ...details,
            running: {
              mail: activity.mail.running,
              machines: activity.machines.running,
              pve: activity.pve.running,
              fileShares: activity.fileShares.running,
            },
            deadlineAt: pause.deadlineAt.toISOString(),
          },
        });
        return this.view();
      }
    }
    const pause = await insertJobPause(db, {
      mode: jobs,
      phase: "announced",
      request,
      requestedBy: request.requestedBy,
      now: this.now(),
    });
    const outcome = await this.handOver(request);
    if (outcome.kind !== "accepted") {
      // Only a clear "no" lifts the pause. When the outcome is unknown it stays: the update may
      // run, and its nodes and agents follow only while the pause holds (advancePause lifts it
      // once the updater answers idle, and it expires in any case).
      if (outcome.kind === "refused") {
        await removeJobPause(db, pause.id);
      }
      throw outcome.problem;
    }
    const after = outcome.after;
    cache.setMaintenance(maintenanceSummaryOf(after));
    await audit(db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.scheduled,
      target: release.version,
      targetType: "update",
      ip: actor.ip,
      details: {
        ...details,
        startsAt: after.run?.startsAt ?? null,
        runId: after.run?.id ?? null,
      },
    });
    return this.view();
  }

  /**
   * "Start now" while the update waits for running jobs (#46): announce it at once with its
   * lead time; what still runs is stopped by the update (and continues after it).
   */
  async startNow(actor: Actor): Promise<UpdatesView> {
    const pause = activePause(await loadJobPause(this.deps.db), this.now());
    if (pause?.phase !== "draining") {
      throw new ProblemError(409, "No update waits for running jobs", {
        type: UPDATE_PROBLEMS.notWaiting,
        detail: "No update waits for running jobs.",
      });
    }
    const outcome = await this.announceDrained(pause, "admin", actor);
    if (outcome instanceof ProblemError) {
      throw outcome;
    }
    return this.view();
  }

  /**
   * Hand the update that waited for running jobs to the updater, once: `drained` when
   * nothing runs any more, `deadline` at the end of the longest wait, `admin` for "Start
   * now". A refusal lifts the pause, tells the administrators (bell) and returns the
   * problem; whoever called decides whether to throw it.
   */
  private async announceDrained(
    pause: JobStartPause,
    reason: "drained" | "deadline" | "admin",
    actor: Actor | null,
  ): Promise<ProblemError | null> {
    const { db, state: cache } = this.deps;
    const now = this.now();
    const claimed = await claimDrainedUpdate(db, pause, now);
    if (!claimed) {
      return null;
    }
    const requester = claimed.requestedBy;
    const waitedSeconds = Math.max(
      0,
      Math.round((now.getTime() - claimed.createdAt.getTime()) / 1000),
    );
    let after: StateView;
    try {
      const request = storedRequestOf(claimed);
      const state = await this.requireUpdater();
      if (state.phase === "scheduled" || state.phase === "running") {
        throw new ProblemError(409, "An update is already announced", {
          type: UPDATE_PROBLEMS.busy,
          detail: "An update is already announced or running.",
        });
      }
      if (!state.capabilities.ready) {
        throw blocked(state.capabilities.blockers);
      }
      const outcome = await this.handOver(request);
      if (outcome.kind === "unknown") {
        // Not known whether the updater took it: no failure is reported and the pause stays
        // (advancePause lifts it once the updater answers idle; it expires in any case).
        this.deps.log?.("warn", "whether the updater took the update is not known yet", {
          version: claimed.version,
        });
        return outcome.problem;
      }
      if (outcome.kind === "refused") {
        throw outcome.problem;
      }
      after = outcome.after;
    } catch (error) {
      const problem = mapUpdaterError(error);
      await removeJobPause(db, claimed.id);
      await db.insert(notifications).values({
        tenantId: null,
        level: "error",
        event: UPDATE_AUDIT_ACTIONS.failed,
        message: `The update to version ${claimed.version} could not be announced after waiting for running jobs: ${problem.detail ?? problem.message}. New job starts resumed.`,
        details: { version: claimed.version, outcome: "not_announced" },
      });
      await audit(db, {
        tenantId: null,
        actor: actor?.email ?? requester.label,
        actorUserId: actor?.id ?? requester.userId,
        action: UPDATE_AUDIT_ACTIONS.jobsResumed,
        target: claimed.version,
        targetType: "update",
        ip: actor?.ip ?? null,
        details: { reason: "not_announced", problem: problem.type ?? null, waitedSeconds },
      });
      this.deps.log?.("warn", "the update that waited for running jobs was not announced", {
        version: claimed.version,
        problem: problem.type ?? null,
      });
      return problem;
    }
    cache.setMaintenance(maintenanceSummaryOf(after));
    await audit(db, {
      tenantId: null,
      actor: actor?.email ?? requester.label,
      actorUserId: actor?.id ?? requester.userId,
      action: UPDATE_AUDIT_ACTIONS.scheduled,
      target: claimed.version,
      targetType: "update",
      ip: actor?.ip ?? null,
      details: {
        version: claimed.version,
        leadSeconds: claimed.leadSeconds,
        jobs: claimed.mode,
        waitedSeconds,
        after: reason,
        requestedBy: requester.label,
        startsAt: after.run?.startsAt ?? null,
        runId: after.run?.id ?? null,
      },
    });
    return null;
  }

  /**
   * One step of the pause (#46), every few seconds: an update that waits announces itself
   * once nothing runs or its longest wait is over; a pause lifts once the updater has
   * finished (or the update was cancelled there), and in any case when it expires.
   */
  async advancePause(): Promise<void> {
    if (this.demo) {
      return;
    }
    const { db } = this.deps;
    await this.advancePlan();
    const pause = await loadJobPause(db);
    if (!pause) {
      return;
    }
    const now = this.now();
    if (!activePause(pause, now)) {
      await this.liftPause(pause, "expired");
      return;
    }
    if (pause.phase === "draining") {
      const activity = await jobActivity(db);
      if (activity.running === 0) {
        await this.announceDrained(pause, "drained", null);
      } else if (now.getTime() >= pause.deadlineAt.getTime()) {
        await this.announceDrained(pause, "deadline", null);
      }
      return;
    }
    if (pause.phase === "fleet") {
      // Nodes and agents follow the server (fleet.ts): lift once all reachable ones report the
      // release, or at the deadline.
      const fleet = await fleetStatus(db, await this.fleetTarget(), now);
      if (fleet.counts.all.pending === 0) {
        await this.liftPause(pause, "fleet_done", null, fleet.counts.all);
      } else if (now.getTime() >= pause.deadlineAt.getTime()) {
        await this.liftPause(pause, "fleet_deadline", null, fleet.counts.all);
      }
      return;
    }
    // The updater gets the request right after the row says `announced`: give it that moment.
    const announcedAt = (pause.announcedAt ?? pause.createdAt).getTime();
    if (now.getTime() - announcedAt < ANNOUNCE_GRACE_MS) {
      return;
    }
    const state = await this.updaterState(true);
    if (state && state.phase !== "scheduled" && state.phase !== "running") {
      // The server runs the new release: its nodes and agents update next, while new starts
      // stay paused (at most 15 minutes). A failed or cancelled update lifts the pause.
      if (serverRunsPauseVersion(pause, this.deps.state.runningVersion())) {
        const fleet = await fleetStatus(db, await this.fleetTarget(), now);
        if (fleet.counts.all.pending > 0) {
          const moved = await enterFleetPhase(db, pause, now);
          if (moved) {
            await audit(db, {
              tenantId: null,
              actor: "system",
              actorUserId: null,
              action: UPDATE_AUDIT_ACTIONS.fleetStarted,
              target: pause.version,
              targetType: "update",
              ip: null,
              details: {
                agentVersion: fleet.targetVersion,
                deadlineAt: moved.deadlineAt.toISOString(),
                ...fleet.counts.all,
              },
            });
          }
          return;
        }
      }
      await this.liftPause(pause, "update_over");
    }
  }

  /**
   * "Update nodes and agents now" (0.4.3): the server runs a release its Proxmox VE nodes and
   * endpoint agents do not, but no update led into the phase `fleet` (an update by hand, or an
   * announcement whose answer was lost). Starts that phase as after an update: new starts pause
   * (at most 15 minutes) and every reachable node and agent that is behind installs the release
   * once idle; advancePause lifts the pause as usual. Not while an update waits, is announced or
   * runs.
   */
  async updateFleetNow(actor: Actor): Promise<UpdatesView> {
    if (this.demo) {
      throw new ProblemError(403, "Demo installation is read-only", {
        type: "urn:restow:problem:demo-read-only",
        detail: "The demo installation cannot be changed.",
      });
    }
    const { db } = this.deps;
    const now = this.now();
    const busy = () =>
      new ProblemError(409, "An update is already announced", {
        type: UPDATE_PROBLEMS.busy,
        detail: "An update is announced or running, or nodes and agents are updating already.",
      });
    if (activePause(await loadJobPause(db), now)) {
      throw busy();
    }
    const state = await this.updaterState(true);
    if (state && (state.phase === "scheduled" || state.phase === "running")) {
      throw busy();
    }
    const fleet = await fleetStatus(db, await this.fleetTarget(), now);
    if (fleet.counts.all.pending === 0) {
      throw new ProblemError(409, "No node or agent to update", {
        type: UPDATE_PROBLEMS.fleetCurrent,
        detail:
          "No reachable node or agent runs an older release than the server offers. Unreachable ones are updated by hand.",
      });
    }
    const row = await startFleetPhase(db, {
      version: this.deps.state.runningVersion() ?? fleet.targetVersion,
      requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
      now,
    });
    if (!row) {
      throw busy();
    }
    await audit(db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.fleetStarted,
      target: row.version,
      targetType: "update",
      ip: actor.ip,
      details: {
        agentVersion: fleet.targetVersion,
        deadlineAt: row.deadlineAt.toISOString(),
        manual: true,
        ...fleet.counts.all,
      },
    });
    return this.view();
  }

  /** The release nodes and agents update to: the agent release this server announces. */
  private async fleetTarget(): Promise<string> {
    return announcedAgentVersion();
  }

  /** Nodes and agents against the release they update to (the Updates tab, 0.4.2). */
  async fleet(): Promise<FleetStatus | null> {
    if (this.demo) {
      return null;
    }
    try {
      return await fleetStatus(this.deps.db, await this.fleetTarget(), this.now());
    } catch (error) {
      this.deps.log?.("warn", "reading the nodes and agents failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Keep an update for its chosen time (0.4.2): checked now, confirmed at its time. */
  private async storeUpdatePlan(
    input: ScheduleUpdateInput,
    at: { date: string; time: string },
    version: string,
    actor: Actor,
  ): Promise<UpdatesView> {
    const { timeZone } = await loadInstallationTimeZone(this.deps.db, this.env);
    const now = this.now();
    const when = plannedStartsAt(at, timeZone, input.leadSeconds, now);
    if (!when.ok) {
      throw new ProblemError(422, "Choose another time", {
        type: UPDATE_PROBLEMS.invalidTime,
        detail:
          when.reason === "past"
            ? "That time is already past (or too close to count down to it)."
            : when.reason === "too_far"
              ? "An update can be planned up to 30 days ahead."
              : when.reason === "nonexistent"
                ? "That time does not exist in the installation's time zone (the clock skips it)."
                : "Not a valid date and time.",
        extensions: { reason: when.reason, timeZone },
      });
    }
    const plan: PlannedUpdate = {
      version,
      startsAt: when.startsAt.toISOString(),
      leadSeconds: input.leadSeconds,
      jobs: input.jobs ?? "interrupt",
      at,
      timeZone,
      requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
      plannedAt: now.toISOString(),
    };
    await storePlan(this.deps.db, plan);
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.planned,
      target: version,
      targetType: "update",
      ip: actor.ip,
      details: {
        version,
        startsAt: plan.startsAt,
        at,
        timeZone,
        leadSeconds: plan.leadSeconds,
        jobs: plan.jobs,
      },
    });
    return this.view();
  }

  /**
   * A planned update whose time has come is confirmed as its administrator chose it, with the
   * same checks as from the dialog. One api process wins; a plan far past its time (the api
   * was down) is dropped. Either failure is audited.
   */
  private async advancePlan(): Promise<void> {
    const { db } = this.deps;
    const plan = await loadPlan(db);
    if (!plan) {
      return;
    }
    const now = this.now().getTime();
    const due = handoverAt(plan);
    if (now < due) {
      return;
    }
    if (!(await takePlan(db, plan.plannedAt))) {
      return;
    }
    const requester: Actor = {
      id: plan.requestedBy.userId,
      email: plan.requestedBy.label,
      ip: plan.requestedBy.ip,
    };
    const failed = async (reason: string) =>
      audit(db, {
        tenantId: null,
        actor: "system",
        actorUserId: null,
        action: UPDATE_AUDIT_ACTIONS.planFailed,
        target: plan.version,
        targetType: "update",
        ip: null,
        details: { version: plan.version, startsAt: plan.startsAt, reason },
      });
    if (now - due > PLAN_LATE_LIMIT_MS) {
      await failed("too_late");
      return;
    }
    // What is left of the lead time, rounded down to an offered one (0 at the latest).
    const left = Math.max(0, Math.floor((Date.parse(plan.startsAt) - now) / 1000));
    // The loop runs every few seconds: on time, the chosen lead time applies as it is.
    const lead =
      left >= plan.leadSeconds - 30
        ? plan.leadSeconds
        : ([...LEAD_TIME_PRESETS].reverse().find((preset) => preset <= left) ?? 0);
    try {
      await this.scheduleAs(
        { version: plan.version, leadSeconds: lead, jobs: plan.jobs },
        requester,
        true,
      );
    } catch (error) {
      await failed(error instanceof Error ? error.message : String(error));
      this.deps.log?.("warn", "the planned update could not be confirmed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async liftPause(
    pause: JobStartPause,
    reason: "expired" | "update_over" | "cancelled" | "fleet_done" | "fleet_deadline",
    actor: Actor | null = null,
    fleet: FleetCounts | null = null,
  ): Promise<void> {
    if (!(await removeJobPause(this.deps.db, pause.id))) {
      return;
    }
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor?.email ?? "system",
      actorUserId: actor?.id ?? null,
      action: UPDATE_AUDIT_ACTIONS.jobsResumed,
      target: pause.version,
      targetType: "update",
      ip: actor?.ip ?? null,
      details: { reason, phase: pause.phase, mode: pause.mode, ...(fleet ? { fleet } : {}) },
    });
  }

  async cancel(actor: Actor): Promise<UpdatesView> {
    const plan = await this.plan();
    if (plan) {
      // Planned only: nothing was handed over or paused yet.
      if (await takePlan(this.deps.db, plan.plannedAt)) {
        await audit(this.deps.db, {
          tenantId: null,
          actor: actor.email,
          actorUserId: actor.id,
          action: UPDATE_AUDIT_ACTIONS.cancelled,
          target: plan.version,
          targetType: "update",
          ip: actor.ip,
          details: { runId: null, version: plan.version, planned: true, startsAt: plan.startsAt },
        });
      }
      return this.view();
    }
    const pause = activePause(await this.jobPause(), this.now());
    if (pause?.phase === "draining") {
      // Not handed to the updater yet: cancelling lifts the pause, nothing else.
      if (await removeJobPause(this.deps.db, pause.id)) {
        await audit(this.deps.db, {
          tenantId: null,
          actor: actor.email,
          actorUserId: actor.id,
          action: UPDATE_AUDIT_ACTIONS.cancelled,
          target: pause.version,
          targetType: "update",
          ip: actor.ip,
          details: { runId: null, version: pause.version, whileWaitingForJobs: true },
        });
      }
      return this.view();
    }
    await this.requireUpdater();
    const before = await this.updaterState(true);
    let after: StateView;
    try {
      after = await this.deps.updater.cancel();
    } catch (error) {
      throw mapUpdaterError(error);
    }
    this.deps.state.setMaintenance(maintenanceSummaryOf(after));
    if (pause) {
      await this.liftPause(pause, "cancelled", actor);
    }
    const cancelled = before?.run ?? null;
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.cancelled,
      target: cancelled?.targetVersion ?? null,
      targetType: "update",
      ip: actor.ip,
      details: { runId: cancelled?.id ?? null, version: cancelled?.targetVersion ?? null },
    });
    return this.view();
  }

  /** Clear a finished run from the tab (it stays in the updater's history). */
  async dismiss(actor: Actor): Promise<UpdatesView> {
    await this.requireUpdater();
    const before = await this.updaterState(true);
    try {
      await this.deps.updater.acknowledge();
    } catch (error) {
      throw mapUpdaterError(error);
    }
    const run = before?.run ?? null;
    await audit(this.deps.db, {
      tenantId: null,
      actor: actor.email,
      actorUserId: actor.id,
      action: UPDATE_AUDIT_ACTIONS.acknowledged,
      target: run?.targetVersion ?? null,
      targetType: "update",
      ip: actor.ip,
      details: { runId: run?.id ?? null, outcome: run?.outcome ?? null },
    });
    return this.view();
  }

  private async requireUpdater(): Promise<StateView> {
    if (this.demo || !this.deps.updater.enabled) {
      throw unavailable("disabled");
    }
    let state: StateView | null;
    try {
      // Patient: an updater that checks before it answers is slow, not missing.
      state = await this.deps.updater.state({ fresh: true, patient: true });
    } catch (error) {
      throw mapUpdaterError(error);
    }
    if (!state) {
      throw unavailable("unreachable");
    }
    return state;
  }

  /**
   * Hand an update to the updater. `accepted`: the updater has it (also when its answer was lost
   * and its state, read again, shows the run for this request); `refused`: it certainly does not
   * (a refusal, no updater configured, its state shows no such run, or the connection broke and
   * it does not answer any more); `unknown`: the request timed out, so it may have been taken,
   * and the updater does not answer now either.
   */
  private async handOver(request: ScheduleRequest): Promise<ScheduleOutcome> {
    try {
      return { kind: "accepted", after: await this.deps.updater.schedule(request), late: false };
    } catch (error) {
      const problem = mapUpdaterError(error);
      if (
        !(error instanceof UpdaterUnavailableError) ||
        (error.reason !== "timeout" && error.reason !== "unreachable")
      ) {
        return { kind: "refused", problem };
      }
      let state: StateView | null;
      try {
        state = await this.deps.updater.state({ fresh: true, patient: true });
      } catch {
        state = null;
      }
      if (!state) {
        this.deps.log?.("warn", "the updater did not answer the update request", {
          version: request.release.version,
          reason: error.reason,
        });
        // A request that timed out reached the updater and may have been taken. A broken
        // connection almost always means it did not arrive: the updater went away (keeping the
        // pause would hold every new run until it expires).
        return error.reason === "timeout"
          ? { kind: "unknown", problem }
          : { kind: "refused", problem };
      }
      if (isRunFor(state, request)) {
        this.deps.log?.("info", "the updater took the update although its answer was lost", {
          version: request.release.version,
          reason: error.reason,
        });
        return { kind: "accepted", after: state, late: true };
      }
      if (state.phase === "scheduled" || state.phase === "running") {
        return {
          kind: "refused",
          problem: new ProblemError(409, "An update is already announced", {
            type: UPDATE_PROBLEMS.busy,
            detail: "An update is already announced or running.",
          }),
        };
      }
      return { kind: "refused", problem };
    }
  }

  // -------------------------------------------------------------------------
  // The updater's journal
  // -------------------------------------------------------------------------

  /**
   * Read the updater and write what it recorded while nobody could audit it
   * (the start and the result of a run, possibly while this api was being
   * replaced) into the audit log, in order, once. Returns the state it read.
   */
  async syncUpdater(): Promise<StateView | null> {
    if (this.demo) {
      return null;
    }
    const state = await this.updaterState(true);
    this.deps.state.setMaintenance(maintenanceSummaryOf(state));
    if (!state || state.events.length === 0) {
      return state;
    }
    const { db } = this.deps;
    const row = await loadUpdateRow(db);
    if (!row) {
      return state;
    }
    const cursor = row.updateAuditCursor;
    const pending = [...state.events]
      .filter((event) => cursor === null || event.id > cursor)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const event of pending) {
      await this.ingest(row.id, event);
    }
    return state;
  }

  private async ingest(settingsId: string, event: JournalEvent): Promise<void> {
    const databaseEvent = event.action.startsWith("database.");
    await this.deps.db.transaction(async (tx) => {
      await audit(tx, {
        tenantId: null,
        actor: event.actor.label,
        actorUserId: event.actor.userId,
        action: event.action,
        target: event.target,
        targetType: databaseEvent ? "database" : "update",
        ip: event.actor.ip,
        details: { ...event.details, runId: event.runId, occurredAt: event.at, via: "updater" },
      });
      if (databaseEvent) {
        // The outcome of a move of the database (Installation > Database) reaches the bell too.
        const status = typeof event.details.status === "string" ? event.details.status : null;
        if (event.action === "database.move.succeeded" || event.action === "database.move.failed") {
          const succeeded = event.action === "database.move.succeeded";
          await tx.insert(notifications).values({
            tenantId: null,
            level: succeeded ? "info" : status === "rolled_back" ? "warning" : "error",
            event: event.action,
            message: succeeded
              ? `The database was moved to ${event.target}.`
              : `The database was not moved to ${event.target}${status ? ` (${status})` : ""}.`,
            details: { moveId: event.runId, status, objectName: event.target },
          });
        }
      } else if (event.action !== UPDATE_AUDIT_ACTIONS.started) {
        const succeeded = event.action === UPDATE_AUDIT_ACTIONS.succeeded;
        const outcome = typeof event.details.outcome === "string" ? event.details.outcome : null;
        await tx.insert(notifications).values({
          tenantId: null,
          level: succeeded ? "info" : "error",
          event: event.action,
          message: succeeded
            ? `The installation was updated to version ${event.target}.`
            : `The update to version ${event.target} did not complete${outcome ? ` (${outcome})` : ""}.`,
          details: { version: event.target, runId: event.runId, outcome },
        });
      }
      await tx
        .update(settings)
        .set({ updateAuditCursor: event.id, updatedAt: sql`${settings.updatedAt}` })
        .where(eq(settings.id, settingsId));
    });
  }

  // -------------------------------------------------------------------------
  // Background work
  // -------------------------------------------------------------------------

  /** Start the daily check and the updater sync; `close` stops both. */
  start(): { close(): void } {
    if (this.demo) {
      return { close: () => undefined };
    }
    let closed = false;
    const timers = new Set<NodeJS.Timeout>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed) {
          fn();
        }
      }, ms);
      timer.unref();
      timers.add(timer);
    };

    void this.reload().catch((error) =>
      this.deps.log?.("warn", "loading the update settings failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    const checkLoop = () => {
      void this.runScheduledCheckIfDue().finally(() => later(checkLoop, 10 * 60 * 1000));
    };
    later(checkLoop, 20_000);

    const syncLoop = () => {
      this.syncUpdater()
        .then((state) => (state ? (state.phase === "idle" ? 30_000 : 3_000) : 60_000))
        .catch((error) => {
          this.deps.log?.("warn", "updater sync failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return 60_000;
        })
        .then((wait) => later(syncLoop, wait));
    };
    later(syncLoop, 5_000);

    // The pause of new job starts (#46): announce a waiting update, lift a finished pause.
    const pauseLoop = () => {
      void this.advancePause()
        .catch((error) => {
          this.deps.log?.("warn", "advancing the job pause failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => later(pauseLoop, PAUSE_STEP_MS));
    };
    later(pauseLoop, 3_000);

    return {
      close() {
        closed = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
        timers.clear();
      },
    };
  }
}

/** While an update waits for running jobs the updater counts as busy: nothing else is announced. */
function withDrain(view: UpdaterView, draining: boolean): UpdaterView {
  return draining && (view.state === "ready" || view.state === "blocked")
    ? { ...view, state: "busy" }
    : view;
}

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

/** 409: the release lies outside the update period of the installed licence key. */
function notCovered(
  version: string,
  coverage: UpdateCoverage,
  candidates: readonly StoredUpdateRelease[],
): ProblemError {
  const latestCovered = coverageViewOf(coverage, candidates)?.latestCovered ?? null;
  return new ProblemError(409, "Outside the update period", {
    type: UPDATE_PROBLEMS.notCovered,
    detail:
      coverage.coveredUntil !== null
        ? `Version ${version} was released after the update period of the installed licence key ended (${coverage.coveredUntil}). The installed version keeps working; renew the update period to install it.`
        : `Version ${version} is not part of the ${coverage.series}.x versions the installed licence key covers. The installed version keeps working.`,
    extensions: {
      version,
      coveredUntil: coverage.coveredUntil,
      series: coverage.series,
      latestCovered,
    },
  });
}

function setupIncomplete(): ProblemError {
  return new ProblemError(409, "Setup not completed", {
    type: UPDATE_PROBLEMS.setupIncomplete,
    detail: "Finish the setup wizard before changing installation settings.",
  });
}

function invalidSource(problem: string): ProblemError {
  return new ProblemError(422, "Invalid update source", {
    type: UPDATE_PROBLEMS.invalidSource,
    detail: `sourceUrl: ${problem}`,
    extensions: { field: "sourceUrl", code: problem },
  });
}

function unavailable(reason: string): ProblemError {
  if (reason === "timeout") {
    // The updater runs but did not answer in time: whether it took the request is read again.
    return new ProblemError(409, "The updater did not answer in time", {
      type: UPDATE_PROBLEMS.updaterUnavailable,
      detail:
        "The updater did not answer in time. It may still be checking; reload the Updates page to see whether it took the request.",
      extensions: { reason },
    });
  }
  return new ProblemError(409, "The updater is not available", {
    type: UPDATE_PROBLEMS.updaterUnavailable,
    detail:
      "No updater answers. Start it with `docker compose --profile updater up -d`, or update manually.",
    extensions: { reason },
  });
}

function sourceNotAllowed(): ProblemError {
  return new ProblemError(409, "Installing from this source is not allowed", {
    type: UPDATE_PROBLEMS.sourceNotAllowed,
    detail: `Building an update from a source repository is turned off unless the operator names the repository in ${SOURCE_ALLOWLIST_VARIABLE} on the server and recreates the updater. Update manually, or ask the operator.`,
  });
}

function blocked(blockers: Blocker[]): ProblemError {
  return new ProblemError(409, "The updater cannot update right now", {
    type: UPDATE_PROBLEMS.updaterBlocked,
    detail: "The updater reports problems that block an update.",
    extensions: { blockers },
  });
}

type ScheduleOutcome =
  | { kind: "accepted"; after: StateView; late: boolean }
  | { kind: "refused"; problem: ProblemError }
  | { kind: "unknown"; problem: ProblemError };

/** Whether the updater's state shows a scheduled or running run for this request. */
export function isRunFor(state: StateView, request: ScheduleRequest): boolean {
  const run = state.run;
  if (!run || (state.phase !== "scheduled" && state.phase !== "running")) {
    return false;
  }
  const norm = (value: string) => value.trim().replace(/^v/, "");
  return (
    norm(run.targetVersion) === norm(request.release.version) &&
    (run.switchTo ?? null) === (request.switchTo ?? null) &&
    run.requestedBy.userId === request.requestedBy.userId &&
    run.requestedBy.label === request.requestedBy.label
  );
}

/** Translate what the updater or the client raised into a problem response. */
export function mapUpdaterError(error: unknown): ProblemError {
  if (error instanceof ProblemError) {
    return error;
  }
  if (error instanceof UpdaterUnavailableError) {
    return unavailable(error.reason);
  }
  if (error instanceof UpdaterRejectedError) {
    const code = error.code;
    if (code === "busy") {
      return new ProblemError(409, "An update is already announced", {
        type: UPDATE_PROBLEMS.busy,
        detail: "An update is already announced or running.",
      });
    }
    if (code === "blocked") {
      const blockers = (error.body as { blockers?: Blocker[] } | null)?.blockers ?? [];
      return blocked(blockers);
    }
    if (code === "running") {
      return new ProblemError(409, "The update has already started", {
        type: UPDATE_PROBLEMS.running,
        detail: "An update that has started cannot be cancelled.",
      });
    }
    if (code === "not_finished") {
      return new ProblemError(409, "The update has not finished", {
        type: UPDATE_PROBLEMS.running,
        detail: "Only a finished update can be dismissed.",
      });
    }
    if (code === "source_not_allowed") {
      return sourceNotAllowed();
    }
    if (code === "not_newer") {
      return new ProblemError(422, "Unknown version", {
        type: UPDATE_PROBLEMS.versionUnknown,
        detail: "The updater found that version is not newer than the running one.",
      });
    }
    if (code === "not_scheduled") {
      return new ProblemError(409, "No update is announced", {
        type: UPDATE_PROBLEMS.notScheduled,
        detail: "There is no announced update to cancel.",
      });
    }
  }
  return new ProblemError(502, "The updater refused the request", {
    type: UPDATE_PROBLEMS.updaterError,
    detail: "The updater answered with an unexpected error.",
  });
}

function plannedViewOf(plan: PlannedUpdate | null): PlannedUpdateView | null {
  return plan
    ? {
        version: plan.version,
        startsAt: plan.startsAt,
        leadSeconds: plan.leadSeconds,
        jobs: plan.jobs,
        at: plan.at,
        timeZone: plan.timeZone,
        requestedBy: plan.requestedBy.label,
        plannedAt: plan.plannedAt,
      }
    : null;
}

function plannedSummaryOf(
  plan: PlannedUpdate | null,
): { version: string; startsAt: string } | null {
  return plan ? { version: plan.version, startsAt: plan.startsAt } : null;
}
