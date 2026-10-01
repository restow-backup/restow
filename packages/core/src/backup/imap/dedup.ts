/**
 * Message-level deduplication by Message-ID plus content hash (docs/IMAP.md).
 *
 * A folder that has to be read again from scratch (UIDVALIDITY changed, a full
 * run was requested, a folder was renamed, a message was moved) mostly
 * delivers messages the store already holds under another UID. When a
 * delivered message carries the same Message-ID and the same SHA-256 as a
 * message stored before, it reuses that message's chunk list: no chunking, no
 * sealing, no chunk index round trips. The chunk store would deduplicate the
 * bytes anyway; this layer makes the common case free and keeps the identity
 * check explicit.
 *
 * The Message-ID alone is never trusted (clients reuse it, servers rewrite
 * headers); it only narrows the candidates, the hash decides. Hashing happens
 * only when a candidate of the same size exists, so a message nobody has seen
 * costs nothing extra. Messages without a Message-ID still dedupe at chunk
 * level.
 */
import { createHash } from "node:crypto";
import type { ManifestObject } from "../../manifest.js";
import { META, isMessageObject } from "./paths.js";

/** What identifies stored message bytes: enough to rebuild a manifest object. */
export interface StoredContent {
  readonly size: number;
  /** SHA-256 (hex) over the complete message. */
  readonly sha256: string;
  /** Ordered stored chunk ids (hex). */
  readonly chunks: readonly string[];
}

export class MessageDedupIndex {
  private readonly byMessageId = new Map<string, StoredContent[]>();

  /** Index every IMAP message object that recorded a Message-ID and a hash. */
  static fromObjects(objects: Iterable<ManifestObject>): MessageDedupIndex {
    const index = new MessageDedupIndex();
    for (const object of objects) {
      if (!isMessageObject(object) || object.sha256 === undefined) {
        continue;
      }
      index.remember(object.metadata?.[META.messageId] ?? null, {
        size: object.size,
        sha256: object.sha256,
        chunks: object.chunks,
      });
    }
    return index;
  }

  /** Number of distinct Message-IDs held. */
  get size(): number {
    return this.byMessageId.size;
  }

  /** Make stored bytes available for later matches. Without a Message-ID there is nothing to key on. */
  remember(messageId: string | null, content: StoredContent): void {
    if (!messageId) {
      return;
    }
    const candidates = this.byMessageId.get(messageId);
    if (!candidates) {
      this.byMessageId.set(messageId, [content]);
      return;
    }
    if (!candidates.some((known) => known.sha256 === content.sha256)) {
      candidates.push(content);
    }
  }

  /** The stored copy of `source`, when a message with the same Message-ID and identical bytes is known. */
  find(messageId: string | null, source: Buffer): StoredContent | null {
    if (!messageId) {
      return null;
    }
    const sameSize = this.byMessageId
      .get(messageId)
      ?.filter((candidate) => candidate.size === source.length);
    if (!sameSize || sameSize.length === 0) {
      return null;
    }
    const sha256 = createHash("sha256").update(source).digest("hex");
    return sameSize.find((candidate) => candidate.sha256 === sha256) ?? null;
  }
}
