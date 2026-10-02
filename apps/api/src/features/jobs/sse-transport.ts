import { safeErrorMessage } from "@restow/db";
import type { Context, Env } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { type StreamIo, type StreamStep, runStreamLoop } from "./events.js";

/**
 * The server-sent-events transport of the job streams (the tenant-wide `jobs/events`, the single
 * job's, and the live channel): Hono's stream adapted to the loop in ./events.ts. Kept apart
 * from that file so the loop and the shaping stay free of any framework and testable without a socket.
 */

/** A sleep that ends early once `signal` fires (the client disconnected). */
export function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Adapt Hono's SSE stream to the loop's transport. */
export function sseIo(stream: SSEStreamingApi): StreamIo {
  const disconnected = new AbortController();
  stream.onAbort(() => disconnected.abort());
  return {
    write: (message) => stream.writeSSE({ ...message }),
    heartbeat: async () => {
      await stream.write(": keep-alive\n\n");
    },
    sleep: (ms) => sleepUnless(ms, disconnected.signal),
    gone: () => stream.aborted || stream.closed,
    now: () => Date.now(),
  };
}

/**
 * Run a stream; a failed read is logged here (the client already got an `error` event). `name`
 * says which stream failed in the log line.
 */
export function streamEvents<E extends Env>(
  c: Context<E>,
  step: () => Promise<StreamStep>,
  context: Record<string, unknown>,
  name = "job event stream failed",
) {
  // Tell reverse proxies (nginx, some Caddy setups) not to buffer the stream.
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    try {
      await runStreamLoop(sseIo(stream), step);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: name,
          ...context,
          // Never the failed query with its bound parameters.
          errorMessage: safeErrorMessage(error),
        }),
      );
    }
  });
}
