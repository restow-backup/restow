import { isIP, type LookupFunction, connect as netConnect, type Socket } from "node:net";
import {
  classifyAddress,
  guardedLookup,
  normalizeHost,
  refuseHostBeforeConnect,
} from "../../net/address-policy.js";
import type { DbProbeResult, DbProbeSpec } from "../facts.js";
import { DB_HEALTH_TIMEOUT_SECONDS } from "../health.js";
import type { DbEngine, DbErrorCode } from "../model.js";
import { probeDatabaseFromServer } from "./probe.js";

/**
 * The health check with the Restow server as executor (docs/DATABASES.md 8), the one entry the
 * worker calls. It runs the probe in its `health` purpose and adds what a check that runs on its
 * own every few minutes needs on top of a connection test:
 *
 *   - the stored certificate is passed along, so another one ends the check after the TLS
 *     handshake and before a credential is sent (`db_tls_changed`);
 *   - one overall deadline (10 seconds, 8): when it passes, every socket the check opened is
 *     destroyed and the check is a failed one (`db_unreachable`), whatever step it was in;
 *   - the network protection of every connection (4.2): the address is judged before
 *     connecting, and every name resolves through the guarded lookup, exactly as for a test.
 *
 * The probe's own primitives (DbConn, the protocol clients) are hardened separately; this module
 * only depends on `probeDatabaseFromServer` and its socket factory, so it keeps working with them.
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
  tlsFingerprint: string | null;
  /** Read the size of every database too (at most once an hour). */
  sizes: boolean;
}

export interface DbHealthCheckOptions {
  /** `RESTOW_DB_ALLOW_PRIVATE_NETWORKS` or the provider admin's approval of this connection. */
  allowPrivateNetworks: boolean;
  /** The overall deadline (default {@link DB_HEALTH_TIMEOUT_SECONDS}). */
  deadlineMs?: number;
  /** Tests: a lookup instead of the guarded system resolver. */
  lookup?: LookupFunction;
  /** Tests: opens the socket instead of the network; it still goes through the deadline. */
  connect?: (host: string, port: number) => Socket;
  stepTimeoutMs?: number;
}

const HEALTH_PROBE_ID = "00000000-0000-4000-8000-00000000d002";

function failed(code: DbErrorCode, message: string, durationMs: number): DbProbeResult {
  return {
    engine: null,
    port: null,
    serverVersion: null,
    tls: {
      offered: null,
      used: false,
      fingerprintSha256: null,
      subject: null,
      issuer: null,
      notAfter: null,
    },
    login: "skipped",
    error: { code, message },
    durationMs,
  };
}

/** Run one health check from the Restow server. Never throws and never outlives its deadline. */
export async function checkDatabaseHealthFromServer(
  target: DbHealthCheckTarget,
  options: DbHealthCheckOptions,
): Promise<DbProbeResult> {
  const started = Date.now();
  const deadlineMs = options.deadlineMs ?? DB_HEALTH_TIMEOUT_SECONDS * 1000;
  const refusal = refuseHostBeforeConnect(target.host, options.allowPrivateNetworks);
  if (refusal) {
    const literal = normalizeHost(target.host);
    const kind = isIP(literal) !== 0 ? classifyAddress(literal) : "private";
    return kind === "private" || kind === "loopback"
      ? failed(
          "db_private_network",
          "The address is in a private network; only a provider admin can approve it.",
          0,
        )
      : failed(
          "db_forbidden_address",
          "The address is link-local, multicast or reserved; Restow never connects there.",
          0,
        );
  }
  const lookup = options.lookup ?? guardedLookup(options.allowPrivateNetworks);
  const sockets = new Set<Socket>();
  let expired = false;
  const connect = (host: string, port: number): Socket => {
    const socket = options.connect
      ? options.connect(host, port)
      : netConnect({ host, port, lookup });
    if (expired) {
      socket.destroy();
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
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
    timeoutSeconds: Math.max(1, Math.ceil(deadlineMs / 1000)),
    purpose: "health",
    tlsFingerprint: target.tlsFingerprint,
    sizes: target.sizes,
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<DbProbeResult>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
      resolve(
        failed(
          "db_unreachable",
          `The check did not finish within ${Math.round(deadlineMs / 1000)} seconds.`,
          Date.now() - started,
        ),
      );
    }, deadlineMs);
  });
  try {
    return await Promise.race([
      probeDatabaseFromServer(spec, {
        allowPrivateNetworks: options.allowPrivateNetworks,
        connect,
        ...(options.stepTimeoutMs ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
      }),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) {
      socket.destroy();
    }
  }
}
