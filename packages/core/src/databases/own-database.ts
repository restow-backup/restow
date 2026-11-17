import { isIP } from "node:net";
import type { HostResolver } from "../net/address-policy.js";

/**
 * Where Restow's own database listens (docs/DATABASES.md 4.2), from a PostgreSQL connection string
 * as the database clients read it: a URL (`postgres://…`) or keyword/value pairs
 * (`host=db port=5432 dbname=restow`). The hosts of the URL or of its `host` parameter (several,
 * comma-separated), the port of the URL or of its `port` parameter; what the string leaves out
 * comes from `PGHOST` and `PGPORT` as node-postgres takes them. `hostaddr` (and `PGHOSTADDR`) is
 * the address libpq connects to whatever the name says: it is added too. A Unix socket (a path,
 * or no host at all) is the database on this machine: it stands for loopback, and the probe counts
 * every loopback address as the same server. A name is resolved; a string that cannot be read or a
 * name that does not resolve is an error, never an empty list (the check must not fail open).
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

/** The environment the database clients read their defaults from (`PGHOST`, `PGPORT`, `PGHOSTADDR`). */
export type DatabaseEnvironment = Readonly<Record<string, string | undefined>>;

interface ConnectionParts {
  /** The hosts as written (empty: none given). */
  hosts: string[];
  ports: string[];
  hostaddrs: string[];
}

/** Keyword/value pairs (`host=db port='5432'`), values in single quotes with `\\` escapes. */
function keywordValues(text: string): Map<string, string> | null {
  const pairs = new Map<string, string>();
  const pattern = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:'((?:[^'\\]|\\.)*)'|([^\s']*))/y;
  let offset = 0;
  const rest = text.trim();
  while (offset < rest.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(rest);
    if (!match) {
      return null;
    }
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? "");
    pairs.set((match[1] ?? "").toLowerCase(), value);
    offset = pattern.lastIndex;
    while (offset < rest.length && /\s/.test(rest.charAt(offset))) {
      offset++;
    }
  }
  return pairs.size > 0 ? pairs : null;
}

function partsOf(connection: string): ConnectionParts {
  const text = connection.trim();
  // As libpq reads it; WHATWG URL refuses forms libpq takes (`postgres://user@/db?host=/run`).
  const match =
    /^postgres(?:ql)?:\/\/(?:[^@/?#]*@)?([^/?#]*)(?:\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i.exec(text);
  if (match) {
    const params = new URLSearchParams(match[2] ?? "");
    const authority = list(match[1] ?? "").map(hostAndPort);
    const hostParam = params.get("host");
    const portParam = params.get("port");
    const hostaddr = params.get("hostaddr");
    return {
      hosts:
        hostParam !== null
          ? list(hostParam)
          : authority.every((entry) => entry.host === "")
            ? []
            : authority.map((entry) => entry.host),
      ports: portParam !== null ? list(portParam) : authority.map((entry) => entry.port),
      hostaddrs: hostaddr !== null ? list(hostaddr).filter(Boolean) : [],
    };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    throw new OwnDatabaseUnknownError("the database URL cannot be read");
  }
  const pairs = keywordValues(text);
  if (!pairs) {
    throw new OwnDatabaseUnknownError("the database connection string cannot be read");
  }
  return {
    hosts: pairs.has("host") ? list(pairs.get("host") ?? "") : [],
    ports: pairs.has("port") ? list(pairs.get("port") ?? "") : [],
    hostaddrs: pairs.has("hostaddr") ? list(pairs.get("hostaddr") ?? "").filter(Boolean) : [],
  };
}

export async function databaseUrlTargets(
  url: string,
  resolve: HostResolver,
  env: DatabaseEnvironment = process.env,
): Promise<OwnDatabaseTarget[]> {
  const parts = partsOf(url);
  // What the string leaves out comes from the environment, as node-postgres takes it.
  const envHost = env.PGHOST?.trim() ?? "";
  const hosts = parts.hosts.length > 0 ? parts.hosts : [envHost];
  const envPort = env.PGPORT?.trim() ?? "";
  const ports = (parts.ports.length > 0 ? parts.ports : [""]).map((port) => {
    const text = port === "" ? envPort : port;
    return text === "" ? 5432 : Number(text);
  });
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new OwnDatabaseUnknownError("the database URL names an invalid port");
  }
  const hostaddrs =
    parts.hostaddrs.length > 0
      ? parts.hostaddrs
      : list(env.PGHOSTADDR?.trim() ?? "").filter(Boolean);
  const targets: OwnDatabaseTarget[] = [];
  for (const [index, address] of hostaddrs.entries()) {
    if (isIP(address) === 0) {
      throw new OwnDatabaseUnknownError("the database hostaddr is no IP address");
    }
    targets.push({ address, port: ports[index] ?? ports[0] ?? 5432 });
  }
  for (const [index, raw] of hosts.entries()) {
    const port = ports[index] ?? ports[0] ?? 5432;
    let host: string;
    try {
      host = decodeURIComponent(raw).replace(/^\[|\]$/g, "");
    } catch {
      throw new OwnDatabaseUnknownError("the database URL cannot be read");
    }
    if (host === "" || host.startsWith("/") || host.startsWith("@")) {
      // A Unix socket (or no host: node-postgres takes localhost): this machine.
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
