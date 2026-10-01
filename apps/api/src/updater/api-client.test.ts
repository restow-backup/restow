import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpApiClient } from "./api-client.js";
import { Redactor } from "./redact.js";

const SECRET = "c".repeat(64);
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function api(
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void,
): Promise<{ client: HttpApiClient; seen: { url: string; authorization?: string }[] }> {
  const seen: { url: string; authorization?: string }[] = [];
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? "", authorization: request.headers.authorization });
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redactor = new Redactor();
  redactor.add(SECRET);
  return {
    client: new HttpApiClient({
      apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      secret: SECRET,
      redactor,
      timeoutMs: 1000,
    }),
    seen,
  };
}

const json = (response: http.ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
};

describe("HttpApiClient.readiness", () => {
  it("sends the bearer secret and reads status and version", async () => {
    const { client, seen } = await api((_request, response) =>
      json(response, 200, { status: "ready", version: "0.2.0", checks: { database: true } }),
    );
    expect(await client.readiness()).toEqual({ ready: true, version: "0.2.0", reason: null });
    expect(seen).toEqual([{ url: "/readyz", authorization: `Bearer ${SECRET}` }]);
  });

  it("is ready without a version for an api that reports none", async () => {
    const { client } = await api((_request, response) => json(response, 200, { status: "ready" }));
    expect(await client.readiness()).toEqual({ ready: true, version: null, reason: null });
  });

  it("is not ready on 503, still reporting the version it gave", async () => {
    const { client } = await api((_request, response) =>
      json(response, 503, { status: "not_ready", version: "0.1.0" }),
    );
    expect(await client.readiness()).toMatchObject({ ready: false, version: "0.1.0" });
  });

  it("takes a missing worker or scheduler for an api that is up: the updater starts them after it", async () => {
    const { client } = await api((_request, response) =>
      json(response, 503, {
        status: "not_ready",
        version: "0.2.0",
        checks: { database: true, worker: "missing", scheduler: "missing" },
      }),
    );
    expect(await client.readiness()).toEqual({ ready: true, version: "0.2.0", reason: null });
  });

  it("is not ready when the database check fails, whatever else is reported", async () => {
    const down = await api((_request, response) =>
      json(response, 503, {
        status: "not_ready",
        version: "0.2.0",
        checks: { database: false, worker: "missing", scheduler: "missing" },
      }),
    );
    expect(await down.client.readiness()).toMatchObject({ ready: false, version: "0.2.0" });
    const unknown = await api((_request, response) =>
      json(response, 503, {
        status: "not_ready",
        checks: { database: true, worker: "missing", storage: false },
      }),
    );
    expect((await unknown.client.readiness()).ready).toBe(false);
    const bare = await api((_request, response) => json(response, 503, { status: "not_ready" }));
    expect((await bare.client.readiness()).ready).toBe(false);
  });

  it("is not ready on 200 with another status, on a proxy error page and on garbage", async () => {
    const other = await api((_request, response) => json(response, 200, { status: "starting" }));
    expect((await other.client.readiness()).ready).toBe(false);
    const html = await api((_request, response) =>
      response.writeHead(502).end("<html>Bad gateway</html>"),
    );
    expect(await html.client.readiness()).toMatchObject({ ready: false, version: null });
    const junk = await api((_request, response) => response.writeHead(200).end("nonsense"));
    expect((await junk.client.readiness()).ready).toBe(false);
  });

  it("never throws for an unreachable api and does not follow redirects", async () => {
    const unreachable = new HttpApiClient({
      apiUrl: "http://127.0.0.1:1",
      secret: SECRET,
      redactor: new Redactor(),
      timeoutMs: 500,
    });
    const result = await unreachable.readiness();
    expect(result.ready).toBe(false);
    expect(result.reason).not.toBeNull();

    const other = await api((_request, response) => json(response, 200, { status: "ready" }));
    const redirecting = await api((_request, response) => {
      response
        .writeHead(302, {
          Location: `${(other.client as unknown as { options: { apiUrl: string } }).options.apiUrl}/readyz`,
        })
        .end();
    });
    expect((await redirecting.client.readiness()).ready).toBe(false);
    expect(other.seen).toEqual([]);
  });

  it("times out on an api that does not answer", async () => {
    const { client } = await api(() => undefined);
    const started = Date.now();
    expect((await client.readiness()).ready).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("HttpApiClient.sourceToken", () => {
  it("returns the token, or null when none is stored", async () => {
    const withToken = await api((_request, response) => json(response, 200, { token: "ghp_abc" }));
    expect(await withToken.client.sourceToken()).toBe("ghp_abc");
    expect(withToken.seen).toEqual([
      { url: "/internal/updater/source-token", authorization: `Bearer ${SECRET}` },
    ]);
    const without = await api((_request, response) => json(response, 200, { token: null }));
    expect(await without.client.sourceToken()).toBeNull();
  });

  it("throws for an api that refuses, fails or answers oddly, without echoing the secret", async () => {
    const refusing = await api((_request, response) => json(response, 401, { error: SECRET }));
    await expect(refusing.client.sourceToken()).rejects.toThrow(/HTTP 401/);
    const odd = await api((_request, response) => json(response, 200, { token: 42 }));
    await expect(odd.client.sourceToken()).rejects.toThrow(/unexpected body/);
    const empty = await api((_request, response) => json(response, 200, { token: "" }));
    await expect(empty.client.sourceToken()).rejects.toThrow(/unexpected body/);
    const down = new HttpApiClient({
      apiUrl: "http://127.0.0.1:1",
      secret: SECRET,
      redactor: new Redactor(),
      timeoutMs: 500,
    });
    const error = await down.sourceToken().catch((caught: Error) => caught);
    expect((error as Error).message).toContain("could not be asked");
    expect((error as Error).message).not.toContain(SECRET);
  });
});
