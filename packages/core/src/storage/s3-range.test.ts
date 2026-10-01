import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3StorageBackend } from "./s3.js";

/**
 * Ranged reads and sized listings of the S3 backend against a stub on
 * localhost: the endpoint backup serves restic's partial reads of packs and
 * lists packs with their sizes, and neither may read a whole object to do it.
 */

const BUCKET = "restow-range-test";
const OBJECT = Buffer.from("0123456789");

let server: Server;
let client: S3Client;
const seen: { method: string; url: string; range: string | undefined }[] = [];

function handle(req: IncomingMessage, res: ServerResponse): void {
  seen.push({ method: req.method ?? "", url: req.url ?? "", range: req.headers.range });
  const url = new URL(req.url ?? "/", "http://stub");
  if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(
      [
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${BUCKET}</Name><IsTruncated>false</IsTruncated>`,
        "<Contents><Key>p/endpoints/x/data/ab/b</Key><Size>12</Size></Contents>",
        "<Contents><Key>p/endpoints/x/data/ab/a</Key><Size>7</Size></Contents></ListBucketResult>",
      ].join(""),
    );
    return;
  }
  if (req.method === "GET") {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? "");
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      const slice = OBJECT.subarray(start, end + 1);
      res.writeHead(206, {
        "content-length": String(slice.length),
        "content-range": `bytes ${start}-${end}/${OBJECT.length}`,
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { "content-length": String(OBJECT.length) });
    res.end(OBJECT);
    return;
  }
  res.writeHead(405);
  res.end();
}

async function text(stream: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of stream) {
    parts.push(part as Buffer);
  }
  return Buffer.concat(parts).toString("utf8");
}

describe("S3 backend: ranges and sized listings", () => {
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
  });

  afterAll(async () => {
    client.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("asks S3 for exactly the range, not the object", async () => {
    const backend = new S3StorageBackend({ bucket: BUCKET, prefix: "p", client });
    seen.length = 0;
    expect(await text(await backend.getRange("endpoints/x/data/ab/a", 2, 5))).toBe("2345");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.range).toBe("bytes=2-5");
    expect(seen[0]?.url).toContain("/p/endpoints/x/data/ab/a");
  });

  it("lists with the sizes S3 returns, without a request per object", async () => {
    const backend = new S3StorageBackend({ bucket: BUCKET, prefix: "p", client });
    seen.length = 0;
    expect(await backend.listWithSizes("endpoints/x/data/")).toEqual([
      { key: "endpoints/x/data/ab/a", size: 7 },
      { key: "endpoints/x/data/ab/b", size: 12 },
    ]);
    expect(seen).toHaveLength(1);
  });
});
