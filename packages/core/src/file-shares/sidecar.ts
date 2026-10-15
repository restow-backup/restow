import { createInterface } from "node:readline";
import { Readable } from "node:stream";
/**
 * Reader of the permissions sidecar a file share restore point carries
 * (`/.restow/acls.jsonl.gz`, docs/FILESHARES.md 4.6), the TypeScript side of
 * agent/internal/share/sidecar.go. The server reads it to say "permissions saved" for a restore
 * point and to leave `/.restow` out of browsing and ZIPs; the two readers share the golden file
 * agent/internal/share/testdata/sidecar/v1-basic.jsonl.
 *
 * Rules: gzip of JSON Lines, every line an object with a type `t`; a reader accepts `v` 1,
 * ignores unknown `t` values and unknown fields, and for a higher `v` reads nothing but the
 * header (`newerVersion`). A sidecar without its trailer (`z`) is incomplete.
 */
import { createGunzip } from "node:zlib";

export const SIDECAR_FORMAT = "restow-share-permissions";
export const SIDECAR_VERSION = 1;

export interface SidecarHeader {
  format: string;
  v: number;
  protocol: "smb" | "nfs" | string;
  /** Which xattr the descriptors hold (`system.cifs_ntsd_full`, ..., `none`). */
  xattr: string;
  created: string;
  runner: string;
  reused: number;
}

export interface SidecarEntry {
  /** Relative to the share root; `""` for the root. Null when the raw bytes are not UTF-8. */
  path: string | null;
  /** The raw path bytes (base64) of a name that is not valid UTF-8. */
  pathBytes: string | null;
  descriptorId: string | null;
  dosAttributes: number | null;
  creationTime: string | null;
}

export interface SidecarSummary {
  header: SidecarHeader | null;
  entries: number;
  descriptors: number;
  errors: number;
  /** The trailer was there: the sidecar is complete. */
  complete: boolean;
  /** The trailer's own counts, when present. */
  trailer: { entries: number; descriptors: number; errors: number } | null;
  /** The sidecar has a newer format than this reader knows; nothing but the header was read. */
  newerVersion: boolean;
}

export interface SidecarReadOptions {
  /** Called for each entry (`e` line), in order. */
  onEntry?(entry: SidecarEntry): void;
  /** Called for each unreadable path (`x` line). */
  onError?(path: string | null, errno: string): void;
}

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** Read the sidecar from its JSON lines (already decompressed). */
export async function readSidecarLines(
  lines: AsyncIterable<string> | Iterable<string>,
  options: SidecarReadOptions = {},
): Promise<SidecarSummary> {
  const summary: SidecarSummary = {
    header: null,
    entries: 0,
    descriptors: 0,
    errors: 0,
    complete: false,
    trailer: null,
    newerVersion: false,
  };
  let first = true;
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new Error("the permissions sidecar has a line that is not JSON");
    }
    if (first) {
      first = false;
      if (record.t !== "h" || record.format !== SIDECAR_FORMAT) {
        throw new Error("the permissions sidecar has no header");
      }
      summary.header = {
        format: SIDECAR_FORMAT,
        v: num(record.v),
        protocol: str(record.protocol) ?? "",
        xattr: str(record.xattr) ?? "",
        created: str(record.created) ?? "",
        runner: str(record.runner) ?? "",
        reused: num(record.reused),
      };
      if (summary.header.v > SIDECAR_VERSION) {
        summary.newerVersion = true;
        return summary;
      }
      continue;
    }
    switch (record.t) {
      case "d":
        summary.descriptors++;
        break;
      case "e": {
        summary.entries++;
        options.onEntry?.({
          path: str(record.p),
          pathBytes: str(record.pb),
          descriptorId: str(record.d),
          dosAttributes: typeof record.a === "number" ? record.a : null,
          creationTime: str(record.c),
        });
        break;
      }
      case "x":
        summary.errors++;
        options.onError?.(str(record.p), str(record.err) ?? "");
        break;
      case "z":
        summary.complete = true;
        summary.trailer = {
          entries: num(record.entries),
          descriptors: num(record.descriptors),
          errors: num(record.errors),
        };
        break;
      default:
        // Unknown types are forward compatible additions.
        break;
    }
  }
  if (first) {
    throw new Error("the permissions sidecar is empty");
  }
  return summary;
}

/** Read a gzip-compressed sidecar (as `restic dump` streams it). */
export async function readSidecar(
  input: Readable | Buffer,
  options: SidecarReadOptions = {},
): Promise<SidecarSummary> {
  const source = Buffer.isBuffer(input) ? Readable.from([input]) : input;
  const gunzip = createGunzip();
  source.on("error", (error) => gunzip.destroy(error));
  const lines = createInterface({
    input: source.pipe(gunzip),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  return readSidecarLines(lines, options);
}
