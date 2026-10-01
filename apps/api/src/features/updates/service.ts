import { refuseHostBeforeConnect } from "@restow/core";
import type { Database, StoredUpdateCheck } from "@restow/db";
import { notifications, settings } from "@restow/db";
import { eq, sql } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { ProblemError } from "../../problem.js";
import { isUpdateAvailable, parseVersion } from "../../routes/v1/version.js";
import { imageVariantOf } from "../../updater/image-variant.js";
import {
  type Blocker,
  type JournalEvent,
  LEAD_TIME_PRESETS,
  type ScheduleRequest,
  type StateView,
} from "../../updater/protocol.js";
import {
  SOURCE_ALLOWLIST_VARIABLE,
  isSourceAllowed,
  isSourceHostListed,
  parseSourceAllowlist,
  sourceTargetOf,
} from "../../updater/source-policy.js";
import { type FetchLike, fetchReleases, releasesForChannel } from "./feed.js";
import { raiseUpdateAvailable } from "./notify.js";
import type {
  CheckError,
  MaintenanceView,
  ScheduleUpdateInput,
  SourceView,
  UpdateSettingsInput,
  UpdatesView,
} from "./schemas.js";
import { type UpdateRow, loadUpdateRow, saveCheck, snapshotOf } from "./settings-store.js";
import { isDefaultSourceUrl, parseRepositoryUrl } from "./source.js";
import { type UpdateStateCache, newerThan, releasesOf } from "./state.js";
import { hasToken, removeToken, storeToken, tokenFor } from "./token.js";
import {
  type UpdaterClient,
  UpdaterRejectedError,
  UpdaterUnavailableError,
} from "./updater-client.js";
import {
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
  setupIncomplete: "urn:restow:problem:setup-incomplete",
} as const;

/** The check runs once a day; after a failure it tries again after an hour at the earliest. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_RETRY_MS = 60 * 60 * 1000;

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
  source: { isDefault: boolean; archiveUrl: (tag: string) => string | null },
): boolean | null {
  if (source.isDefault) {
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

    if (
      check.state === "ok" &&
      latest &&
      isUpdateAvailable(state.runningVersion(), latest.version)
    ) {
      try {
        await raiseUpdateAvailable(
          db,
          { release: latest, running: state.runningVersion() },
          this.now(),
        );
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
    return maintenanceViewOf(state, this.deps.state.runningVersion(), this.now());
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
    const releases = snapshot.enabled
      ? releasesOf(snapshot.check, snapshot.source, snapshot.channel)
      : [];
    const now = this.now();
    const environment = snapshot.origin === "environment";
    const source: SourceView = {
      origin: snapshot.origin,
      url: snapshot.source.url,
      provider: snapshot.source.provider,
      repository: snapshot.source.repository,
      isDefault: snapshot.source.isDefault,
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
      mode: snapshot.source.isDefault ? "image" : "source",
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
      latest: releases[0] ? toReleaseView(releases[0]) : null,
      updateAvailable: info.updateAvailable,
      releases: newerThan(releases, running).map(toReleaseView),
      updater: updaterViewOf({
        state: updaterState,
        demo: this.demo,
        incompatible: this.incompatible,
      }),
      leadTimes: LEAD_TIME_PRESETS,
      maintenance: maintenanceViewOf(updaterState, running, now),
      run: runToShow(updaterState),
    };
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

    const mode = snapshot.source.isDefault ? "image" : "source";
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
      source,
      leadSeconds: input.leadSeconds,
      requestedBy: { userId: actor.id, label: actor.email, ip: actor.ip },
    };
    let after: StateView;
    try {
      after = await this.deps.updater.schedule(request);
    } catch (error) {
      throw mapUpdaterError(error);
    }
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
        version: release.version,
        tag: release.tag,
        from: running,
        mode,
        leadSeconds: input.leadSeconds,
        startsAt: after.run?.startsAt ?? null,
        runId: after.run?.id ?? null,
        repository: snapshot.source.repository,
        digestPublished: Boolean(release.digests.app),
      },
    });
    return this.view();
  }

  async cancel(actor: Actor): Promise<UpdatesView> {
    await this.requireUpdater();
    const before = await this.updaterState(true);
    let after: StateView;
    try {
      after = await this.deps.updater.cancel();
    } catch (error) {
      throw mapUpdaterError(error);
    }
    this.deps.state.setMaintenance(maintenanceSummaryOf(after));
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
      state = await this.deps.updater.state({ fresh: true });
    } catch (error) {
      throw mapUpdaterError(error);
    }
    if (!state) {
      throw unavailable("unreachable");
    }
    return state;
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
    await this.deps.db.transaction(async (tx) => {
      await audit(tx, {
        tenantId: null,
        actor: event.actor.label,
        actorUserId: event.actor.userId,
        action: event.action,
        target: event.target,
        targetType: "update",
        ip: event.actor.ip,
        details: { ...event.details, runId: event.runId, occurredAt: event.at, via: "updater" },
      });
      if (event.action !== UPDATE_AUDIT_ACTIONS.started) {
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

// ---------------------------------------------------------------------------
// Problems
// ---------------------------------------------------------------------------

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
