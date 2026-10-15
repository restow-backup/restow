/**
 * Pure helpers of check 12 (file shares against Samba, docs/FILESHARES.md 16.4): the files the
 * share starts with, how the check compares trees and ZIPs by SHA-256, and how it reads what
 * Samba's tools print (smbcacls, pdbedit). Nothing here talks to Docker or the api; the check
 * (checks/12-file-share.mjs) does, and lib/fileshares.test.mjs pins these.
 */
import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Folders of the corpus and how many files each holds. */
const FOLDERS = [
  ["Finance", 40],
  ["Finance/2025", 40],
  ["Projects/Alpha", 50],
  ["Projects/Beta", 50],
  ["Reports", 60],
  ["Scans", 30],
];

/** A file with a name that is not ASCII (umlauts, sharp s, an en dash in NFC). */
export const NON_ASCII_FILE = "Reports/Größenübersicht März – Ä.txt";
/** The file that carries an explicit ACL entry set with smbcacls. */
export const ACL_FILE = "Finance/budget.txt";
/** A SID the explicit entry names: BUILTIN\Backup Operators, known on every Samba. */
export const ACL_SID = "S-1-5-32-551";
/** The file the backup account is denied to read (an explicit DENY entry): a per-file warning. */
export const DENIED_FILE = "Private/denied.txt";
/** A file of the excluded type (`tmp`, the job's one excluded pattern). */
export const EXCLUDED_FILE = "Scans/scratch.tmp";
/** The excluded file type of the share job. */
export const EXCLUDED_EXTENSION = "tmp";

/** Deterministic bytes: a header line and `size` pseudo-random bytes from the seed. */
export function fileBytes(seed, size) {
  const out = Buffer.alloc(size);
  let state = 0;
  for (const char of seed) {
    state = (state * 31 + char.codePointAt(0)) >>> 0;
  }
  for (let index = 0; index < size; index += 1) {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out[index] = state & 0xff;
  }
  return Buffer.concat([Buffer.from(`restow smoke ${seed}\n`, "utf8"), out]);
}

/**
 * The files the `data` share starts with: a few hundred files in folders, one with a non-ASCII
 * name, the ACL file, the denied file and one excluded file. `{ path, bytes }`, sorted by path.
 */
export function shareCorpus(seed = "fs1") {
  const files = [];
  for (const [folder, count] of FOLDERS) {
    for (let index = 1; index <= count; index += 1) {
      const path = `${folder}/doc-${String(index).padStart(3, "0")}.bin`;
      files.push({ path, bytes: fileBytes(`${seed}/${path}`, 200 + ((index * 977) % 6000)) });
    }
  }
  for (const path of [NON_ASCII_FILE, ACL_FILE, DENIED_FILE, EXCLUDED_FILE]) {
    files.push({ path, bytes: fileBytes(`${seed}/${path}`, 1500) });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What a backup of the corpus must hold: everything but the denied and the excluded file. */
export function expectedInBackup(files) {
  return files.filter((file) => file.path !== DENIED_FILE && file.path !== EXCLUDED_FILE);
}

/** `{ path -> sha256 }` of `{ path, bytes }` files, below `prefix` (a folder, "" for all). */
export function hashesOf(files, prefix = "") {
  const map = new Map();
  for (const file of files) {
    if (prefix === "" || file.path.startsWith(`${prefix}/`)) {
      map.set(prefix ? file.path.slice(prefix.length + 1) : file.path, sha256(file.bytes));
    }
  }
  return map;
}

/**
 * `{ path -> sha256 }` from what `find . -type f -exec sha256sum {} +` prints in a folder
 * (`<hash>  ./a/b`), the `./` dropped. File names are UTF-8.
 */
export function parseFindSums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line);
    if (match) {
      map.set(match[2].replace(/^\.\//u, ""), match[1]);
    }
  }
  return map;
}

/** How two `{ path -> sha256 }` maps differ: paths only in one, and paths whose hash differs. */
export function compareHashes(expected, actual) {
  const missing = [...expected.keys()].filter((path) => !actual.has(path)).sort();
  const extra = [...actual.keys()].filter((path) => !expected.has(path)).sort();
  const differ = [...expected.keys()]
    .filter((path) => actual.has(path) && actual.get(path) !== expected.get(path))
    .sort();
  return { missing, extra, differ, same: missing.length + extra.length + differ.length === 0 };
}

/** One line for a report: what differs, a few paths of each kind. */
export function describeDifference(difference) {
  const part = (label, paths) =>
    paths.length > 0
      ? `${paths.length} ${label} (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", ..." : ""})`
      : null;
  return [
    part("missing", difference.missing),
    part("unexpected", difference.extra),
    part("different", difference.differ),
  ]
    .filter(Boolean)
    .join("; ");
}

/** `{ path -> sha256 }` of the files of ZIP entries (`{ name, data }`); folders are left out. */
export function zipHashes(entries) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.name.endsWith("/")) {
      map.set(entry.name.replace(/^\/+/u, ""), sha256(entry.data));
    }
  }
  return map;
}

/**
 * The name restow-share gives a file a keep-both restore found changed in place:
 * `<stem> (restored <label>)<ext>` next to it (agent/internal/share/restore.go).
 */
export function isRestoredCopyOf(original, candidate) {
  const slash = original.lastIndexOf("/");
  const dir = slash >= 0 ? original.slice(0, slash + 1) : "";
  const base = original.slice(dir.length);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  if (!candidate.startsWith(`${dir}${stem} (restored `) || !candidate.endsWith(`)${ext}`)) {
    return false;
  }
  const middle = candidate.slice(
    `${dir}${stem} (restored `.length,
    candidate.length - ext.length - 1,
  );
  return middle.length > 0 && !middle.includes("/");
}

/** The user SID `pdbedit -L -v -u <user>` prints (`User SID: S-1-5-21-...`), or null. */
export function userSidOf(pdbeditOutput) {
  return /^User SID:\s*(S-1-5-21-[0-9-]+)\s*$/mu.exec(pdbeditOutput)?.[1] ?? null;
}

/**
 * The entries of what `smbcacls --numeric` prints for a file: `{ sid, type, flags, mask }` per
 * `ACL:` line.
 */
export function aclEntries(smbcaclsOutput) {
  const entries = [];
  for (const line of smbcaclsOutput.split(/\r?\n/u)) {
    const match = /^ACL:([^:]+):(ALLOWED|DENIED)\/([^/]+)\/(.+)$/u.exec(line.trim());
    if (match) {
      entries.push({ sid: match[1], type: match[2], flags: match[3], mask: match[4] });
    }
  }
  return entries;
}

/** Whether the ACL holds an entry for `sid` of the given type. */
export function hasAclEntry(smbcaclsOutput, sid, type = "ALLOWED") {
  return aclEntries(smbcaclsOutput).some((entry) => entry.sid === sid && entry.type === type);
}

/** A run of a file share has ended (docs/FILESHARES.md 7.1 run statuses). */
export function runEnded(status) {
  return ["succeeded", "warning", "failed", "cancelled"].includes(status);
}

/** The container start times by service, from `Stack.containers()` plus `docker inspect`. */
export function restartedServices(before, after) {
  return Object.keys(before)
    .filter((service) => after[service] !== undefined && after[service] !== before[service])
    .sort();
}
