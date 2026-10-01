import { TENANT_HEADER } from "@/lib/api";

/**
 * Server-sent events over `fetch`.
 *
 * The browser's EventSource cannot send headers, but every tenant-scoped
 * request names its tenant in `X-Restow-Tenant`. Reading the stream through
 * `fetch` keeps that contract (and the session cookie) without putting the
 * tenant into the URL. The parser follows the WHATWG event-stream format;
 * the client reconnects on its own and reports its state, so the UI can say
 * honestly whether it is live.
 */

/** Same base as `apiFetch` (lib/api.ts): `VITE_API_URL` or `/api/v1`. */
const API_BASE_URL = ((import.meta.env.VITE_API_URL as string | undefined) ?? "/api/v1").replace(
  /\/+$/,
  "",
);

export interface ServerEvent {
  readonly event: string;
  readonly data: string;
  readonly id: string | null;
}

/** Incremental event-stream parser: feed text as it arrives, get complete events back. */
export class EventStreamParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private lastEventId: string | null = null;
  /** The previous chunk ended in CR: an LF starting this one completes that CRLF. */
  private skipLeadingLf = false;
  /** The server's latest `retry:` hint in milliseconds, if any. */
  retryMs: number | null = null;

  push(text: string): ServerEvent[] {
    const chunk = this.skipLeadingLf && text.startsWith("\n") ? text.slice(1) : text;
    this.skipLeadingLf = false;
    this.buffer += chunk;
    const events: ServerEvent[] = [];
    let lineStart = 0;
    for (let index = 0; index < this.buffer.length; index++) {
      const char = this.buffer[index];
      if (char !== "\n" && char !== "\r") {
        continue;
      }
      const line = this.buffer.slice(lineStart, index);
      if (char === "\r") {
        if (index === this.buffer.length - 1) {
          this.skipLeadingLf = true;
        } else if (this.buffer[index + 1] === "\n") {
          index++;
        }
      }
      lineStart = index + 1;
      const event = this.processLine(line);
      if (event) {
        events.push(event);
      }
    }
    this.buffer = this.buffer.slice(lineStart);
    return events;
  }

  private processLine(line: string): ServerEvent | null {
    if (line === "") {
      return this.dispatch();
    }
    if (line.startsWith(":")) {
      return null;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\0")) {
          this.lastEventId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          this.retryMs = Number(value);
        }
        break;
      default:
        break;
    }
    return null;
  }

  private dispatch(): ServerEvent | null {
    const name = this.eventName;
    const data = this.dataLines;
    this.eventName = "";
    this.dataLines = [];
    if (data.length === 0) {
      return null;
    }
    return { event: name || "message", data: data.join("\n"), id: this.lastEventId };
  }
}

export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Responses a reconnect cannot fix: signed out, not allowed, or gone. */
const FATAL_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 422]);

const MIN_RETRY_MS = 1000;
const MAX_RETRY_MS = 30_000;

/** Delay before the next attempt: the server's hint after a normal end, backoff after errors. */
export function reconnectDelay(consecutiveErrors: number, retryHintMs: number | null): number {
  if (consecutiveErrors === 0) {
    return Math.max(MIN_RETRY_MS, retryHintMs ?? MIN_RETRY_MS);
  }
  const backoff = MIN_RETRY_MS * 2 ** Math.min(consecutiveErrors - 1, 10);
  return Math.min(MAX_RETRY_MS, Math.max(backoff, retryHintMs ?? 0));
}

export interface EventStreamOptions {
  /** Path below the API base, e.g. `/jobs/events`. */
  readonly path: string;
  readonly tenantId: string | null;
  readonly onEvent: (event: ServerEvent) => void;
  readonly onStatus?: (status: StreamStatus) => void;
  /** Injectable for tests. */
  readonly fetchImpl?: typeof fetch;
}

export interface EventStreamHandle {
  close(): void;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Open a stream and keep it open until `close()`: a stream the server ends
 * (it recycles them every few minutes) is reopened after the server's retry
 * hint, a failed one with exponential backoff. A response that cannot get
 * better by retrying (401, 403, 404) ends it for good with status `closed`.
 */
export function openEventStream(options: EventStreamOptions): EventStreamHandle {
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  let status: StreamStatus | null = null;
  const report = (next: StreamStatus) => {
    if (next !== status) {
      status = next;
      options.onStatus?.(next);
    }
  };

  const run = async () => {
    const parser = new EventStreamParser();
    let errors = 0;
    report("connecting");
    while (!controller.signal.aborted) {
      let failed = false;
      try {
        const headers = new Headers({ accept: "text/event-stream" });
        if (options.tenantId) {
          headers.set(TENANT_HEADER, options.tenantId);
        }
        const response = await fetchImpl(`${API_BASE_URL}${options.path}`, {
          credentials: "include",
          headers,
          signal: controller.signal,
        });
        if (FATAL_STATUSES.has(response.status)) {
          report("closed");
          return;
        }
        if (!response.ok || !response.body) {
          throw new Error(`event stream answered ${response.status}`);
        }
        errors = 0;
        report("open");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          for (const event of parser.push(decoder.decode(value, { stream: true }))) {
            if (event.event === "error") {
              failed = true;
            }
            options.onEvent(event);
          }
        }
      } catch {
        if (controller.signal.aborted) {
          return;
        }
        failed = true;
      }
      if (failed) {
        errors++;
        report("reconnecting");
      }
      await wait(reconnectDelay(errors, parser.retryMs), controller.signal);
    }
  };
  void run();

  return {
    // The caller knows it closed the stream; `closed` is reported only when the stream gave up.
    close() {
      controller.abort();
    },
  };
}
