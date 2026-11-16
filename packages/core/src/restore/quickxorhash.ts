/**
 * What a restore computes over the bytes it uploads: the QuickXorHash
 * (graph/quickxorhash.ts) and the SHA-256.
 */
import { createHash } from "node:crypto";
import { QuickXorHash } from "../graph/quickxorhash.js";

export { QuickXorHash, quickXorHash } from "../graph/quickxorhash.js";

/**
 * Everything a restore wants to know about the bytes it sent: their count,
 * their QuickXorHash (to compare with OneDrive's) and their SHA-256 (to
 * compare with the snapshot's). Fed chunk by chunk while the upload streams.
 */
export class UploadDigest {
  private readonly quickXor = new QuickXorHash();
  private readonly sha = createHash("sha256");
  private shaHex: string | null = null;
  private count = 0;

  update(chunk: Uint8Array): void {
    if (this.shaHex !== null) {
      throw new Error("the digest was already read; no more bytes can be added");
    }
    this.quickXor.update(chunk);
    this.sha.update(chunk);
    this.count += chunk.length;
  }

  get bytes(): number {
    return this.count;
  }

  get quickXorHash(): string {
    return this.quickXor.digestBase64();
  }

  /** SHA-256 (hex) of everything so far; reading it ends the digest. */
  get sha256Hex(): string {
    if (this.shaHex === null) {
      this.shaHex = this.sha.digest("hex");
    }
    return this.shaHex;
  }
}
