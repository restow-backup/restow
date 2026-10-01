import type { StoredUpdateCheck, StoredUpdateRelease } from "@restow/db";
import {
  type VersionInfo,
  type VersionSource,
  compareVersions,
  isUpdateAvailable,
  parseVersion,
  runningCommitFrom,
  runningVersionFrom,
} from "../../routes/v1/version.js";
import type { UpdateChannel } from "./schemas.js";
import { type ParsedSource, defaultSource, parseEnvironmentSource } from "./source.js";

/**
 * The update state the rest of the api reads without waiting for anything
 * (the status documents of the web UI and the integration API): the settings,
 * the cached check and a summary of an announced maintenance. The update
 * service (service.ts) fills it from the database when the process starts and
 * after every change; this class only holds and presents it.
 */

export interface MaintenanceSummary {
  phase: "scheduled" | "running";
  targetVersion: string;
  startsAt: string;
}

export interface UpdateSnapshot {
  /** The check runs: the stored switch is on, or the environment override is set. */
  enabled: boolean;
  channel: UpdateChannel;
  source: ParsedSource;
  origin: "default" | "settings" | "environment";
  check: StoredUpdateCheck | null;
  maintenance: MaintenanceSummary | null;
}

/** The releases of a check that belong to the current source and channel, newest first. */
export function releasesOf(
  check: StoredUpdateCheck | null,
  source: ParsedSource,
  channel: UpdateChannel,
): StoredUpdateRelease[] {
  if (!check || check.source !== source.releasesUrl || check.channel !== channel) {
    return [];
  }
  return check.releases;
}

/** Releases newer than `running`, newest first. All of them when the running version is not known. */
export function newerThan(
  releases: readonly StoredUpdateRelease[],
  running: string | null,
): StoredUpdateRelease[] {
  const current = running ? parseVersion(running) : null;
  if (!current) {
    return [];
  }
  return releases.filter((release) => {
    const version = parseVersion(release.version);
    return version !== null && compareVersions(current, version) < 0;
  });
}

export class UpdateStateCache implements VersionSource {
  private snapshot: UpdateSnapshot;

  constructor(
    private readonly running: string | null,
    environmentUrl: string | undefined,
    private readonly commit: string | null = null,
  ) {
    const fromEnvironment = parseEnvironmentSource(environmentUrl);
    this.snapshot = {
      enabled: fromEnvironment !== null,
      channel: "stable",
      source: fromEnvironment ?? defaultSource(),
      origin: fromEnvironment ? "environment" : "default",
      check: null,
      maintenance: null,
    };
  }

  /** Replace the snapshot (the update service does this after loading or changing anything). */
  set(snapshot: UpdateSnapshot): void {
    this.snapshot = snapshot;
  }

  get(): UpdateSnapshot {
    return this.snapshot;
  }

  /** Update the maintenance summary alone (from the updater's state). */
  setMaintenance(maintenance: MaintenanceSummary | null): void {
    this.snapshot = { ...this.snapshot, maintenance };
  }

  runningVersion(): string | null {
    return this.running;
  }

  current(): VersionInfo {
    const { enabled, channel, source, check, maintenance } = this.snapshot;
    const releases = enabled ? releasesOf(check, source, channel) : [];
    const latest = releases[0] ?? null;
    const state: VersionInfo["updateCheck"] = !enabled
      ? "disabled"
      : check === null || check.source !== source.releasesUrl || check.channel !== channel
        ? "pending"
        : check.state;
    return {
      running: this.running,
      commit: this.commit,
      latest: latest?.version ?? null,
      updateAvailable: enabled ? isUpdateAvailable(this.running, latest?.version ?? null) : null,
      releaseUrl: latest?.url ?? null,
      updateCheck: state,
      checkedAt: enabled && state !== "pending" ? (check?.checkedAt ?? null) : null,
      channel,
      latestTag: latest?.tag ?? null,
      publishedAt: latest?.publishedAt ?? null,
      checkError: enabled && state === "failed" ? (check?.error?.code ?? null) : null,
      maintenance,
    };
  }
}

/** The state the process starts with (from the environment); the service loads the rest. */
export function createUpdateState(
  env: Record<string, string | undefined> = process.env,
): UpdateStateCache {
  return new UpdateStateCache(
    runningVersionFrom(env),
    env.RESTOW_UPDATE_CHECK_URL,
    runningCommitFrom(env),
  );
}
