import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MULTIPART_PARTS,
  MIN_MULTIPART_PART_SIZE,
  S3StorageBackend,
  multipartCapacity,
  multipartPartSize,
  streamParts,
} from "./s3.js";

/**
 * The S3 backend against a stub endpoint on localhost: a stream of unknown
 * length (the restore ZIP) must reach the bucket intact as a multipart upload,
 * a short stream as one PutObject, and a failed stream or part must abort the
 * upload instead of leaving parts behind. No network beyond 127.0.0.1.
 */

const MIB = 1024 * 1024;
const BUCKET = "restow-test";
const UPLOAD_ID = "upload-1";

interface Recorded {
  method: string;
  key: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface Stub {
  requests: Recorded[];
  /** Answer the upload of this part number with a server error. */
  failPart: number | null;
}

const stub: Stub = { requests: [], failPart: null };
let server: Server;
let client: S3Client;

function xml(res: ServerResponse, body: string): void {
  res.writeHead(200, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`);
}

function answer(request: Recorded, res: ServerResponse): void {
  const { method, query } = request;
  if (method === "POST" && query.has("uploads")) {
    xml(
      res,
      `<InitiateMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${request.key}</Key><UploadId>${UPLOAD_ID}</UploadId></InitiateMultipartUploadResult>`,
    );
    return;
  }
  if (method === "PUT" && query.has("partNumber")) {
    const partNumber = Number(query.get("partNumber"));
    if (partNumber === stub.failPart) {
      res.writeHead(500, { "content-type": "application/xml" });
      res.end("<Error><Code>InternalError</Code><Message>part rejected</Message></Error>");
      return;
    }
    const checksum = request.headers["x-amz-checksum-crc32"];
    res.writeHead(200, {
      etag: `"etag-${partNumber}"`,
      ...(typeof checksum === "string" ? { "x-amz-checksum-crc32": checksum } : {}),
    });
    res.end();
    return;
  }
  if (method === "POST" && query.has("uploadId")) {
    xml(
      res,
      `<CompleteMultipartUploadResult><Bucket>${BUCKET}</Bucket><Key>${request.key}</Key><ETag>"etag-final"</ETag></CompleteMultipartUploadResult>`,
    );
    return;
  }
  if (method === "DELETE" && query.has("uploadId")) {
    res.writeHead(204);
    res.end();
    return;
  }
  if (method === "PUT") {
    res.writeHead(200, { etag: '"etag-object"' });
    res.end();
    return;
  }
  res.writeHead(400);
  res.end();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const recorded: Recorded = {
        method: req.method ?? "",
        key: decodeURIComponent(url.pathname.replace(`/${BUCKET}/`, "")),
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      stub.requests.push(recorded);
      answer(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  client = new S3Client({
    region: "us-east-1",
    endpoint: `http://127.0.0.1:${port}`,
    forcePathStyle: true,
    // Placeholders for request signing against the stub; no real account.
    credentials: { accessKeyId: "stub-access-key", secretAccessKey: "stub-secret-key" },
    maxAttempts: 1,
  });
});

afterAll(async () => {
  client.destroy();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  stub.requests = [];
  stub.failPart = null;
});

/** A stream that reports no length: `count` MiB of distinct bytes, then `tail` bytes. */
function unknownLengthStream(count: number, tail = 0, failAfter?: number): Readable {
  return Readable.from(
    (async function* () {
      for (let index = 0; index < count; index++) {
        if (failAfter !== undefined && index === failAfter) {
          throw new Error("source failed");
        }
        yield Buffer.alloc(MIB, index + 1);
      }
      if (tail > 0) {
        yield Buffer.alloc(tail, 0xee);
      }
    })(),
  );
}

function expectedBytes(count: number, tail = 0): Buffer {
  const parts = Array.from({ length: count }, (_, index) => Buffer.alloc(MIB, index + 1));
  return Buffer.concat([...parts, Buffer.alloc(tail, 0xee)]);
}

const backend = () => new S3StorageBackend({ bucket: BUCKET, prefix: "restow", client });

function summary(requests: Recorded[]): string[] {
  return requests.map((request) => {
    const part = request.query.get("partNumber");
    if (part) {
      return `${request.method} part ${part}`;
    }
    if (request.query.has("uploads")) {
      return "POST create";
    }
    if (request.query.has("uploadId")) {
      return `${request.method} ${request.method === "DELETE" ? "abort" : "complete"}`;
    }
    return `${request.method} object`;
  });
}

describe("multipart part sizes", () => {
  it("starts above the S3 minimum and grows every thousand parts up to 64 MiB", () => {
    expect(multipartPartSize(1)).toBe(8 * MIB);
    expect(multipartPartSize(1)).toBeGreaterThanOrEqual(MIN_MULTIPART_PART_SIZE);
    expect(multipartPartSize(1000)).toBe(8 * MIB);
    expect(multipartPartSize(1001)).toBe(16 * MIB);
    expect(multipartPartSize(3001)).toBe(64 * MIB);
    expect(multipartPartSize(MAX_MULTIPART_PARTS)).toBe(64 * MIB);
    expect(multipartCapacity()).toBeGreaterThan(400 * 1024 * MIB);
  });
});

describe("streamParts", () => {
  async function collect(chunks: string[], size: number): Promise<string[]> {
    const parts: string[] = [];
    for await (const part of streamParts(Readable.from(chunks), () => size)) {
      parts.push(`${part.partNumber}:${part.data.toString()}`);
    }
    return parts;
  }

  it("cuts chunks of any size into full parts and a shorter last part", async () => {
    expect(await collect(["ab", "cdefg", "hij"], 4)).toEqual(["1:abcd", "2:efgh", "3:ij"]);
  });

  it("adds no empty part when the stream ends on a part boundary", async () => {
    expect(await collect(["abcd", "efgh"], 4)).toEqual(["1:abcd", "2:efgh"]);
  });

  it("yields one empty part for an empty stream", async () => {
    expect(await collect([], 4)).toEqual(["1:"]);
  });
});

describe("S3StorageBackend.put with a stream", () => {
  it("uploads a stream of unknown length as a multipart upload, byte for byte", async () => {
    await backend().put("tenants/t1/restores/r1.zip", unknownLengthStream(17, 12_345), {
      contentType: "application/zip",
    });

    expect(summary(stub.requests)).toEqual([
      "POST create",
      "PUT part 1",
      "PUT part 2",
      "PUT part 3",
      "POST complete",
    ]);
    const [create, ...rest] = stub.requests;
    expect(create?.key).toBe("restow/tenants/t1/restores/r1.zip");
    expect(create?.headers["content-type"]).toBe("application/zip");
    expect(create?.headers["x-amz-checksum-algorithm"]).toBe("CRC32");

    const parts = rest.filter((request) => request.query.has("partNumber"));
    expect(parts.map((part) => part.body.length)).toEqual([8 * MIB, 8 * MIB, MIB + 12_345]);
    expect(parts.every((part) => part.query.get("uploadId") === UPLOAD_ID)).toBe(true);
    expect(Buffer.concat(parts.map((part) => part.body)).equals(expectedBytes(17, 12_345))).toBe(
      true,
    );

    const complete = stub.requests.at(-1)?.body.toString() ?? "";
    for (const partNumber of [1, 2, 3]) {
      expect(complete).toContain(`<PartNumber>${partNumber}</PartNumber>`);
      expect(complete).toContain(`etag-${partNumber}`);
    }
    expect(complete).toContain("<ChecksumCRC32>");
  });

  it("sends a stream that ends within the first part as one PutObject", async () => {
    await backend().put("tenants/t1/restores/small.zip", unknownLengthStream(2, 100));

    expect(summary(stub.requests)).toEqual(["PUT object"]);
    const [put] = stub.requests;
    expect(put?.body.equals(expectedBytes(2, 100))).toBe(true);
    expect(put?.headers["content-length"]).toBe(String(2 * MIB + 100));
  });

  it("aborts the upload when the stream fails and reports the stream's error", async () => {
    await expect(
      backend().put("tenants/t1/restores/broken.zip", unknownLengthStream(20, 0, 10)),
    ).rejects.toThrow("source failed");

    expect(summary(stub.requests)).toEqual(["POST create", "PUT part 1", "DELETE abort"]);
  });

  it("aborts the upload when a part is rejected", async () => {
    stub.failPart = 2;
    await expect(
      backend().put("tenants/t1/restores/rejected.zip", unknownLengthStream(20)),
    ).rejects.toThrow();

    expect(summary(stub.requests)).toEqual([
      "POST create",
      "PUT part 1",
      "PUT part 2",
      "DELETE abort",
    ]);
  });
});
