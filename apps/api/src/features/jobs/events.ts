/**
 * Server-sent events for jobs: what goes over the wire and when.
 *
 * The stream polls the tenant's job rows (the worker batches `job_progress`
 * writes every couple of seconds, so a poll of the same order loses nothing)
 * and sends a job only when something about it changed. Everything here is
 * pure so the shaping, the change detection and the stream lifecycle are
 * tested without a database or a socket.
 *
 * Events:
 *   `jobs`  the full set of live jobs, sent first on the tenant-wide stream
 *   `job`   one job whose state changed (JobDto)
 *   `end`   the watched job reached a terminal state; the stream closes
 *   `error` the stream could not read the jobs; the client reconnects
 * A comment line (`: keep-alive`) goes out when nothing else did for a while,
 * so proxies keep the connection open.
 */
import type { JobDto } from "./dto.js";

/** How often the stream re-reads the jobs. */
export const POLL_INTERVAL_MS = 2000;
/** Longest silence before a keep-alive comment. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/**
 * A stream ends after this long and the client reconnects (the `retry` hint
 * below), which re-checks the session and bounds how long a request lives.
 */
export const MAX_STREAM_MS = 5 * 60_000;
/** Reconnect delay the browser uses after the stream ends. */
export const RECONNECT_MS = 3000;
/** The tenant-wide stream starts with jobs that ran or changed this recently. */
export const LIVE_LOOKBACK_MS = 60_000;

/**
 * `snapshot`, `run`, `definition`, `machine` and `gone` belong to the live channel
 * (features/history/live.ts), which reuses this loop and these helpers.
 */
export type JobEventName =
  | "jobs"
  | "job"
  | "end"
  | "error"
  | "snapshot"
  | "run"
  | "definition"
  | "machine"
  | "gone";

/** One SSE message (the shape Hono's `writeSSE` takes). */
export interface SseMessage {
  readonly event: JobEventName;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

/** The initial snapshot of the tenant-wide stream. */
export function jobsMessage(jobs: readonly JobDto[]): SseMessage {
  return { event: "jobs", data: JSON.stringify({ items: jobs }), retry: RECONNECT_MS };
}

/** A changed job. The event id lets a reconnecting browser tell where it was. */
export function jobMessage(job: JobDto): SseMessage {
  return { event: "job", data: JSON.stringify(job), id: `${job.id}:${job.updatedAt}` };
}

/** The watched job is finished (or gone); `job` is its final state, null when deleted. */
export function endMessage(jobId: string, job: JobDto | null): SseMessage {
  return {
    event: "end",
    data: JSON.stringify({ id: jobId, status: job?.status ?? null }),
  };
}

/** A read failed; the detail stays generic, the log has the cause. */
export function errorMessage(): SseMessage {
  return {
    event: "error",
    data: JSON.stringify({ title: "Job updates unavailable", retryInMs: RECONNECT_MS }),
    retry: RECONNECT_MS,
  };
}

/** Everything a client can see of a job, as one comparable string. */
export function fingerprint(job: JobDto): string {
  return JSON.stringify(job);
}

/**
 * Remembers what each job looked like when it was last sent and reports only
 * the jobs that changed since. Jobs that dropped out of the window are
 * forgotten, so the memory stays bounded by the window size.
 */
export class JobChangeTracker {
  private readonly seen = new Map<string, string>();

  /** Record `jobs` as sent without reporting them (after an initial snapshot). */
  prime(jobs: readonly JobDto[]): void {
    this.seen.clear();
    for (const job of jobs) {
      this.seen.set(job.id, fingerprint(job));
    }
  }

  /** The jobs of `current` that are new or differ from what was last sent. */
  changes(current: readonly JobDto[]): JobDto[] {
    const changed: JobDto[] = [];
    const present = new Set<string>();
    for (const job of current) {
      present.add(job.id);
      const print = fingerprint(job);
      if (this.seen.get(job.id) !== print) {
        this.seen.set(job.id, print);
        changed.push(job);
      }
    }
    for (const id of [...this.seen.keys()]) {
      if (!present.has(id)) {
        this.seen.delete(id);
      }
    }
    return changed;
  }
}

/** What the single-job stream sends after one poll, and whether it is done. */
export function singleJobStep(
  tracker: JobChangeTracker,
  jobId: string,
  job: JobDto | null,
): { messages: SseMessage[]; done: boolean } {
  if (job === null) {
    return { messages: [endMessage(jobId, null)], done: true };
  }
  const messages = tracker.changes([job]).map(jobMessage);
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return { messages: [...messages, endMessage(jobId, job)], done: true };
  }
  return { messages, done: false };
}

/** Whether a keep-alive is due, given when the last line went out. */
export function heartbeatDue(lastWriteAt: number, now: number): boolean {
  return now - lastWriteAt >= HEARTBEAT_INTERVAL_MS;
}

/**
 * The lower bound of the tenant-wide stream's window. It is fixed when the
 * stream opens, so a job that finishes while the stream runs stays in the
 * window and its final state is sent.
 */
export function windowStart(now: Date, lookbackMs: number = LIVE_LOOKBACK_MS): Date {
  return new Date(now.getTime() - lookbackMs);
}

/** One poll of a stream: what to send, and whether the stream is finished. */
export interface StreamStep {
  readonly messages: readonly SseMessage[];
  readonly done: boolean;
}

/** The transport a stream loop writes to (Hono's SSE stream in production). */
export interface StreamIo {
  write(message: SseMessage): Promise<void>;
  /** Send a comment line that keeps proxies from closing an idle connection. */
  heartbeat(): Promise<void>;
  /** Wait between polls; resolves early once the client is gone. */
  sleep(ms: number): Promise<void>;
  /** True once the client disconnected. */
  gone(): boolean;
  now(): number;
}

export interface StreamLoopOptions {
  readonly pollMs?: number;
  readonly maxMs?: number;
}

/**
 * Poll, send what changed, keep the connection alive, and stop when the step
 * says so, the client leaves, or the stream reached its lifetime. A failing
 * step ends the loop with an `error` event (the client reconnects); the error
 * itself is rethrown for the caller to log.
 */
export async function runStreamLoop(
  io: StreamIo,
  step: () => Promise<StreamStep>,
  options: StreamLoopOptions = {},
): Promise<void> {
  const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
  const maxMs = options.maxMs ?? MAX_STREAM_MS;
  const startedAt = io.now();
  let lastWriteAt = startedAt;
  while (!io.gone() && io.now() - startedAt < maxMs) {
    let result: StreamStep;
    try {
      result = await step();
    } catch (error) {
      if (!io.gone()) {
        await io.write(errorMessage());
      }
      throw error;
    }
    for (const message of result.messages) {
      await io.write(message);
      lastWriteAt = io.now();
    }
    if (result.done) {
      return;
    }
    if (heartbeatDue(lastWriteAt, io.now())) {
      await io.heartbeat();
      lastWriteAt = io.now();
    }
    await io.sleep(pollMs);
  }
}
