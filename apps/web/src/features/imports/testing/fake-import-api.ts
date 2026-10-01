import { createHash } from "node:crypto";

import type { ImportUploadDto, MailFileFormat, UploadRefusal } from "../types";

/**
 * An in-memory `/api/v1/imports/uploads` for tests: a `fetch` replacement that
 * stores segments, verifies `X-Segment-Sha256`, detects the format from the
 * first bytes on `complete` and can be told to fail. It is the only fake the
 * upload tests need, so the engine, the transport and the panel are exercised
 * against the same behaviour.
 */

export const TEST_SEGMENT_SIZE = 8;

export interface FakeCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  bytes: number;
}

export interface FakeFailure {
  /** Matched against `METHOD path` (for example `PUT /imports/uploads/u1/segments/2`). */
  match: RegExp;
  /** How many matching requests fail; default 1. */
  times?: number;
  /** HTTP status to answer with, or `"network"` to reject like a lost connection. */
  respond: number | "network";
  problemType?: string;
  extensions?: Record<string, unknown>;
}

interface StoredUpload {
  dto: ImportUploadDto;
  segments: Map<number, Uint8Array>;
}

export interface FakeImportApiOptions {
  segmentSize?: number;
  maxFileBytes?: number;
  /** Uploads that exist before the test starts. */
  uploads?: ImportUploadDto[];
}

function detectFormat(head: Uint8Array): MailFileFormat {
  const text = new TextDecoder("latin1").decode(head.slice(0, 64));
  if (text.startsWith("!BDN")) return "pst";
  if (text.startsWith("PK")) return "zip";
  if (text.startsWith("From ")) return "mbox";
  if (/^[A-Za-z-]+: /.test(text)) return "eml";
  return "unknown";
}

function refusalFor(format: MailFileFormat): UploadRefusal | null {
  if (format === "pst") {
    return {
      code: "pst_not_supported",
      message:
        "PST and OST import is planned for a later release. Export the mailbox from Outlook as .msg or .eml files (or convert it to MBOX) and import those.",
    };
  }
  if (format === "unknown") {
    return { code: "unrecognised", message: "This file is not a supported mail file." };
  }
  return null;
}

export function createFakeImportApi(options: FakeImportApiOptions = {}) {
  const segmentSize = options.segmentSize ?? TEST_SEGMENT_SIZE;
  const uploads = new Map<string, StoredUpload>();
  for (const dto of options.uploads ?? []) {
    uploads.set(dto.id, { dto: { ...dto }, segments: new Map() });
  }
  const calls: FakeCall[] = [];
  const failures: Array<FakeFailure & { left: number }> = [];
  let counter = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const problem = (status: number, type: string, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ type, title: type, status, ...extra }), {
      status,
      headers: { "content-type": "application/problem+json" },
    });

  function toDto(stored: StoredUpload): ImportUploadDto {
    return { ...stored.dto, receivedSegments: [...stored.segments.keys()].sort((a, b) => a - b) };
  }

  async function handle(method: string, path: string, init: RequestInit): Promise<Response> {
    if (method === "GET" && path === "/imports/uploads") {
      return json({
        items: [...uploads.values()]
          .filter((stored) => ["uploading", "ready"].includes(stored.dto.status))
          .map(toDto),
      });
    }
    if (method === "POST" && path === "/imports/uploads") {
      const input = JSON.parse(String(init.body)) as { fileName: string; size: number };
      if (options.maxFileBytes !== undefined && input.size > options.maxFileBytes) {
        return problem(413, "urn:restow:problem:import-file-too-large");
      }
      if (!(input.size > 0)) {
        return problem(422, "urn:restow:problem:validation");
      }
      counter += 1;
      const dto: ImportUploadDto = {
        id: `u${counter}`,
        fileName: input.fileName,
        size: input.size,
        segmentSize,
        segmentCount: Math.ceil(input.size / segmentSize),
        status: "uploading",
        receivedSegments: [],
        detectedFormat: null,
        refusal: null,
        expiresAt: "2026-10-02T10:00:00.000Z",
      };
      uploads.set(dto.id, { dto, segments: new Map() });
      return json(dto, 201);
    }
    const segment = /^\/imports\/uploads\/([^/]+)\/segments\/(\d+)$/.exec(path);
    const one = /^\/imports\/uploads\/([^/]+)(\/complete)?$/.exec(path);
    const stored = uploads.get(decodeURIComponent((segment ?? one)?.[1] ?? ""));
    if (!stored) {
      return problem(404, "urn:restow:problem:not-found");
    }
    if (segment && method === "PUT") {
      if (stored.dto.status !== "uploading") {
        return problem(409, "urn:restow:problem:import-upload-not-open");
      }
      const index = Number(segment[2]);
      const bytes = new Uint8Array(await (init.body as Blob).arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      const claimed = (init.headers as Headers).get("x-segment-sha256");
      if (claimed && claimed !== digest) {
        return problem(422, "urn:restow:problem:import-segment-corrupt");
      }
      stored.segments.set(index, bytes);
      return json({
        index,
        size: bytes.length,
        sha256: digest,
        receivedCount: stored.segments.size,
      });
    }
    if (one?.[2] && method === "POST") {
      const missing = Array.from({ length: stored.dto.segmentCount }, (_, index) => index).filter(
        (index) => !stored.segments.has(index),
      );
      if (missing.length > 0) {
        return problem(409, "urn:restow:problem:import-upload-incomplete", { missing });
      }
      const head = new Uint8Array(
        [...stored.segments.entries()]
          .sort(([a], [b]) => a - b)
          .flatMap(([, bytes]) => [...bytes])
          .slice(0, 64),
      );
      const format = detectFormat(head);
      stored.dto = {
        ...stored.dto,
        status: "ready",
        detectedFormat: format,
        refusal: refusalFor(format),
      };
      return json(toDto(stored));
    }
    if (one && !one[2] && method === "GET") {
      return json(toDto(stored));
    }
    if (one && !one[2] && method === "DELETE") {
      stored.dto = { ...stored.dto, status: "cancelled" };
      stored.segments.clear();
      return json(null, 204);
    }
    return problem(405, "urn:restow:problem:method-not-allowed");
  }

  const fakeFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    calls.push({
      method,
      path,
      headers: Object.fromEntries(headers.entries()),
      bytes: init.body instanceof Blob ? init.body.size : 0,
    });
    if (init.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const failure = failures.find(
      (entry) => entry.left > 0 && entry.match.test(`${method} ${path}`),
    );
    if (failure) {
      failure.left -= 1;
      if (failure.respond === "network") {
        throw new TypeError("Failed to fetch");
      }
      return problem(failure.respond, failure.problemType ?? "about:blank", failure.extensions);
    }
    // Only segment uploads count: they are what the engine bounds.
    const isSegment = method === "PUT";
    if (isSegment) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    }
    try {
      // Yield so concurrent requests overlap the way they do on a network.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (init.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return await handle(method, path, { ...init, headers });
    } finally {
      if (isSegment) {
        inFlight -= 1;
      }
    }
  };

  return {
    fetch: fakeFetch,
    calls,
    uploads,
    failWith(failure: FakeFailure) {
      failures.push({ ...failure, left: failure.times ?? 1 });
    },
    get maxInFlight() {
      return maxInFlight;
    },
    /** Requests made to `pattern` (`METHOD path`). */
    callsTo(pattern: RegExp) {
      return calls.filter((call) => pattern.test(`${call.method} ${call.path}`));
    },
  };
}

export type FakeImportApi = ReturnType<typeof createFakeImportApi>;

/** A file made of the given text, named like a mail file. */
export function textFile(name: string, text: string): File {
  return new File([text], name, { type: "application/octet-stream" });
}
