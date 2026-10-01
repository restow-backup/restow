/**
 * The agent's configuration and its defaults per operating system and profile
 * (the `GET /agent/v1/config` contract, docs/AGENT.md).
 *
 * Defaults:
 *   - server profile: daily at 22:00; client profile: `on_connect`, at most one
 *     backup every 4 hours;
 *   - paths per OS (Linux `/etc /home /root /srv /var/www`, macOS `/Users`,
 *     Windows `C:\Users`, plus `C:\ProgramData` for servers);
 *   - excludes per OS: caches, temporary files, the trash, `node_modules`,
 *     `*.tmp` and the restic cache.
 *
 * Windows stays in the model for a later release; the server does not enroll
 * Windows endpoints in 0.1.0 ({@link SUPPORTED_ENDPOINT_OS}).
 */

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

export interface AgentSchedule {
  kind: "interval" | "daily" | "on_connect";
  intervalMinutes?: number;
  timeOfDay?: string;
  timeZone: string;
}

export interface AgentConfig {
  profile: EndpointProfileName;
  schedule: AgentSchedule;
  paths: string[];
  excludes: string[];
  hooks: { pre?: string; post?: string };
  bandwidthKbps: number | null;
  onlyOnAcPower: boolean;
  useVss: boolean;
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
    server: ["/etc", "/home", "/root", "/srv", "/var/www"],
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
export function defaultSchedule(profile: EndpointProfileName, timeZone: string): AgentSchedule {
  return profile === "server"
    ? { kind: "daily", timeOfDay: DEFAULT_SERVER_TIME_OF_DAY, timeZone }
    : { kind: "on_connect", intervalMinutes: DEFAULT_CLIENT_INTERVAL_MINUTES, timeZone };
}

/** The configuration a new endpoint of `os` and `profile` gets. */
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
