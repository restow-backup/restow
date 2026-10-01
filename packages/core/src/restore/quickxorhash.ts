/**
 * QuickXorHash, the checksum OneDrive for Business reports in
 * `driveItem.file.hashes.quickXorHash`. Computing it while a file is uploaded
 * lets a restore compare its own bytes with what OneDrive stored, without a
 * second download.
 *
 * The algorithm (published by Microsoft): a 160-bit circular register; byte
 * number n of the input is XORed in at bit offset (11 * n) mod 160; finally the
 * little-endian 64-bit input length is XORed into the last 8 bytes. The result
 * is 20 bytes, conventionally shown as base64.
 */
import { createHash } from "node:crypto";

const WIDTH_BITS = 160;
const WIDTH_BYTES = WIDTH_BITS / 8;
const SHIFT = 11;

export class QuickXorHash {
  private readonly state = new Uint8Array(WIDTH_BYTES);
  private bitOffset = 0;
  private length = 0;

  update(data: Uint8Array): this {
    const state = this.state;
    let offset = this.bitOffset;
    for (let i = 0; i < data.length; i++) {
      const byte = data[i] as number;
      const byteIndex = offset >>> 3;
      const bitShift = offset & 7;
      state[byteIndex] ^= (byte << bitShift) & 0xff;
      if (bitShift !== 0) {
        const next = byteIndex + 1 === WIDTH_BYTES ? 0 : byteIndex + 1;
        state[next] ^= byte >>> (8 - bitShift);
      }
      offset += SHIFT;
      if (offset >= WIDTH_BITS) {
        offset -= WIDTH_BITS;
      }
    }
    this.bitOffset = offset;
    this.length += data.length;
    return this;
  }

  /** The 20-byte digest. The hasher stays usable; calling again yields the same value. */
  digest(): Buffer {
    const out = Buffer.from(this.state);
    let length = BigInt(this.length);
    for (let i = 0; i < 8; i++) {
      out[WIDTH_BYTES - 8 + i] ^= Number(length & 0xffn);
      length >>= 8n;
    }
    return out;
  }

  digestBase64(): string {
    return this.digest().toString("base64");
  }
}

export function quickXorHash(data: Uint8Array): string {
  return new QuickXorHash().update(data).digestBase64();
}

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
