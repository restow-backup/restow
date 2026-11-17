import type { LookupFunction, Socket } from "node:net";
import type { DbProbeResult, DbProbeSpec } from "../facts.js";
import { DB_HEALTH_TIMEOUT_SECONDS } from "../health.js";
import type { DbEngine } from "../model.js";
import { probeDatabaseFromServer } from "./probe.js";

/**
 * The health check with the Restow server as executor (docs/DATABASES.md 8), the one entry the
 * worker calls. It is the probe of a connection test in its `health` purpose and runs inside the
 * same hardened scope (`probeDatabaseFromServer`, ./conn.ts `DbProbeScope`), with nothing of its
 * own around it:
 *
 *   - one deadline of 10 seconds for the whole check, after which every socket it opened is
 *     closed, and one read budget across all of them; every value of a row is cut while it is
 *     read, the size queries included;
 *   - the confirmed certificate is passed as `pinnedFingerprintSha256`: another one (or no TLS)
 *     ends the check right after the handshake, before any of the sign-in is sent;
 *   - the network protection of every connection (4.2): private addresses only with the
 *     installation flag or the addresses a provider admin's approval names (an approval without
 *     addresses reaches none); link-local and reserved never; every name through the guarded
 *     lookup; Restow's own database (`forbiddenTargets`) refused by the address it reached,
 *     before the sign-in.
 *
 * A health check never changes the connection: it renews no approval and confirms no
 * certificate; what it sees is a sample the server judges (../health.ts).
 */

export interface DbHealthCheckTarget {
  engine: DbEngine;
  host: string;
  port: number | null;
  database: string | null;
  user: string | null;
  password: string | null;
  allowUnencrypted: boolean;
  /** The certificate an administrator confirmed (null: none, the connection is unencrypted). */
  pinnedFingerprintSha256: string | null;
  /** Read the size of every database too (at most once an hour). */
  sizes: boolean;
}

export interface DbHealthCheckOptions {
  /** `RESTOW_DB_ALLOW_PRIVATE_NETWORKS`: any private address. Never a provider admin's session. */
  allowPrivateNetworks: boolean;
  /** The private addresses the connection's approval names; only these without the flag. */
  approvedAddresses: readonly string[];
  /** Where Restow's own database listens (apps/worker reads them from its database URLs). */
  forbiddenTargets: readonly { address: string; port: number }[];
  /** The overall deadline in seconds (default {@link DB_HEALTH_TIMEOUT_SECONDS}). */
  timeoutSeconds?: number;
  /** Tests: the read budget of the scope. */
  readBudgetBytes?: number;
  /** Tests: a lookup instead of the guarded system resolver. */
  lookup?: LookupFunction;
  /** Tests: a socket factory instead of the guarded network (it skips the address check). */
  connect?: (host: string, port: number) => Socket;
  stepTimeoutMs?: number;
}

const HEALTH_PROBE_ID = "00000000-0000-4000-8000-00000000d002";

/** Run one health check from the Restow server. Never throws and never outlives its deadline. */
export function checkDatabaseHealthFromServer(
  target: DbHealthCheckTarget,
  options: DbHealthCheckOptions,
): Promise<DbProbeResult> {
  const spec: DbProbeSpec = {
    probeId: HEALTH_PROBE_ID,
    engine: target.engine,
    host: target.host,
    port: target.port,
    path: null,
    database: target.database,
    authMethod: "password",
    user: target.user,
    password: target.password,
    allowUnencrypted: target.allowUnencrypted,
    timeoutSeconds: options.timeoutSeconds ?? DB_HEALTH_TIMEOUT_SECONDS,
    purpose: "health",
    pinnedFingerprintSha256: target.pinnedFingerprintSha256,
    sizes: target.sizes,
  };
  return probeDatabaseFromServer(spec, {
    allowPrivateNetworks: options.allowPrivateNetworks,
    approvedAddresses: options.approvedAddresses,
    forbiddenTargets: options.forbiddenTargets,
    ...(options.readBudgetBytes ? { readBudgetBytes: options.readBudgetBytes } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.stepTimeoutMs ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
  });
}
