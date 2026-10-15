/**
 * What a backup saw change, as far as the ransomware signals need it (docs/RANSOMWARE.md,
 * "The activity report"). Runners compute it from data they have anyway: the endpoint agent and
 * the file share runner from `restic diff` of the previous and the new snapshot (metadata only,
 * no file content is read again), the OneDrive backup from Graph's delta. It is a compact
 * summary, never a file list:
 *
 *   added, modified, removed   file counts against the previous restore point
 *   renamed                    files whose extension changed or got one appended
 *                              (`report.docx` → `report.docx.locked`)
 *   extensions                 the most frequent extensions of added and modified files
 *   names                      the most frequent names of added text and web page files
 *                              (where ransom notes hide), with their counts
 *   entropy                    a handful of measured new or changed files
 *
 * Version 1. Every field is optional on the wire; an older runner sends no report at all, and
 * the signals that need it are then "not available".
 */
import { ENTROPY_SAMPLE_BYTES, type EntropySample } from "./entropy.js";
import { baseNameOf, extensionOf, RANSOM_NOTE_EXTENSIONS } from "./signatures.js";

export const ACTIVITY_REPORT_VERSION = 1;
/** Bounds of a report: what a runner sends at most, and what the server keeps. */
export const ACTIVITY_MAX_EXTENSIONS = 40;
export const ACTIVITY_MAX_NAMES = 40;
export const ACTIVITY_MAX_ENTROPY_SAMPLES = 16;
const MAX_VALUE_LENGTH = 255;
const MAX_PATH_LENGTH = 4096;

export interface ActivityCount {
  value: string;
  count: number;
}

export interface ActivityReport {
  v: number;
  added: number;
  modified: number;
  removed: number;
  renamed: number;
  extensions: ActivityCount[];
  names: ActivityCount[];
  entropy: EntropySample[];
  /** The runner stopped counting renames or names early (a very large change). */
  truncated: boolean;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function bits(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 8)
    : null;
}

function counts(value: unknown, max: number): ActivityCount[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: ActivityCount[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as { value?: unknown; count?: unknown };
    if (typeof raw.value !== "string" || raw.value.length === 0) continue;
    const n = count(raw.count);
    if (n === 0) continue;
    out.push({ value: raw.value.slice(0, MAX_VALUE_LENGTH), count: n });
  }
  return out;
}

function samples(value: unknown): EntropySample[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: EntropySample[] = [];
  for (const entry of value) {
    if (out.length >= ACTIVITY_MAX_ENTROPY_SAMPLES) break;
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const head = bits(raw.head);
    if (typeof raw.path !== "string" || head === null) continue;
    out.push({
      path: raw.path.slice(0, MAX_PATH_LENGTH),
      ext:
        typeof raw.ext === "string"
          ? raw.ext.replace(/^\.+/, "").toLowerCase().slice(0, 32)
          : extensionOf(raw.path),
      size: count(raw.size),
      head,
      tail: bits(raw.tail),
    });
  }
  return out;
}

/**
 * A report as a runner sent it, checked and bounded; null when there is none or it is not one
 * this server understands (a newer major version is read as far as its fields are known).
 */
export function parseActivityReport(value: unknown): ActivityReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const v = count(raw.v);
  if (v < 1) {
    return null;
  }
  return {
    v,
    added: count(raw.added),
    modified: count(raw.modified),
    removed: count(raw.removed),
    renamed: count(raw.renamed),
    extensions: counts(raw.extensions, ACTIVITY_MAX_EXTENSIONS),
    names: counts(raw.names, ACTIVITY_MAX_NAMES),
    entropy: samples(raw.entropy),
    truncated: raw.truncated === true,
  };
}

const NOTE_EXTENSIONS = new Set(RANSOM_NOTE_EXTENSIONS);

function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

/**
 * Whether a rename changed the extension: `a.docx` → `a.docx.locked` (appended) or
 * `a.docx` → `a.crypt` (replaced). A move or a renamed stem with the same extension is not one.
 */
export function isExtensionRename(before: string, after: string): boolean {
  const old = baseNameOf(before);
  const next = baseNameOf(after);
  if (old === next) {
    return false;
  }
  if (next.startsWith(`${old}.`) && next.length > old.length + 1) {
    return true;
  }
  return extensionOf(old) !== extensionOf(next) && stemOf(old) === stemOf(next);
}

/** The top `max` entries of a counter map, most frequent first, ties by value. */
function top(map: Map<string, number>, max: number): ActivityCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([value, n]) => ({ value, count: n }));
}

/** Files at most this many: the OneDrive backup samples the first ones it downloads. */
export const ACTIVITY_ENTROPY_SAMPLES = 8;

/**
 * Builds a report from single changes (the OneDrive backup's; the Go runners have their own
 * implementation of the same rules in agent/internal/activity).
 */
export class ActivityCollector {
  private added = 0;
  private modified = 0;
  private removed = 0;
  private renamed = 0;
  private readonly extensions = new Map<string, number>();
  private readonly names = new Map<string, number>();
  private readonly entropy: EntropySample[] = [];

  private countName(path: string, isNew: boolean): void {
    const ext = extensionOf(path);
    if (ext) {
      this.extensions.set(ext, (this.extensions.get(ext) ?? 0) + 1);
    }
    if (isNew && NOTE_EXTENSIONS.has(ext)) {
      const name = baseNameOf(path).slice(0, MAX_VALUE_LENGTH);
      this.names.set(name, (this.names.get(name) ?? 0) + 1);
    }
  }

  /** A file that was not in the previous restore point. */
  fileAdded(path: string): void {
    this.added++;
    this.countName(path, true);
  }

  /** A file whose content changed; `previousPath` when it was renamed or moved, too. */
  fileModified(path: string, previousPath?: string): void {
    this.modified++;
    if (previousPath !== undefined && isExtensionRename(previousPath, path)) {
      this.renamed++;
      // A new name: a ransom note copied over an existing file counts as one, too.
      this.countName(path, true);
      return;
    }
    this.countName(path, false);
  }

  /** A file renamed or moved without a change of content. */
  fileRenamed(previousPath: string, path: string): void {
    if (isExtensionRename(previousPath, path)) {
      this.renamed++;
      this.countName(path, true);
    }
  }

  filesRemoved(n: number): void {
    this.removed += Math.max(0, Math.floor(n));
  }

  /** Whether another entropy sample is wanted. */
  wantsEntropy(): boolean {
    return this.entropy.length < ACTIVITY_ENTROPY_SAMPLES;
  }

  addEntropy(sample: EntropySample): void {
    if (this.wantsEntropy()) {
      this.entropy.push(sample);
    }
  }

  report(): ActivityReport {
    return {
      v: ACTIVITY_REPORT_VERSION,
      added: this.added,
      modified: this.modified,
      removed: this.removed,
      renamed: this.renamed,
      extensions: top(this.extensions, ACTIVITY_MAX_EXTENSIONS),
      names: top(this.names, ACTIVITY_MAX_NAMES),
      entropy: [...this.entropy],
      truncated: false,
    };
  }
}

/**
 * Keeps the first and the last {@link ENTROPY_SAMPLE_BYTES} of a stream that passes through
 * (the OneDrive download): `push` every chunk, then `windows()`.
 */
export class EntropyWindows {
  private head: Buffer[] = [];
  private headLength = 0;
  private tail: Buffer = Buffer.alloc(0);
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headLength < ENTROPY_SAMPLE_BYTES) {
      const take = chunk.subarray(0, ENTROPY_SAMPLE_BYTES - this.headLength);
      this.head.push(take);
      this.headLength += take.length;
    }
    const joined = this.tail.length === 0 ? chunk : Buffer.concat([this.tail, chunk]);
    this.tail = Buffer.from(joined.subarray(Math.max(0, joined.length - ENTROPY_SAMPLE_BYTES)));
  }

  get size(): number {
    return this.total;
  }

  windows(): { head: Uint8Array; tail: Uint8Array | null } {
    return {
      head: Buffer.concat(this.head),
      tail: this.total > ENTROPY_SAMPLE_BYTES ? this.tail : null,
    };
  }
}
