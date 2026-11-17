import { isIP } from "node:net";
import type { HostResolver } from "../net/address-policy.js";

/**
 * Where Restow's own database listens (docs/DATABASES.md 4.2), from a PostgreSQL connection URL as
 * libpq reads it: the hosts of the URL or of its `host` parameter (several, comma-separated), the
 * port of the URL or of its `port` parameter. A Unix socket (a path, or no host at all) is the
 * database on this machine: it stands for loopback, and the probe counts every loopback address
 * as the same server. A name is resolved; a URL that cannot be read or a name that does not
 * resolve is an error, never an empty list (the check must not fail open).
 */
export interface OwnDatabaseTarget {
  address: string;
  port: number;
}

export class OwnDatabaseUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnDatabaseUnknownError";
  }
}

const LOOPBACK = ["127.0.0.1", "::1"];

function list(value: string): string[] {
  return value.split(",").map((part) => part.trim());
}

/** `host[:port]` of a URL's authority, with IPv6 in brackets. */
function hostAndPort(part: string): { host: string; port: string } {
  const bracketed = /^\[([^\]]*)\](?::(.*))?$/.exec(part);
  if (bracketed) {
    return { host: bracketed[1] ?? "", port: bracketed[2] ?? "" };
  }
  const colon = part.lastIndexOf(":");
  return colon < 0
    ? { host: part, port: "" }
    : { host: part.slice(0, colon), port: part.slice(colon + 1) };
}

export async function databaseUrlTargets(
  url: string,
  resolve: HostResolver,
): Promise<OwnDatabaseTarget[]> {
  // As libpq reads it; WHATWG URL refuses forms libpq takes (`postgres://user@/db?host=/run`).
  const match =
    /^postgres(?:ql)?:\/\/(?:[^@/?#]*@)?([^/?#]*)(?:\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(
      url.trim(),
    );
  if (!match) {
    throw new OwnDatabaseUnknownError("the database URL cannot be read");
  }
  const params = new URLSearchParams(match[2] ?? "");
  const authority = list(match[1] ?? "").map(hostAndPort);
  const hostParam = params.get("host");
  const hosts = hostParam !== null ? list(hostParam) : authority.map((entry) => entry.host);
  const portParam = params.get("port");
  const ports = (portParam !== null ? list(portParam) : authority.map((entry) => entry.port)).map(
    (port) => (port === "" ? 5432 : Number(port)),
  );
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new OwnDatabaseUnknownError("the database URL names an invalid port");
  }
  const targets: OwnDatabaseTarget[] = [];
  for (const [index, raw] of hosts.entries()) {
    const port = ports[index] ?? ports[0] ?? 5432;
    let host: string;
    try {
      host = decodeURIComponent(raw).replace(/^\[|\]$/g, "");
    } catch {
      throw new OwnDatabaseUnknownError("the database URL cannot be read");
    }
    if (host === "" || host.startsWith("/") || host.startsWith("@")) {
      // A Unix socket: the database runs on this machine.
      targets.push(...LOOPBACK.map((address) => ({ address, port })));
      continue;
    }
    if (isIP(host) !== 0) {
      targets.push({ address: host, port });
      continue;
    }
    let addresses: readonly string[];
    try {
      addresses = await resolve(host);
    } catch {
      throw new OwnDatabaseUnknownError(`the database host ${host} does not resolve`);
    }
    if (addresses.length === 0) {
      throw new OwnDatabaseUnknownError(`the database host ${host} does not resolve`);
    }
    targets.push(...addresses.map((address) => ({ address, port })));
  }
  return targets;
}
