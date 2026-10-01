/**
 * What a failed read during a restore check proves (docs/TESTING.md, restore
 * proof). Red needs evidence that the backup itself is broken; a read that
 * failed for any other reason proves nothing and leaves the check incomplete,
 * to be retried. The same rule rates the restore tests of endpoint backups
 * (@restow/core `isRestoreFinding`, `judgeAgentRestoreTest`).
 *
 * Evidence, classified explicitly:
 *   missing    a chunk the manifest names is not in the chunk index, or a pack
 *              every storage target answered it does not have (a definite
 *              404 / NoSuchKey / missing file, never a timeout)
 *   mismatch   the bytes came back but are not what the snapshot recorded: a
 *              chunk that is not the one its id names, a size or SHA-256 that
 *              differs
 *   damaged    stored bytes that do not decode: a pack or manifest that is
 *              truncated or malformed, a chunk that does not decrypt (AES-GCM
 *              authentication failed) or that its pack does not hold
 *
 * Everything else, a network error, a timeout, a 5xx, throttling, a reset
 * connection, a DNS failure, denied access, a missing bucket and any error not
 * recognised here, is no evidence.
 */
import {
  MissingChunkError,
  ObjectUnreadableError,
  RestoreIntegrityError,
  StoredDataDamagedError,
} from "../engine/chunkstore.js";
import { errorChain } from "../failures/classify.js";
import type { FailureCause } from "../failures/types.js";

export type ReadEvidence = "missing" | "mismatch" | "damaged";

/** The evidence a failed read is, or null when it proves nothing about the backup. */
export function readEvidence(error: unknown): ReadEvidence | null {
  for (const layer of errorChain(error)) {
    if (layer instanceof MissingChunkError) {
      return "missing";
    }
    if (layer instanceof RestoreIntegrityError) {
      return "mismatch";
    }
    if (layer instanceof StoredDataDamagedError) {
      return "damaged";
    }
    if (layer instanceof ObjectUnreadableError) {
      return layer.missing ? "missing" : null;
    }
  }
  return null;
}

/**
 * Whether a failed item of a test restore is evidence: a cause that names why
 * the target refused it for good (a permission, a rejected item). A transient
 * cause (throttling, a network error, a 5xx) or one nobody could classify
 * proves nothing.
 */
export function isTestRestoreEvidence(cause: FailureCause | undefined): boolean {
  return cause !== undefined && cause.code !== "unknown" && !cause.transient;
}
