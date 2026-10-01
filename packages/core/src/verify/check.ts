/**
 * Read one object back and compare it with its manifest entry.
 *
 * The bytes travel the exact path a restore takes (ChunkReader: chunk index,
 * pack fetch with copy fallback, AES-256-GCM open), so a passing check proves
 * the restore path, not a parallel one. That path re-addresses every chunk:
 * the id sealed into its header and the stored id recomputed from its
 * plaintext must both equal the id the manifest names. That catches a chunk
 * that decrypts fine but is the wrong chunk (a pack index pointing at another
 * sealed blob), and it proves content integrity even for objects whose
 * manifest entry predates whole-object hashes.
 */
import { createHash } from "node:crypto";
import type { ChunkReader } from "../engine/chunkstore.js";
import { buildCause, classifyFailure } from "../failures/classify.js";
import { redactSensitiveText } from "../failures/redact.js";
import type { FailureCause } from "../failures/types.js";
import type { ManifestObject } from "../manifest.js";
import { describeError, isAbortError } from "./errors.js";
import { readEvidence } from "./evidence.js";
import type { SampleCategory } from "./sampling.js";

/**
 * The rated outcome of one read-back (each is evidence, see evidence.ts):
 * - `verified`   every chunk re-addressed, size and whole-object hash match
 * - `mismatch`   the bytes came back but differ from the manifest
 * - `missing`    chunks the manifest names are not in the chunk index, or a
 *                pack no storage target has
 * - `unreadable` stored data that does not decode: a damaged pack, a chunk
 *                that does not decrypt or that its pack does not hold
 */
export type ItemCheckStatus = "verified" | "mismatch" | "missing" | "unreadable";

/**
 * A read-back that failed for a reason that proves nothing about the backup
 * (storage unreachable, timeout, 5xx, throttling, an unknown error). It is not
 * a finding: the check stops and is retried.
 */
export type InconclusiveRead = {
  status: "inconclusive";
  path: string;
  id: string | null;
  reason: string;
  /** Why the read failed (storage unreachable, rate limited, ...), classified. */
  cause: FailureCause;
};

/** Whether the whole-object SHA-256 of the manifest was compared. */
export type ObjectHashCheck = "matched" | "mismatched" | "not_recorded" | "not_reached";

export type ItemCheck = {
  path: string;
  /** Source item id, when the manifest has one. */
  id: string | null;
  category: SampleCategory;
  /** Size the manifest records (bytes). */
  size: number;
  /** Bytes actually read back. */
  bytesRead: number;
  chunks: number;
  status: ItemCheckStatus;
  objectHash: ObjectHashCheck;
  /** Plain-language diagnostic for anything but `verified`. Never contains content. */
  reason: string | null;
  /** The classified cause of anything but `verified` (why, what to do). */
  cause?: FailureCause;
};

function base(
  object: ManifestObject,
  category: SampleCategory,
): Omit<ItemCheck, "status" | "objectHash" | "reason" | "bytesRead"> {
  return {
    path: object.path,
    id: object.id ?? null,
    category,
    size: object.size,
    chunks: object.chunks.length,
  };
}

/**
 * Compare one object's bytes with its manifest entry. A read that failed
 * without evidence comes back as {@link InconclusiveRead}. Only cancellation
 * (and a chunk index that cannot be asked) throws.
 */
export async function checkObject(
  reader: ChunkReader,
  object: ManifestObject,
  category: SampleCategory,
): Promise<ItemCheck | InconclusiveRead> {
  const common = base(object, category);

  const located = await reader.locate(object.chunks);
  const absent = new Set(object.chunks.filter((id) => !located.has(id)));
  if (absent.size > 0) {
    return {
      ...common,
      bytesRead: 0,
      status: "missing",
      objectHash: "not_reached",
      reason: `${absent.size} of ${new Set(object.chunks).size} chunks are not in the chunk index`,
      cause: buildCause("verify.chunk_missing", { count: absent.size }),
    };
  }

  const hash = createHash("sha256");
  let bytesRead = 0;
  try {
    for await (const plaintext of reader.read(object.chunks)) {
      hash.update(plaintext);
      bytesRead += plaintext.length;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    const evidence = readEvidence(error);
    if (evidence === null) {
      return {
        status: "inconclusive",
        path: object.path,
        id: object.id ?? null,
        reason: describeError(error),
        cause: classifyFailure(error, { role: "storage" }),
      };
    }
    return {
      ...common,
      bytesRead,
      status: evidence === "damaged" ? "unreadable" : evidence,
      objectHash: "not_reached",
      reason: describeError(error),
      // A mismatch names itself; damaged data gets the classifier's cause (a key that does
      // not open it, a damaged pack); missing data is missing, from the index or the storage.
      cause:
        evidence === "damaged"
          ? damagedCause(error)
          : evidence === "missing"
            ? buildCause(
                "verify.chunk_missing",
                {},
                { message: redactSensitiveText(describeError(error)) },
              )
            : classifyFailure(error),
    };
  }

  const digest = hash.digest("hex");
  const objectHash: ObjectHashCheck =
    object.sha256 === undefined
      ? "not_recorded"
      : object.sha256 === digest
        ? "matched"
        : "mismatched";

  const problems: string[] = [];
  if (bytesRead !== object.size) {
    problems.push(`size differs (manifest ${object.size} bytes, read ${bytesRead} bytes)`);
  }
  if (objectHash === "mismatched") {
    problems.push("SHA-256 of the object differs from the manifest");
  }
  return {
    ...common,
    bytesRead,
    status: problems.length === 0 ? "verified" : "mismatch",
    objectHash,
    reason: problems.length === 0 ? null : problems.join("; "),
    ...(problems.length === 0 ? {} : { cause: buildCause("verify.hash_mismatch") }),
  };
}

/** Why stored data does not decode: the classified cause (a key), or a damaged pack. */
function damagedCause(error: unknown): FailureCause {
  const cause = classifyFailure(error, { role: "storage" });
  return cause.code.startsWith("crypto.")
    ? cause
    : buildCause("verify.pack_unreadable", {}, cause.technical);
}
