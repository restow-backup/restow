import { ProblemError } from "../../problem.js";

/**
 * Reading one upload segment from a request body with a hard size cap
 * (docs/IMPORT.md): the body is consumed chunk by chunk and the read stops the
 * moment it exceeds what the segment may have, so a client cannot make the API
 * hold more than one segment (and never more than the expected size) in memory.
 */

export const SEGMENT_TOO_LARGE_PROBLEM = "urn:restow:problem:import-segment-too-large";
export const SEGMENT_SIZE_MISMATCH_PROBLEM = "urn:restow:problem:import-segment-size-mismatch";

function tooLarge(expected: number): ProblemError {
  return new ProblemError(413, "Segment too large", {
    type: SEGMENT_TOO_LARGE_PROBLEM,
    detail: `This segment must be exactly ${expected} bytes.`,
    extensions: { expectedBytes: expected },
  });
}

function sizeMismatch(expected: number, received: number | null): ProblemError {
  return new ProblemError(422, "Segment has the wrong size", {
    type: SEGMENT_SIZE_MISMATCH_PROBLEM,
    detail: `This segment must be exactly ${expected} bytes${received === null ? "" : `, but ${received} arrived`}.`,
    extensions: {
      expectedBytes: expected,
      ...(received === null ? {} : { receivedBytes: received }),
    },
  });
}

/**
 * Check the declared `Content-Length` before any byte is read: a body larger
 * than the segment is refused outright (413), a smaller one cannot be right (422).
 * A missing or unparseable header passes; the read itself enforces the cap.
 */
export function assertDeclaredLength(header: string | undefined, expected: number): void {
  if (header === undefined || header.trim() === "") {
    return;
  }
  const declared = Number(header.trim());
  if (!Number.isInteger(declared) || declared < 0) {
    return;
  }
  if (declared > expected) {
    throw tooLarge(expected);
  }
  if (declared < expected) {
    throw sizeMismatch(expected, declared);
  }
}

/**
 * The whole body, which must be exactly `expected` bytes. Stops reading (and
 * cancels the stream) as soon as more than `expected` bytes arrived.
 */
export async function readSegmentBody(
  body: ReadableStream<Uint8Array> | null,
  expected: number,
): Promise<Buffer> {
  if (body === null) {
    throw sizeMismatch(expected, 0);
  }
  const reader = body.getReader();
  const parts: Buffer[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > expected) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge(expected);
      }
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock();
  }
  if (received !== expected) {
    throw sizeMismatch(expected, received);
  }
  return parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, received);
}
