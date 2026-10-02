import { describe, expect, it } from "vitest";

import {
  EventStreamParser,
  type ServerEvent,
  type StreamStatus,
  openEventStream,
  reconnectDelay,
} from "@/features/jobs/sse";

describe("EventStreamParser", () => {
  it("dispatches named events with data, id and retry hint", () => {
    const parser = new EventStreamParser();
    const events = parser.push('retry: 3000\nevent: job\nid: j1:t1\ndata: {"id":"j1"}\n\n');
    expect(events).toEqual([{ event: "job", data: '{"id":"j1"}', id: "j1:t1" }]);
    expect(parser.retryMs).toBe(3000);
  });

  it("reassembles events split across chunks, including a CRLF split in the middle", () => {
    const parser = new EventStreamParser();
    expect(parser.push("event: jobs\r")).toEqual([]);
    expect(parser.push('\ndata: {"items":')).toEqual([]);
    expect(parser.push("[]}\r\n\r\n")).toEqual([{ event: "jobs", data: '{"items":[]}', id: null }]);
  });

  it("joins multi-line data, ignores comments and events without data", () => {
    const parser = new EventStreamParser();
    const events = parser.push(": keep-alive\n\nevent: end\n\ndata: a\ndata: b\n\n");
    expect(events).toEqual([{ event: "message", data: "a\nb", id: null }]);
  });

  it("accepts CR-only line endings and fields without a space", () => {
    const parser = new EventStreamParser();
    expect(parser.push("event:job\rdata:x\r\rdata:y\r")).toEqual([
      { event: "job", data: "x", id: null },
    ]);
    // The blank line completing the event arrives on its own; it dispatches at once.
    expect(parser.push("\r")).toEqual([{ event: "message", data: "y", id: null }]);
  });

  it("does not read the LF of a CRLF split across chunks as a second line", () => {
    const parser = new EventStreamParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\n")).toEqual([]);
    expect(parser.push("\r\n")).toEqual([{ event: "message", data: "a", id: null }]);
  });

  it("keeps the last event id across events and ignores malformed retry values", () => {
    const parser = new EventStreamParser();
    parser.push("id: 7\ndata: a\n\nretry: soon\n");
    expect(parser.push("data: b\n\n")).toEqual([{ event: "message", data: "b", id: "7" }]);
    expect(parser.retryMs).toBeNull();
  });
});

describe("reconnectDelay", () => {
  it("follows the server's hint after a normal end", () => {
    expect(reconnectDelay(0, 3000)).toBe(3000);
    expect(reconnectDelay(0, null)).toBe(1000);
    expect(reconnectDelay(0, 10)).toBe(1000);
  });

  it("backs off exponentially after errors, capped at 30 s", () => {
    expect(reconnectDelay(1, null)).toBe(1000);
    expect(reconnectDelay(2, null)).toBe(2000);
    expect(reconnectDelay(3, null)).toBe(4000);
    expect(reconnectDelay(12, null)).toBe(30_000);
    expect(reconnectDelay(1, 3000)).toBe(3000);
  });
});

function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 7));
      controller.enqueue(bytes.slice(7));
      controller.close();
    },
  });
}

/** Resolve once `predicate` holds (the stream runs asynchronously). */
async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
}

describe("openEventStream", () => {
  it("sends the tenant header and cookies and delivers events", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const events: ServerEvent[] = [];
    const statuses: StreamStatus[] = [];
    const handle = openEventStream({
      path: "/jobs/events",
      tenantId: "tenant-1",
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        return new Response(streamOf('event: jobs\ndata: {"items":[]}\n\n'), { status: 200 });
      },
    });
    await until(() => events.length === 1);
    handle.close();

    expect(requests[0]?.url).toBe("/api/v1/jobs/events");
    expect(requests[0]?.init?.credentials).toBe("include");
    const headers = new Headers(requests[0]?.init?.headers);
    expect(headers.get("X-Restow-Tenant")).toBe("tenant-1");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(events[0]).toEqual({ event: "jobs", data: '{"items":[]}', id: null });
    expect(statuses.slice(0, 2)).toEqual(["connecting", "open"]);
  });

  it("reports activity for every chunk, keep-alive comments included", async () => {
    let activity = 0;
    const events: ServerEvent[] = [];
    const handle = openEventStream({
      path: "/live",
      tenantId: "tenant-1",
      onEvent: (event) => events.push(event),
      onActivity: () => activity++,
      fetchImpl: async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
            controller.enqueue(encoder.encode("event: run\ndata: {}\n\n"));
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    await until(() => events.length === 1);
    handle.close();
    // Three chunks arrived; only one of them was an event.
    expect(activity).toBeGreaterThanOrEqual(3);
  });

  it("gives up for good on a response retrying cannot fix", async () => {
    let calls = 0;
    const statuses: StreamStatus[] = [];
    openEventStream({
      path: "/jobs/x/events",
      tenantId: null,
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 404 });
      },
    });
    await until(() => statuses.includes("closed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
  });

  it("reports reconnecting after a failure and stops when closed", async () => {
    let calls = 0;
    const statuses: StreamStatus[] = [];
    const handle = openEventStream({
      path: "/jobs/events",
      tenantId: "tenant-1",
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      fetchImpl: async () => {
        calls++;
        throw new TypeError("network down");
      },
    });
    await until(() => statuses.includes("reconnecting"));
    handle.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    expect(statuses).toEqual(["connecting", "reconnecting"]);
  });
});
