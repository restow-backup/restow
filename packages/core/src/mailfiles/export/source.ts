/**
 * Opening one message for export: the first chunk is awaited before anything is
 * written anywhere, so a message that cannot be read at all is a failed
 * message and not a half-written archive entry; from then on the bytes are
 * hashed while they stream and checked against the recorded SHA-256 at the end.
 */
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { ExportIntegrityError } from "./errors.js";
import type { ExportScope } from "./scope.js";
import type { ExportMessage } from "./types.js";

/** What was streamed, known once the chunks have been consumed to the end. */
export interface StreamedMessage {
  readonly sha256: string;
  readonly bytes: number;
}

export interface OpenedMessage {
  /** The verified chunks; the last step throws {@link ExportIntegrityError} on a hash mismatch. */
  readonly chunks: AsyncGenerator<Buffer, void, undefined>;
  /** The raw stream behind `chunks`. */
  readonly source: Readable;
  /** Available after `chunks` has completed normally. */
  result(): StreamedMessage;
}

export function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  throw new TypeError("a message stream must yield bytes");
}

/**
 * Open `message` and wait for its first chunk (or its end). Throws whatever the
 * source throws before the first byte; the caller decides whether that is fatal.
 */
export async function openVerified(
  message: ExportMessage,
  scope: ExportScope,
): Promise<OpenedMessage> {
  const source = message.open();
  scope.track(source);
  const iterator = source[Symbol.asyncIterator]() as AsyncIterator<unknown>;
  let first: IteratorResult<unknown>;
  try {
    first = await scope.race(iterator.next());
  } catch (error) {
    source.destroy();
    scope.release(source);
    throw error;
  }
  const expected = message.sha256?.toLowerCase();
  let streamed: StreamedMessage | null = null;

  async function* verified(): AsyncGenerator<Buffer, void, undefined> {
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      let step = first;
      while (!step.done) {
        const chunk = toBuffer(step.value);
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
        step = await iterator.next();
      }
      const sha256 = hash.digest("hex");
      if (expected !== undefined && sha256 !== expected) {
        throw new ExportIntegrityError(
          `SHA-256 mismatch: the message was recorded as ${expected} but its bytes hash to ${sha256}`,
        );
      }
      streamed = { sha256, bytes };
    } finally {
      source.destroy();
    }
  }

  return {
    chunks: verified(),
    source,
    result: () => {
      if (streamed === null) {
        throw new Error("the message has not been streamed to the end");
      }
      return streamed;
    },
  };
}
