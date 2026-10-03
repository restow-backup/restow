/**
 * The agent's configuration and its defaults per operating system and profile
 * (the `GET /agent/v1/config` contract, docs/AGENT.md).
 *
 * Defaults:
 *   - a machine that is in no backup job has the schedule `none`: it waits for a
 *     job and never backs up on its own ({@link enrolledEndpointConfig}, the
 *     configuration enrollment writes);
 *   - the schedule a job editor starts from: server profile daily at 22:00,
 *     client profile `on_connect`, at most one backup every 4 hours;
 *   - paths per OS (Linux `/etc /home /root /srv /var/www`, plus `/opt
 *     /usr/local /var/lib /var/backups` for servers, where applications keep
 *     their data; macOS `/Users`, Windows `C:\Users`, plus `C:\ProgramData`
 *     for servers);
 *   - excludes per OS: caches, temporary files, the trash, `node_modules`,
 *     `*.tmp` and the restic cache.
 *
 * Windows stays in the model for a later release; the server does not enroll
 * Windows endpoints in 0.1.0 ({@link SUPPORTED_ENDPOINT_OS}).
 */

import type { BandwidthWindow } from "../backup-jobs/bandwidth.js";

export const ENDPOINT_PROFILES = ["server", "client"] as const;
export type EndpointProfileName = (typeof ENDPOINT_PROFILES)[number];

export const ENDPOINT_OS = ["linux", "windows", "darwin"] as const;
export type EndpointOsName = (typeof ENDPOINT_OS)[number];

export const ENDPOINT_ARCH = ["amd64", "arm64"] as const;
export type EndpointArchName = (typeof ENDPOINT_ARCH)[number];

/** The systems a 0.1.0 installation enrolls; Windows is on the roadmap. */
export const SUPPORTED_ENDPOINT_OS: readonly EndpointOsName[] = ["linux", "darwin"];

export function isSupportedEndpointOs(os: string): os is EndpointOsName {
  return (SUPPORTED_ENDPOINT_OS as readonly string[]).includes(os);
}

/**
 * When the agent backs up. `none` (release 0.2.1): the machine is in no backup job and waits for
 * one; the agent never starts a scheduled backup. An agent of an earlier release does not know
 * the kind, so the server never hands it the folders of such a machine (`agentFacingConfig`).
 */
export const AGENT_SCHEDULE_KINDS = ["interval", "daily", "on_connect", "none"] as const;
export type AgentScheduleKind = (typeof AGENT_SCHEDULE_KINDS)[number];

/** The kind of schedule of a machine in no backup job. */
export const NO_SCHEDULE_KIND = "none" satisfies AgentScheduleKind;

export interface AgentSchedule {
  kind: AgentScheduleKind;
  intervalMinutes?: number;
  timeOfDay?: string;
  timeZone: string;
}

/** A schedule that runs backups (every kind but `none`). */
export type ActiveAgentSchedule = AgentSchedule & {
  kind: Exclude<AgentScheduleKind, typeof NO_SCHEDULE_KIND>;
};

export interface AgentConfig {
  profile: EndpointProfileName;
  schedule: AgentSchedule;
  paths: string[];
  excludes: string[];
  hooks: { pre?: string; post?: string };
  /** The default upload limit in kbit/s (outside every window); null = unlimited. */
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  useVss: boolean;
  /** Skip files larger than this many bytes; present only when a backup job sets a limit. */
  excludeLargerThanBytes?: number;
  /**
   * Time windows with their own upload limit; present only when the machine's job (or the machine)
   * sets some. Read in the zone of `schedule`. The server works out the active one when the agent
   * asks for its configuration and sends the result as `bandwidthKbps`; the windows themselves
   * never reach the agent.
   */
  bandwidthWindows?: BandwidthWindow[];
}

/** `GET /agent/v1/config` answers this: the configuration plus its version. */
export interface AgentConfigResponse extends AgentConfig {
  configVersion: number;
}

export const DEFAULT_SERVER_TIME_OF_DAY = "22:00";
/** A client backs up when it is online, but not more often than this. */
export const DEFAULT_CLIENT_INTERVAL_MINUTES = 4 * 60;

const DEFAULT_PATHS: Record<EndpointOsName, { server: string[]; client: string[] }> = {
  linux: {
    // A server's applications keep their data outside the home directories
    // (databases, containers' volumes, software under /opt): without these a
    // typical server or LXC container backs up little more than /etc.
    server: [
      "/etc",
      "/home",
      "/root",
      "/srv",
      "/var/www",
      "/opt",
      "/usr/local",
      "/var/lib",
      "/var/backups",
    ],
    client: ["/etc", "/home", "/root", "/srv", "/var/www"],
  },
  darwin: { server: ["/Users"], client: ["/Users"] },
  windows: {
    server: ["C:\\Users", "C:\\ProgramData"],
    client: ["C:\\Users"],
  },
};

const COMMON_EXCLUDES = ["**/node_modules", "*.tmp", "**/.cache/restic", "**/.Trash"];

const DEFAULT_EXCLUDES: Record<EndpointOsName, string[]> = {
  linux: [
    ...COMMON_EXCLUDES,
    "**/.cache",
    "**/.local/share/Trash",
    "/home/*/.thumbnails",
    "/root/.cache",
    "/var/cache",
    // Rebuilt from images and package mirrors; the data worth keeping is in
    // volumes, which a job adds by path where they live elsewhere.
    "/var/lib/docker",
    "/var/lib/containerd",
    "/var/lib/apt/lists",
    "/var/tmp",
    "/tmp",
  ],
  darwin: [
    ...COMMON_EXCLUDES,
    "**/Library/Caches",
    "**/Library/Logs",
    "**/.Trashes",
    "**/Library/Application Support/Caches",
    "/Users/*/.Trash",
    "/private/var/tmp",
  ],
  windows: [
    ...COMMON_EXCLUDES,
    "**\\AppData\\Local\\Temp",
    "**\\AppData\\Local\\Microsoft\\Windows\\INetCache",
    "**\\AppData\\Local\\restic",
    "**\\$Recycle.Bin",
    "**\\Thumbs.db",
    "C:\\Windows\\Temp",
  ],
};

export interface DefaultConfigOptions {
  /** IANA zone the daily time is read in. */
  timeZone: string;
}

/** The schedule a profile starts with. */
export function defaultSchedule(
  profile: EndpointProfileName,
  timeZone: string,
): ActiveAgentSchedule {
  return profile === "server"
    ? { kind: "daily", timeOfDay: DEFAULT_SERVER_TIME_OF_DAY, timeZone }
    : { kind: "on_connect", intervalMinutes: DEFAULT_CLIENT_INTERVAL_MINUTES, timeZone };
}

/** The schedule of a machine in no backup job: nothing runs until a job takes it. */
export function noSchedule(timeZone: string): AgentSchedule {
  return { kind: NO_SCHEDULE_KIND, timeZone };
}

/** Whether a schedule is the `none` of a machine in no backup job. */
export function isUnscheduled(schedule: Pick<AgentSchedule, "kind"> | null | undefined): boolean {
  return schedule?.kind === NO_SCHEDULE_KIND;
}

/**
 * The configuration of `os` and `profile` with the schedule a job editor starts from. The folders
 * and exclusions are what a job editor (and `GET /backup-jobs/defaults`) prefills.
 */
export function defaultEndpointConfig(
  os: EndpointOsName,
  profile: EndpointProfileName,
  options: DefaultConfigOptions,
): AgentConfig {
  return {
    profile,
    schedule: defaultSchedule(profile, options.timeZone),
    paths: [...DEFAULT_PATHS[os][profile]],
    excludes: [...DEFAULT_EXCLUDES[os]],
    hooks: {},
    bandwidthKbps: null,
    // Off by default for both profiles: a backup that never runs is worse than one on battery.
    onlyOnAcPower: false,
    // Windows backs up through a volume shadow copy.
    useVss: os === "windows",
  };
}

/**
 * The configuration enrollment writes (release 0.2.1): the defaults of the profile, but the
 * schedule `none`, so a new machine backs up only once it is in a backup job. The folders and
 * exclusions stay in it for the job editor to prefill from.
 */
export function enrolledEndpointConfig(
  os: EndpointOsName,
  profile: EndpointProfileName,
  options: DefaultConfigOptions,
): AgentConfig {
  return { ...defaultEndpointConfig(os, profile, options), schedule: noSchedule(options.timeZone) };
}

/**
 * The configuration as an agent receives it. A machine without a schedule gets no folders and no
 * hooks: an agent of an earlier release does not know the schedule `none` and falls back to the
 * default schedule of its profile (agent/internal/schedule `FromAPI`); without folders such a
 * run stops before restic or a hook starts (`no_paths`), so nothing is backed up and no command
 * runs. An agent of 0.2.1 or later never starts a scheduled backup with `none` anyway.
 */
export function agentFacingConfig<T extends AgentConfig>(config: T): T {
  if (!isUnscheduled(config.schedule)) {
    return config;
  }
  return { ...config, paths: [], hooks: {} };
}

/** Retention every endpoint starts with (docs/AGENT.md): daily 30, weekly 12, monthly 12. */
export const DEFAULT_ENDPOINT_RETENTION = {
  keepDaily: 30,
  keepWeekly: 12,
  keepMonthly: 12,
} as const;

/** Server profile: silent for more than this many hours raises the alert. */
export const DEFAULT_SERVER_STALE_HOURS = 2;
/** Client profile: no backup for this many days raises the alert. */
export const DEFAULT_CLIENT_STALE_DAYS = 7;
