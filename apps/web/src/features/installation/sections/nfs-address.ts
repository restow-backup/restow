import { type MountView, validExportPath, validMountName, validNfsServer } from "./mounts-api";

/**
 * NFS addresses typed into the path field of a storage location of the kind
 * "directory" (docs/MOUNTS.md, "From the storage form"): the form recognises them and
 * offers to mount the network share through the mounter, then fills in the path the
 * share gets in the application. Accepted forms:
 *
 *   192.168.1.10:/export/backup        host:/absolute/export
 *   nas.local:/volume1/restow          (host name, IPv4, or IPv6 in brackets)
 *   [fd00::5]:/srv/backup
 *   nfs://192.168.1.10/export/backup   nfs:// URL, no port, user, query or fragment
 *
 * Everything else is not an NFS address: a path that starts with "/", a Windows path
 * ("C:\\backup", "c:/backup": a single letter before the colon is a drive, never a
 * host), an IPv6 address without brackets (where would the host end?), anything with
 * spaces, commas, "=" or "..". The server decides again when the share is added
 * (apps/api src/mounter/protocol.ts).
 */
export interface NfsAddress {
  /** Host name, IPv4 address, or IPv6 address without brackets, lower case. */
  server: string;
  /** Absolute export path, without a trailing slash and without repeated slashes. */
  export: string;
}

const URL_FORM = /^nfs:\/\/([^/]*)(\/.*)?$/i;

export function parseNfsAddress(raw: string): NfsAddress | null {
  const value = raw.trim();
  if (value.length === 0 || /\s/.test(value)) {
    return null;
  }
  const url = URL_FORM.exec(value);
  if (url) {
    return addressOf(url[1] ?? "", url[2] ?? "", true);
  }
  if (value.startsWith("/") || value.includes("\\") || value.includes("://")) {
    return null;
  }
  // host:/path, where an IPv6 host must be in brackets.
  let host: string;
  let rest: string;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close < 0 || value[close + 1] !== ":") {
      return null;
    }
    host = value.slice(0, close + 1);
    rest = value.slice(close + 2);
  } else {
    const colon = value.indexOf(":");
    if (colon <= 0) {
      return null;
    }
    host = value.slice(0, colon);
    rest = value.slice(colon + 1);
  }
  return addressOf(host, rest, false);
}

function addressOf(host: string, path: string, fromUrl: boolean): NfsAddress | null {
  if (host.length === 0 || !path.startsWith("/")) {
    return null;
  }
  // A drive letter, not a host ("c:/backup", "nfs://c/..." is just as odd).
  if (/^[A-Za-z]$/.test(host)) {
    return null;
  }
  // No port, no user: the mounter takes neither, and "host:2049" would be ambiguous.
  if (host.includes("@") || (!host.startsWith("[") && host.includes(":"))) {
    return null;
  }
  if (fromUrl && /[?#]/.test(path)) {
    return null;
  }
  if (!validNfsServer(host) || !validExportPath(path)) {
    return null;
  }
  const bracketed = host.startsWith("[") && host.endsWith("]");
  if (bracketed && !host.includes(":")) {
    return null;
  }
  const server = (bracketed ? host.slice(1, -1) : host).replace(/\.$/, "").toLowerCase();
  const collapsed = path.replace(/\/{2,}/g, "/");
  const exportPath = collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  return { server, export: exportPath };
}

/** The address as the mounts section prints it (IPv6 in brackets). */
export function formatNfsAddress(address: NfsAddress): string {
  return `${address.server.includes(":") ? `[${address.server}]` : address.server}:${address.export}`;
}

/**
 * A name for the share, derived from the address: the first label of a host name and
 * the last folder of the export ("nas.local:/volume1/restow" gives "nas-restow"; an IP
 * address contributes nothing: "10.0.0.5:/export/backup" gives "backup"). Lower case,
 * a-z, 0-9 and "-", at most 32 characters, and not one of `taken`.
 */
export function deriveMountName(address: NfsAddress, taken: readonly string[] = []): string {
  const hostPart =
    address.server.includes(":") || /^[0-9.]+$/.test(address.server)
      ? ""
      : (address.server.split(".")[0] ?? "");
  const last = address.export.split("/").filter(Boolean).at(-1) ?? "";
  const base = slug([hostPart, last].filter(Boolean).join("-")) || "nfs";
  const used = new Set(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return base;
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return validMountName(cleaned) ? cleaned : "";
}

/**
 * A share that is mounted already and covers the address: same server, and its export
 * is the address's export or a folder above it. `subfolder` is the rest ("" for the
 * export itself), so the path in the application is `<share path>/<subfolder>`.
 */
export function existingMountFor(
  address: NfsAddress,
  mounts: readonly MountView[],
): { entry: MountView; subfolder: string; path: string } | null {
  let best: { entry: MountView; subfolder: string; path: string } | null = null;
  for (const entry of mounts) {
    if (entry.mount.server.toLowerCase() !== address.server) {
      continue;
    }
    const exported = entry.mount.export.replace(/\/+$/, "") || "/";
    let subfolder: string | null = null;
    if (address.export === exported) {
      subfolder = "";
    } else if (exported === "/") {
      subfolder = address.export.slice(1);
    } else if (address.export.startsWith(`${exported}/`)) {
      subfolder = address.export.slice(exported.length + 1);
    }
    if (subfolder === null) {
      continue;
    }
    // The deepest export wins (two shares of one server, one inside the other).
    if (!best || subfolder.length < best.subfolder.length) {
      best = { entry, subfolder, path: joinPath(entry.path, subfolder) };
    }
  }
  return best;
}

/** `<mount path>` or `<mount path>/<subfolder>`; the subfolder is cleaned of stray slashes. */
export function joinPath(base: string, subfolder: string): string {
  const cleaned = subfolder
    .split("/")
    .filter((segment) => segment.length > 0)
    .join("/");
  return cleaned ? `${base.replace(/\/+$/, "")}/${cleaned}` : base;
}

/** A subfolder below the share: relative, no "." or "..", the export path's characters. */
export function validSubfolder(raw: string): boolean {
  const value = raw.trim().replace(/^\/+/, "");
  if (value.length === 0) {
    return true;
  }
  return validExportPath(`/${value}`);
}
