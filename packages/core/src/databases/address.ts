import type { DbEngine } from "./model.js";

/**
 * The address field of the dialog (docs/DATABASES.md 3.1). It takes
 *
 *   - a URL: `postgres://` or `postgresql://`, `mysql://`, `mariadb://`, `sqlserver://`. A user and
 *     password in the URL are handed back separately (the dialog moves them into their fields)
 *     and are never part of the address that is stored;
 *   - `host:port`, `[v6]:port` or only `host`: the engine is detected from the first exchange of
 *     its protocol (probe/detect.ts), trying 5432, 3306 and 1433 without a port;
 *   - a file path (`/var/lib/app/data.db`, `C:\data\app.db`, `sqlite:///var/lib/app.db`): SQLite,
 *     only with an agent on that machine.
 */

export type DbNetworkAddress = {
  kind: "network";
  host: string;
  /** null: not given, the detection tries the default ports. */
  port: number | null;
  /** What the URL scheme says; detection still decides (MySQL and MariaDB share a scheme). */
  engineHint: DbEngine | null;
  /** The database named in the URL path (PostgreSQL: the one to sign in to). */
  database: string | null;
};

export type DbFileAddress = { kind: "file"; path: string; engineHint: "sqlite" };

export type DbAddress = DbNetworkAddress | DbFileAddress;

export type DbAddressParse =
  | {
      ok: true;
      address: DbAddress;
      /** Taken out of a URL, for the fields of the dialog; never stored with the address. */
      user: string | null;
      password: string | null;
    }
  | { ok: false; reason: "empty" | "invalid" | "scheme" | "port" | "host" };

const SCHEMES: Readonly<Record<string, DbEngine>> = {
  postgres: "postgresql",
  postgresql: "postgresql",
  mysql: "mysql",
  mariadb: "mariadb",
  sqlserver: "sqlserver",
  mssql: "sqlserver",
};

const MAX_ADDRESS_LENGTH = 1024;

/** A host name or a literal address as it may stand in the address field. */
const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;

function validHost(host: string): boolean {
  if (host.includes(":")) {
    // IPv6 literal (brackets removed by the caller).
    return /^[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?$/.test(host) && host.length <= 64;
  }
  return HOST_PATTERN.test(host);
}

function parsePort(text: string): number | null | "invalid" {
  if (text === "") {
    return null;
  }
  if (!/^\d{1,5}$/.test(text)) {
    return "invalid";
  }
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : "invalid";
}

function isFilePath(text: string): boolean {
  return text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** `host`, `host:port`, `[v6]` or `[v6]:port`. */
function splitHostPort(
  text: string,
): { host: string; port: number | null } | { error: "port" | "host" } {
  let host: string;
  let portText = "";
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) {
      return { error: "host" };
    }
    host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest !== "" && !rest.startsWith(":")) {
      return { error: "host" };
    }
    portText = rest.slice(1);
  } else {
    const colons = text.split(":").length - 1;
    if (colons > 1) {
      // A bare IPv6 address without a port.
      host = text;
    } else if (colons === 1) {
      const at = text.lastIndexOf(":");
      host = text.slice(0, at);
      portText = text.slice(at + 1);
    } else {
      host = text;
    }
  }
  const port = parsePort(portText);
  if (port === "invalid") {
    return { error: "port" };
  }
  if (!validHost(host)) {
    return { error: "host" };
  }
  return { host: host.toLowerCase(), port };
}

/** Read what an administrator typed into the address field. */
export function parseDbAddress(input: string): DbAddressParse {
  const text = input.trim();
  if (text === "") {
    return { ok: false, reason: "empty" };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  if (text.length > MAX_ADDRESS_LENGTH || /[\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, reason: "invalid" };
  }
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text);
  if (schemeMatch) {
    const scheme = (schemeMatch[1] ?? "").toLowerCase();
    if (scheme === "sqlite" || scheme === "file") {
      const path = safeDecode(text.slice(schemeMatch[0].length));
      // sqlite:///var/lib/app.db -> /var/lib/app.db; sqlite://C:/data/app.db -> C:/data/app.db
      const normalized = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) ? path : `/${path}`;
      return isFilePath(normalized) && normalized.length > 1
        ? {
            ok: true,
            address: { kind: "file", path: normalized, engineHint: "sqlite" },
            user: null,
            password: null,
          }
        : { ok: false, reason: "invalid" };
    }
    const engine = SCHEMES[scheme];
    if (!engine) {
      return { ok: false, reason: "scheme" };
    }
    let rest = text.slice(schemeMatch[0].length);
    // Query and fragment carry nothing Restow keeps (sslmode and friends are decided by Restow).
    rest = rest.replace(/[?#].*$/, "");
    let user: string | null = null;
    let password: string | null = null;
    const at = rest.lastIndexOf("@");
    if (at >= 0) {
      const credentials = rest.slice(0, at);
      rest = rest.slice(at + 1);
      const colon = credentials.indexOf(":");
      user = safeDecode(colon >= 0 ? credentials.slice(0, colon) : credentials) || null;
      password = colon >= 0 ? safeDecode(credentials.slice(colon + 1)) : null;
    }
    const slash = rest.indexOf("/");
    const authority = slash >= 0 ? rest.slice(0, slash) : rest;
    const pathPart = slash >= 0 ? safeDecode(rest.slice(slash + 1)) : "";
    // sqlserver://host;database=x keeps only the host.
    const hostPart = engine === "sqlserver" ? (authority.split(";")[0] ?? "") : authority;
    const split = splitHostPort(hostPart);
    if ("error" in split) {
      return { ok: false, reason: split.error };
    }
    const database = pathPart.split("/")[0]?.trim() || null;
    return {
      ok: true,
      address: {
        kind: "network",
        host: split.host,
        port: split.port,
        engineHint: engine,
        database: database && database.length <= 128 ? database : null,
      },
      user,
      password,
    };
  }
  if (isFilePath(text)) {
    return {
      ok: true,
      address: { kind: "file", path: text, engineHint: "sqlite" },
      user: null,
      password: null,
    };
  }
  const split = splitHostPort(text);
  if ("error" in split) {
    return { ok: false, reason: split.error };
  }
  return {
    ok: true,
    address: {
      kind: "network",
      host: split.host,
      port: split.port,
      engineHint: null,
      database: null,
    },
    user: null,
    password: null,
  };
}

/** How an address is shown and stored: never with a user or a password. */
export function formatDbAddress(address: {
  host?: string | null;
  port?: number | null;
  path?: string | null;
}): string {
  if (address.path) {
    return address.path;
  }
  const host = address.host ?? "";
  const shown = host.includes(":") ? `[${host}]` : host;
  return address.port ? `${shown}:${address.port}` : shown;
}
