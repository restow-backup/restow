import { isIP } from "node:net";

/**
 * Validation of a file share's connection settings (docs/FILESHARES.md 3.2). The
 * mounter decides (apps/api/src/mounter/runner-protocol.ts, which cannot import this
 * package); the api and the worker check here first, with the same rules: both are
 * tested against testdata/specs.json.
 */

export const SMB_VERSIONS = ["3.1.1", "3.0", "2.1"] as const;
export type SmbVersion = (typeof SMB_VERSIONS)[number];

export const SHARE_NFS_VERSIONS = ["3", "4", "4.1", "4.2"] as const;
export type ShareNfsVersion = (typeof SHARE_NFS_VERSIONS)[number];

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const SHARE_NAME_FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const USERNAME_FORBIDDEN = /[,=\\/\u0000-\u001f\u007f]/;
const DOMAIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const CONTROL = /[\u0000-\u001f\u007f]/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const EXPORT_CHARACTERS = /^\/[A-Za-z0-9._\-/@+~]*$/;

/** Mount flags Docker takes out of a volume's `o=` (moby/sys/mount); see runner-protocol.ts. */
const DOCKER_MOUNT_FLAGS = new Set([
  "defaults",
  "ro",
  "rw",
  "suid",
  "nosuid",
  "dev",
  "nodev",
  "exec",
  "noexec",
  "sync",
  "async",
  "dirsync",
  "remount",
  "mand",
  "nomand",
  "atime",
  "noatime",
  "diratime",
  "nodiratime",
  "bind",
  "rbind",
  "unbindable",
  "runbindable",
  "private",
  "rprivate",
  "shared",
  "rshared",
  "slave",
  "rslave",
  "relatime",
  "norelatime",
  "strictatime",
  "nostrictatime",
]);

export function isValidShareName(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 80 &&
    !SHARE_NAME_FORBIDDEN.test(value) &&
    value !== "." &&
    value !== ".." &&
    value.trim() === value
  );
}

export function isValidSubfolder(value: string): boolean {
  if (value === "") {
    return true;
  }
  if (value.length > 1024 || value.startsWith("/") || value.endsWith("/")) {
    return false;
  }
  return value
    .split("/")
    .every(
      (segment) =>
        segment.length >= 1 &&
        segment.length <= 255 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.includes("\\") &&
        !CONTROL.test(segment),
    );
}

export function isValidUsername(value: string): boolean {
  return value.length >= 1 && value.length <= 104 && !USERNAME_FORBIDDEN.test(value);
}

export function isValidDomain(value: string): boolean {
  return DOMAIN_PATTERN.test(value);
}

export function isValidSharePassword(value: string): boolean {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 256 || CONTROL.test(value) || value.includes("�")) {
    return false;
  }
  return !value.split(",").some((piece) => DOCKER_MOUNT_FLAGS.has(piece));
}

export function isIpLiteral(value: string): boolean {
  return isIP(value) !== 0 && !value.includes("%");
}

/** As the mounter's normalizeNfsServer: a host name, IPv4 or IPv6 (brackets removed), lower case. */
export function normalizeShareServer(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 253 || /[\s,=%]/.test(value)) {
    return null;
  }
  const unbracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (isIP(unbracketed) === 6) {
    return unbracketed.toLowerCase();
  }
  if (unbracketed !== value) {
    return null;
  }
  if (isIP(value) === 4) {
    return value;
  }
  if (/^[0-9.]+$/.test(value)) {
    return null;
  }
  const labels = value.replace(/\.$/, "").split(".");
  if (labels.some((label) => !HOST_LABEL.test(label))) {
    return null;
  }
  return value.replace(/\.$/, "").toLowerCase();
}

/** As the mounter's normalizeExportPath. */
export function normalizeShareExport(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 1024 || !EXPORT_CHARACTERS.test(value)) {
    return null;
  }
  const segments = value.split("/");
  if (segments.includes("..") || segments.includes(".")) {
    return null;
  }
  const collapsed = value.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
}

/**
 * `DOMAIN\user` is split into the domain and the user (3.2); `user@domain` and a
 * plain name stay as they are.
 */
export function splitAccount(raw: string): { domain: string | null; username: string } {
  const value = raw.trim();
  const backslash = value.indexOf("\\");
  if (backslash > 0 && backslash === value.lastIndexOf("\\")) {
    return { domain: value.slice(0, backslash), username: value.slice(backslash + 1) };
  }
  return { domain: null, username: value };
}

/** The fields of a share spec that are not valid (empty: valid). Mirrors the mounter's schema. */
export function shareSpecProblems(spec: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const str = (key: string): string | null => {
    const value = spec[key];
    return typeof value === "string" ? value : null;
  };
  const allowed =
    spec.protocol === "smb"
      ? [
          "protocol",
          "server",
          "address",
          "share",
          "subfolder",
          "username",
          "password",
          "domain",
          "smbVersion",
          "seal",
        ]
      : ["protocol", "server", "address", "export", "subfolder", "nfsVersion"];
  for (const key of Object.keys(spec)) {
    if (!allowed.includes(key)) {
      problems.push(key);
    }
  }
  if (spec.protocol !== "smb" && spec.protocol !== "nfs") {
    return ["protocol"];
  }
  const server = str("server");
  if (server === null || normalizeShareServer(server) === null) {
    problems.push("server");
  }
  const address = str("address");
  if (address === null || !isIpLiteral(address)) {
    problems.push("address");
  }
  const subfolder = str("subfolder");
  if (subfolder === null || !isValidSubfolder(subfolder)) {
    problems.push("subfolder");
  }
  if (spec.protocol === "smb") {
    const share = str("share");
    if (share === null || !isValidShareName(share)) {
      problems.push("share");
    }
    const username = str("username");
    if (username === null || !isValidUsername(username)) {
      problems.push("username");
    }
    const password = str("password");
    if (password === null || !isValidSharePassword(password)) {
      problems.push("password");
    }
    if (spec.domain !== null && (typeof spec.domain !== "string" || !isValidDomain(spec.domain))) {
      problems.push("domain");
    }
    const version = str("smbVersion");
    if (version === null || !(SMB_VERSIONS as readonly string[]).includes(version)) {
      problems.push("smbVersion");
    }
    if (typeof spec.seal !== "boolean" || (spec.seal && version === "2.1")) {
      problems.push("seal");
    }
  } else {
    const exportPath = str("export");
    if (exportPath === null || normalizeShareExport(exportPath) === null) {
      problems.push("export");
    }
    const version = str("nfsVersion");
    if (version === null || !(SHARE_NFS_VERSIONS as readonly string[]).includes(version)) {
      problems.push("nfsVersion");
    }
  }
  return problems;
}
