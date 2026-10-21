import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { S3StorageBackend } from "./s3.js";

/**
 * A response body that breaks off mid-transfer (the connection is cut after
 * part of the object, Node reports "aborted"): the SDK does not retry it, the
 * backend resumes from the first byte it has not delivered yet.
 */

const BUCKET = "restow-resume-test";
const OBJECT = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251));
const ETAG = '"v1"';

let server: Server;
let client: S3Client;
let cutsLeft = 0;
let etag = ETAG;
const seen: { range: string | undefined; ifMatch: string | undefined }[] = [];

function handle(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ range: req.headers.range, ifMatch: req.headers["if-match"] as string | undefined });
  if (req.headers["if-match"] && req.headers["if-match"] !== etag) {
    res.writeHead(412, { "content-type": "application/xml" });
    res.end("<Error><Code>PreconditionFailed</Code><Message>changed</Message></Error>");
    return;
  }
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : OBJECT.length - 1;
  const slice = OBJECT.subarray(start, end + 1);
  res.writeHead(match ? 206 : 200, {
    "content-length": String(slice.length),
    etag,
    ...(match ? { "content-range": `bytes ${start}-${end}/${OBJECT.length}` } : {}),
  });
  if (cutsLeft > 0) {
    cutsLeft -= 1;
    // Half the body, then the connection goes away.
    res.write(slice.subarray(0, Math.floor(slice.length / 2)), () => {
      setTimeout(() => res.socket?.destroy(), 5);
    });
    return;
  }
  res.end(slice);
}

async function bytesOf(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts);
}

describe("S3 backend: resuming a broken body", () => {
  let backend: S3StorageBackend;

  beforeAll(async () => {
    server = createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    client = new S3Client({
      endpoint: `http://127.0.0.1:${port}`,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    backend = new S3StorageBackend({ bucket: BUCKET, client, bodyRetryDelaysMs: [0, 0] });
  });

  beforeEach(() => {
    seen.length = 0;
    cutsLeft = 0;
    etag = ETAG;
  });

  afterAll(async () => {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("get reads the rest after two cut transfers and returns the exact bytes", async () => {
    cutsLeft = 2;
    const bytes = await backend.get("packs/a");
    expect(bytes.equals(OBJECT)).toBe(true);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ range: undefined, ifMatch: undefined });
    // Each resumption asks only for what is still missing, pinned to the first ETag.
    expect(seen[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/bytes=(\d+)-/.exec(seen[1]?.range ?? "")?.[1])).toBeGreaterThan(0);
    expect(seen[1]?.ifMatch).toBe(ETAG);
  });

  it("gives up after three reads in all", async () => {
    cutsLeft = 3;
    await expect(backend.get("packs/a")).rejects.toThrow(/aborted|socket|ECONNRESET|terminated/i);
    expect(seen).toHaveLength(3);
  });

  it("resumes a ranged read within its range", async () => {
    cutsLeft = 1;
    const bytes = await bytesOf(await backend.getRange("packs/a", 1000, 9999));
    expect(bytes.equals(OBJECT.subarray(1000, 10_000))).toBe(true);
    expect(seen[0]?.range).toBe("bytes=1000-9999");
    expect(seen[1]?.range).toMatch(/^bytes=\d+-9999$/);
  });

  it("never stitches a replaced object together", async () => {
    cutsLeft = 1;
    const stream = await backend.getStream("packs/a");
    etag = '"v2"';
    await expect(bytesOf(stream)).rejects.toThrow();
    expect(seen[1]?.ifMatch).toBe(ETAG);
  });
});
