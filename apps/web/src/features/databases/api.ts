import { apiFetch } from "@/lib/api";

/**
 * Typed client of /api/v1/databases (apps/api/src/features/databases: service.ts for the answers,
 * schemas.ts for the requests). Times are ISO 8601 in UTC. Never a credential: `credential` says
 * whether one is stored.
 */

export type DbEngine = "postgresql" | "mysql" | "mariadb" | "sqlserver" | "sqlite";
export type DbMode = "backup" | "pitr" | "warm_copy";
export type DbExecutorKind = "agent" | "server";
export type DbAuthMethod = "password" | "socket";
export type DbRating = "red" | "overdue" | "unverified" | "not_protected" | "green";
export type DbCapability = "backup" | "verifyOnInstance" | "pitr";
export type DbCapabilityState = "granted" | "missing" | "partial" | "unknown" | "not_applicable";

export interface DbTls {
  offered: boolean | null;
  used: boolean;
  fingerprintSha256: string | null;
  subject: string | null;
  issuer: string | null;
  notAfter: string | null;
}

export interface DbCapabilityVerdict {
  state: DbCapabilityState;
  missing: string[];
  note: string | null;
}

export interface DbRights {
  engine: DbEngine;
  admin: boolean;
  capabilities: Record<DbCapability, DbCapabilityVerdict>;
  grantSql: string | null;
  adminExtras: string[];
}

export interface DbProbe {
  id: string;
  status: "pending" | "running" | "done" | "failed" | "expired";
  executor: { kind: DbExecutorKind; endpointId: string | null };
  address: string;
  engine: DbEngine | null;
  serverVersion: string | null;
  port: number | null;
  tls: DbTls | null;
  login: "ok" | "failed" | "skipped" | null;
  error: { code: string; message: string } | null;
  rights: DbRights | null;
  databases: { name: string; sizeBytes: number | null; accessible: boolean }[];
  identityKnown: boolean;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string;
}

export interface DbSelection {
  mode: "all" | "selected";
  names: string[];
  exclude: string[];
}

export interface DbSchedule {
  kind: "interval";
  intervalMinutes: number;
  timeZone: string;
}

export interface DbConnectionCheck {
  at: string;
  probeId: string;
  login: "ok" | "failed" | "skipped";
  errorCode: string | null;
  errorMessage: string | null;
  rights: DbRights | null;
  tlsFingerprintSeen?: string | null;
  instanceKeySeen?: string | null;
}

/** The health checks of a connection (docs/DATABASES.md 8, stage D2). */
export type DbReachability = "reachable" | "slow" | "unreachable" | "unknown";

export interface DbHealth {
  intervalMinutes: number;
  reachability: DbReachability;
  lastAt: string | null;
  lastOkAt: string | null;
  latencyMs: number | null;
  consecutiveFailures: number;
  failingSince: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** `database.unreachable` was raised for the current episode. */
  alerted: boolean;
}

export type DbBandState = "ok" | "slow" | "down" | "mixed" | "none";

export interface DbBandHour {
  at: string;
  state: DbBandState;
  checks: number;
  okChecks: number;
}

export type DbHealthEvent =
  | { kind: "unreachable"; from: string; to: string | null; errorCode: string | null }
  | { kind: "restart"; at: string; startedAt: string }
  | { kind: "version"; at: string; from: string; to: string }
  | { kind: "tls"; at: string };

export interface DbHealthPoint {
  at: string;
  checks: number;
  okChecks: number;
  latencyMs: number | null;
  latencyMaxMs: number | null;
  connectionsUsed: number | null;
  connectionsMax: number | null;
}

export interface DbConnectionHealth {
  from: string;
  to: string;
  bucketSeconds: number;
  availability: { day: number | null; week: number | null; month: number | null };
  points: DbHealthPoint[];
  events: DbHealthEvent[];
  lastError: { at: string; code: string | null; message: string | null } | null;
}

export interface DbSizeHistory {
  from: string;
  to: string;
  days: { day: string; sizeBytes: number; growthBytes: number | null }[];
}

export interface DbConnection {
  id: string;
  name: string;
  engine: DbEngine;
  address: string;
  host: string | null;
  port: number | null;
  path: string | null;
  executor: {
    kind: DbExecutorKind;
    endpointId: string | null;
    hostname: string | null;
    online: boolean | null;
    lastSeenAt: string | null;
  };
  authMethod: DbAuthMethod;
  credential: "set" | "none";
  allowUnencrypted: boolean;
  tls: {
    fingerprint: string | null;
    subject: string | null;
    issuer: string | null;
    notAfter: string | null;
    confirmedAt: string | null;
    confirmedBy: string | null;
  };
  privateNetworkApproval: { by: string; at: string } | null;
  mode: DbMode;
  schedule: DbSchedule;
  selection: DbSelection;
  identityKnown: boolean;
  serverVersion: string | null;
  lastCheck: DbConnectionCheck | null;
  health: DbHealth;
  state: "ok" | "attention" | "red" | "unchecked";
  notices: string[];
  enabled: boolean;
  databaseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DbDatabase {
  id: string;
  name: string;
  connectionId: string;
  connectionName: string;
  engine: DbEngine;
  mode: DbMode;
  sizeBytes: number | null;
  identityByName: boolean;
  accessible: boolean;
  excluded: boolean;
  droppedAt: string | null;
  lastBackupAt: string | null;
  lastCheckAt: string | null;
  reachable: boolean | null;
  reachability: DbReachability;
  /** The list only: the connection's last 24 hours, hour by hour. */
  band?: DbBandHour[];
  rating: DbRating;
  firstSeenAt: string;
}

export interface DbConnectionDetail extends DbConnection {
  databases: DbDatabase[];
  band: DbBandHour[];
}

export interface DbSuggestion {
  endpointId: string;
  hostname: string;
  engine: "postgresql" | "mysql" | "mariadb";
  name: string;
  version: string | null;
  source: string;
  port: number | null;
  container: string | null;
  running: boolean | null;
  prefill: { address: string; authMethod: DbAuthMethod; endpointId: string } | null;
  collectedAt: string;
}

export interface DbRunner {
  endpointId: string;
  hostname: string;
  os: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface TestConnectionInput {
  address: string;
  user?: string | null;
  password?: string | null;
  authMethod: DbAuthMethod;
  executor: { kind: DbExecutorKind; endpointId?: string | null };
  allowUnencrypted: boolean;
}

export interface CreateConnectionInput {
  probeId: string;
  name?: string | null;
  user?: string | null;
  password?: string | null;
  allowUnencrypted: boolean;
  mode: DbMode;
  schedule?: { intervalMinutes: number; timeZone?: string | null } | null;
  selection?: DbSelection | null;
}

export interface UpdateConnectionInput {
  name?: string;
  user?: string;
  password?: string;
  executor?: { kind: DbExecutorKind; endpointId?: string | null };
  allowUnencrypted?: boolean;
  mode?: DbMode;
  schedule?: { intervalMinutes: number; timeZone?: string | null };
  selection?: DbSelection;
  enabled?: boolean;
  /** Health checks every N minutes, 1 to 60 (8). */
  healthIntervalMinutes?: number;
  confirm?: { probeId: string; tls: boolean; instance: boolean };
}

const BASE = "/databases";

export const fetchDatabases = () => apiFetch<{ databases: DbDatabase[] }>(BASE);
export const fetchDatabase = (id: string) =>
  apiFetch<DbDatabase & { connection: DbConnection }>(`${BASE}/${encodeURIComponent(id)}`);
export const fetchConnections = () =>
  apiFetch<{ connections: DbConnection[] }>(`${BASE}/connections`);
export const fetchConnection = (id: string) =>
  apiFetch<DbConnectionDetail>(`${BASE}/connections/${encodeURIComponent(id)}`);
/** The health history of a connection over the last `days` days (8). */
export const fetchConnectionHealth = (id: string, days: number) => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return apiFetch<DbConnectionHealth>(
    `${BASE}/connections/${encodeURIComponent(id)}/health?${query.toString()}`,
  );
};
/** The size of a database day by day over the last `days` days (8). */
export const fetchDatabaseSizes = (id: string, days: number) => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return apiFetch<DbSizeHistory>(`${BASE}/${encodeURIComponent(id)}/health?${query.toString()}`);
};
export const fetchSuggestions = () =>
  apiFetch<{ suggestions: DbSuggestion[] }>(`${BASE}/suggestions`);
export const fetchRunners = () => apiFetch<{ runners: DbRunner[] }>(`${BASE}/runners`);
export const fetchProbe = (probeId: string) =>
  apiFetch<DbProbe>(`${BASE}/connections/test/${encodeURIComponent(probeId)}`);

export const testConnection = (input: TestConnectionInput) =>
  apiFetch<DbProbe>(`${BASE}/connections/test`, { method: "POST", body: input });
export const testStoredConnection = (id: string) =>
  apiFetch<DbProbe>(`${BASE}/connections/${encodeURIComponent(id)}/test`, { method: "POST" });
export const createConnection = (input: CreateConnectionInput) =>
  apiFetch<DbConnection>(`${BASE}/connections`, { method: "POST", body: input });
export const updateConnection = (id: string, input: UpdateConnectionInput) =>
  apiFetch<DbConnectionDetail>(`${BASE}/connections/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: input,
  });
export const deleteConnection = (id: string) =>
  apiFetch<void>(`${BASE}/connections/${encodeURIComponent(id)}`, { method: "DELETE" });

type TenantKey = string | null;

export const databaseKeys = {
  all: (tenantId: TenantKey) => ["tenant", tenantId, "databases"] as const,
  list: (tenantId: TenantKey) => ["tenant", tenantId, "databases", "list"] as const,
  detail: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "databases", "detail", id] as const,
  connections: (tenantId: TenantKey) => ["tenant", tenantId, "databases", "connections"] as const,
  connection: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "databases", "connection", id] as const,
  connectionHealth: (tenantId: TenantKey, id: string, days: number) =>
    ["tenant", tenantId, "databases", "connection", id, "health", days] as const,
  sizes: (tenantId: TenantKey, id: string, days: number) =>
    ["tenant", tenantId, "databases", "detail", id, "sizes", days] as const,
  suggestions: (tenantId: TenantKey) => ["tenant", tenantId, "databases", "suggestions"] as const,
  runners: (tenantId: TenantKey) => ["tenant", tenantId, "databases", "runners"] as const,
  probe: (tenantId: TenantKey, id: string) =>
    ["tenant", tenantId, "databases", "probe", id] as const,
};

/**
 * A user and a password typed into the address as a URL move into their fields (3.1): what is
 * left is the address without them. Anything that is no such URL comes back unchanged.
 */
export function splitAddressCredentials(address: string): {
  address: string;
  user: string | null;
  password: string | null;
} {
  const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/@\s]*)@(.*)$/.exec(address.trim());
  if (!match) {
    return { address, user: null, password: null };
  }
  const [, scheme = "", credentials = "", rest = ""] = match;
  const colon = credentials.indexOf(":");
  const decode = (text: string) => {
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  };
  return {
    address: `${scheme}${rest}`,
    user: decode(colon >= 0 ? credentials.slice(0, colon) : credentials) || null,
    password: colon >= 0 ? decode(credentials.slice(colon + 1)) : null,
  };
}
