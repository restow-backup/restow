import { describe, expect, it } from "vitest";
import { ProblemError } from "../../problem.js";
import { assertDeclaredLength, readSegmentBody } from "./body.js";

/** A body delivered in the given chunks; `pulled` counts how many chunks were requested. */
function streamOf(chunks: readonly Uint8Array[]) {
  const state = { pulled: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled];
      if (next === undefined) {
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(next);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

async function problemOf(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a problem");
}

describe("readSegmentBody", () => {
  it("joins the chunks of a body of exactly the expected size", async () => {
    const { stream } = streamOf([Buffer.from("abc"), Buffer.from("defg"), Buffer.from("hij")]);
    const data = await readSegmentBody(stream, 10);
    expect(data.toString()).toBe("abcdefghij");
  });

  it("stops reading as soon as the body grows past the segment", async () => {
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(100, 1));
    const { stream, state } = streamOf(chunks);
    const problem = await problemOf(readSegmentBody(stream, 250));
    expect(problem.status).toBe(413);
    expect(problem.type).toBe("urn:restow:problem:import-segment-too-large");
    // Far fewer chunks than the body holds were ever pulled, and the stream was cancelled.
    expect(state.pulled).toBeLessThan(10);
    expect(state.cancelled).toBe(true);
  });

  it("refuses a short body and an absent one", async () => {
    const { stream } = streamOf([Buffer.from("abc")]);
    const short = await problemOf(readSegmentBody(stream, 10));
    expect(short.status).toBe(422);
    expect(short.type).toBe("urn:restow:problem:import-segment-size-mismatch");
    expect(short.extensions).toMatchObject({ expectedBytes: 10, receivedBytes: 3 });
    expect((await problemOf(readSegmentBody(null, 10))).status).toBe(422);
  });
});

describe("assertDeclaredLength", () => {
  it("passes the exact length and an unknown one", () => {
    expect(() => assertDeclaredLength("10", 10)).not.toThrow();
    expect(() => assertDeclaredLength(undefined, 10)).not.toThrow();
    expect(() => assertDeclaredLength("", 10)).not.toThrow();
    expect(() => assertDeclaredLength("garbage", 10)).not.toThrow();
  });

  it("refuses a larger body before reading it and a smaller one as the wrong size", () => {
    expect(() => assertDeclaredLength("11", 10)).toThrow(ProblemError);
    try {
      assertDeclaredLength("11", 10);
    } catch (error) {
      expect((error as ProblemError).status).toBe(413);
    }
    try {
      assertDeclaredLength("9", 10);
    } catch (error) {
      expect((error as ProblemError).status).toBe(422);
    }
  });
});
