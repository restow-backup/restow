import { type IncomingHttpHeaders, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { rewriteRepositoryUrl, startResticProxy, upstreamHeaders } from "./restic-proxy.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

async function upstream(): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(request.url?.endsWith("/missing") ? 404 : 200, {
        "content-type": "application/vnd.x.restic.rest.v2",
        "x-echo": request.method ?? "",
      });
      response.end(request.method === "HEAD" ? undefined : Buffer.concat(chunks));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the restic proxy", () => {
  it("forwards restic's requests with the seed token added and the credentials untouched", async () => {
    const target = await upstream();
    const proxy = await startResticProxy(target.origin, "seed-secret");
    closers.push(proxy.close);
    const body = Buffer.alloc(300_000, 7);
    const response = await fetch(`${proxy.origin}/agent/restic/abc/data/ab12`, {
      method: "POST",
      headers: {
        authorization: "Basic ZW5kcG9pbnQ6c2VjcmV0",
        accept: "application/vnd.x.restic.rest.v2",
        // A client-supplied token is replaced, never trusted.
        "x-restow-demo-seed-token": "forged",
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
    const [seen] = target.seen;
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/agent/restic/abc/data/ab12");
    expect(seen?.headers["x-restow-demo-seed-token"]).toBe("seed-secret");
    expect(seen?.headers.authorization).toBe("Basic ZW5kcG9pbnQ6c2VjcmV0");
    expect(seen?.headers.accept).toBe("application/vnd.x.restic.rest.v2");
    expect(seen?.body.length).toBe(300_000);
  });

  it("passes methods, statuses and response headers through", async () => {
    const target = await upstream();
    const proxy = await startResticProxy(target.origin, "seed-secret");
    closers.push(proxy.close);
    const head = await fetch(`${proxy.origin}/agent/restic/abc/config`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("x-echo")).toBe("HEAD");
    const del = await fetch(`${proxy.origin}/agent/restic/abc/locks/missing`, { method: "DELETE" });
    expect(del.status).toBe(404);
    expect(target.seen.map((s) => s.method)).toEqual(["HEAD", "DELETE"]);
  });

  it("proxies nothing but the restic REST backend", async () => {
    const target = await upstream();
    const proxy = await startResticProxy(target.origin, "seed-secret");
    closers.push(proxy.close);
    for (const path of ["/", "/api/v1/tenants", "/agent/v1/enroll", "/agent/restic/../v1/x"]) {
      const response = await fetch(`${proxy.origin}${path}`, { method: "POST" });
      expect(response.status, path).toBe(404);
    }
    expect(target.seen).toHaveLength(0);
  });

  it("answers 502 when the api is not reachable", async () => {
    const proxy = await startResticProxy("http://127.0.0.1:1", "seed-secret");
    closers.push(proxy.close);
    const response = await fetch(`${proxy.origin}/agent/restic/abc/config`);
    expect(response.status).toBe(502);
  });

  it("drops hop-by-hop headers and keeps the rest", () => {
    const headers = upstreamHeaders(
      { host: "127.0.0.1:1", connection: "keep-alive", "content-length": "5", "x-a": "1" },
      "t",
    );
    expect(headers).toEqual({ "content-length": "5", "x-a": "1", "x-restow-demo-seed-token": "t" });
  });
});

describe("rewriteRepositoryUrl", () => {
  it("keeps the repository path and swaps the instance's address for the proxy's", () => {
    expect(
      rewriteRepositoryUrl(
        "rest:https://demo.restowbackup.com/agent/restic/6f1c2a52-6c0b-4d3a-9d0e-3a1b2c4d5e6f/",
        "http://127.0.0.1:4555",
      ),
    ).toBe("rest:http://127.0.0.1:4555/agent/restic/6f1c2a52-6c0b-4d3a-9d0e-3a1b2c4d5e6f/");
  });

  it("refuses a repository that is not a REST URL", () => {
    expect(() => rewriteRepositoryUrl("/srv/repo", "http://127.0.0.1:1")).toThrow();
  });
});
