/**
 * Webhook delivery: signature, retry schedule, error format, the target
 * address policy, the HTTP transport (against a loopback server, never the
 * network), the dispatcher over an in-memory store, and — when
 * RESTOW_TEST_DATABASE_URL points at a Postgres server — the real store:
 * fan-out, claiming with leases, recording and pruning (database
 * `restow_worker_webhooks_test`, recreated per run).
 */
import { createHmac, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type Database,
  createDb,
  providers,
  secrets,
  settings,
  tenants,
  webhookDeliveries,
  webhooks,
} from "@restow/db";
import { runMigrations } from "@restow/db/migrate";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { dropTestDatabase, ignoreTerminatedConnection } from "../testing/database.js";
import {
  type AttemptPlan,
  CHAT_PERMANENT_STATUSES,
  type ChatContextSource,
  DEFAULT_WEBHOOK_OPTIONS,
  DeliveryFailure,
  type DeliveryStore,
  type DueDelivery,
  type LoadedDelivery,
  PgDeliveryStore,
  RETRY_DELAYS_MS,
  type ReceiverResponse,
  WEBHOOK_MAX_ATTEMPTS,
  WebhookDispatcher,
  type WebhookHttpRequest,
  chatDeliveryHeaders,
  checkTargetUrl,
  classifyAddress,
  createHttpTransport,
  deliveryHeaders,
  emitJobWebhook,
  emitWebhookEvent,
  failureForError,
  failureForResponse,
  formatDeliveryError,
  isAddressAllowed,
  isDemoModeEnabled,
  isPermanentFailure,
  jobEventData,
  jobWebhookEvent,
  parseRetryAfter,
  pgChatContextSource,
  planAfterAttempt,
  retryDelayMs,
  sanitizeDetail,
  signWebhookBody,
  webhookOptionsFromEnv,
} from "./webhooks.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const TENANT = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

function problemOf(fn: () => unknown): DeliveryFailure {
  try {
    fn();
  } catch (error) {
    if (error instanceof DeliveryFailure) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a delivery failure");
}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

describe("signWebhookBody", () => {
  it("is HMAC-SHA-256 over the raw body, hex, prefixed with the algorithm", () => {
    // RFC 4231, test case 2.
    expect(signWebhookBody("Jefe", "what do ya want for nothing?")).toBe(
      "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("changes with every byte of the body and with the secret", () => {
    const body = JSON.stringify({ id: "evt-1", event: "job.failed" });
    const signature = signWebhookBody("whsec_a", body);
    expect(signWebhookBody("whsec_a", `${body} `)).not.toBe(signature);
    expect(signWebhookBody("whsec_b", body)).not.toBe(signature);
  });

  it("goes out with the documented headers", () => {
    expect(
      deliveryHeaders({
        event: "job.failed",
        deliveryId: "d-1",
        attempt: 3,
        signature: "sha256=x",
      }),
    ).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "Restow-Webhooks/1",
      "X-Restow-Event": "job.failed",
      "X-Restow-Delivery": "d-1",
      "X-Restow-Attempt": "3",
      "X-Restow-Signature": "sha256=x",
    });
  });
});

describe("retry schedule", () => {
  const exact = () => 0.5;

  it("waits 1 min, 5 min, 15 min, 1 h, 3 h, 6 h, 12 h between the 8 attempts", () => {
    expect(RETRY_DELAYS_MS).toHaveLength(WEBHOOK_MAX_ATTEMPTS - 1);
    const waits = [1, 2, 3, 4, 5, 6, 7].map((attempts) => retryDelayMs(attempts, exact));
    expect(waits).toEqual([MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR]);
    const total = waits.reduce((sum, wait) => sum + wait, 0);
    expect(total).toBe(22 * HOUR + 21 * MINUTE);
  });

  it("jitters by at most 10 percent", () => {
    expect(retryDelayMs(1, () => 0)).toBe(54_000);
    expect(retryDelayMs(1, () => 1)).toBe(66_000);
    for (let i = 0; i < 100; i++) {
      const wait = retryDelayMs(4);
      expect(wait).toBeGreaterThanOrEqual(0.9 * HOUR);
      expect(wait).toBeLessThanOrEqual(1.1 * HOUR);
    }
  });

  it("clamps out-of-range attempt counts", () => {
    expect(retryDelayMs(0, exact)).toBe(MINUTE);
    expect(retryDelayMs(99, exact)).toBe(12 * HOUR);
  });

  it("reads Retry-After in seconds or as a date, capped at 12 hours", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("Wed, 23 Sep 2026 12:10:00 GMT", NOW)).toBe(10 * MINUTE);
    expect(parseRetryAfter("999999", NOW)).toBe(12 * HOUR);
    expect(parseRetryAfter("0", NOW)).toBeNull();
    expect(parseRetryAfter("Wed, 23 Sep 2026 11:00:00 GMT", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    // Chat services send fractions of a second; they round up.
    expect(parseRetryAfter("0.35", NOW)).toBe(350);
    expect(parseRetryAfter("1.0001", NOW)).toBe(1001);
    expect(parseRetryAfter("1.", NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
  });
});

describe("failures", () => {
  it("are stored as <code>[ <status>][: <detail>]", () => {
    expect(formatDeliveryError(new DeliveryFailure("timeout"))).toBe("timeout");
    expect(formatDeliveryError(new DeliveryFailure("http_error", "Bad gateway", 502))).toBe(
      "http_error 502: Bad gateway",
    );
    expect(formatDeliveryError(new DeliveryFailure("redirect", null, 301))).toBe("redirect 301");
    expect(formatDeliveryError(new DeliveryFailure("connection_failed", "ECONNREFUSED"))).toBe(
      "connection_failed: ECONNREFUSED",
    );
  });

  it("keep details to one printable line of 300 characters", () => {
    expect(sanitizeDetail("line one\r\n\tline\u0000two  ")).toBe("line one line two");
    const long = sanitizeDetail("x".repeat(1000));
    expect(long).toHaveLength(300);
    expect(long.endsWith("…")).toBe(true);
  });

  it("classify receiver responses", () => {
    const ok = { body: "", retryAfter: null };
    expect(failureForResponse({ status: 200, ...ok }, NOW)).toBeNull();
    expect(failureForResponse({ status: 204, ...ok }, NOW)).toBeNull();
    expect(failureForResponse({ status: 302, ...ok }, NOW)).toMatchObject({
      code: "redirect",
      httpStatus: 302,
    });
    expect(
      failureForResponse({ status: 500, body: "<h1>Oops</h1>\n", retryAfter: null }, NOW),
    ).toMatchObject({ code: "http_error", httpStatus: 500, detail: "<h1>Oops</h1>" });
    expect(failureForResponse({ status: 429, body: "", retryAfter: "90" }, NOW)).toMatchObject({
      code: "http_error",
      httpStatus: 429,
      detail: null,
      retryAfterMs: 90_000,
    });
  });

  it("classify transport errors", () => {
    const errno = (code: string) => Object.assign(new Error(code), { code });
    expect(failureForError(errno("ENOTFOUND"), false)).toMatchObject({
      code: "dns_failed",
      detail: "ENOTFOUND",
    });
    expect(failureForError(errno("ECONNREFUSED"), false)).toMatchObject({
      code: "connection_failed",
      detail: "ECONNREFUSED",
    });
    expect(failureForError(errno("CERT_HAS_EXPIRED"), false).code).toBe("tls_failed");
    expect(failureForError(errno("ERR_TLS_CERT_ALTNAME_INVALID"), false).code).toBe("tls_failed");
    expect(failureForError(errno("ECONNRESET"), true).code).toBe("timeout");
    const blocked = new DeliveryFailure("blocked_address", "10.0.0.1");
    expect(failureForError(blocked, false)).toBe(blocked);
  });

  it("give up at once only when retrying cannot help", () => {
    expect(isPermanentFailure(new DeliveryFailure("blocked_address"))).toBe(true);
    expect(isPermanentFailure(new DeliveryFailure("secret_missing"))).toBe(true);
    expect(isPermanentFailure(new DeliveryFailure("http_error", null, 410))).toBe(true);
    expect(isPermanentFailure(new DeliveryFailure("http_error", null, 404))).toBe(false);
    expect(isPermanentFailure(new DeliveryFailure("timeout"))).toBe(false);
  });

  it("keep the restow format's retries for every 4xx but 410", () => {
    for (const status of [400, 401, 403, 404, 413, 422, 429]) {
      expect(isPermanentFailure(new DeliveryFailure("http_error", null, status), "restow")).toBe(
        false,
      );
    }
  });

  it("end chat deliveries at once on answers a retry cannot change", () => {
    for (const format of ["discord", "slack", "teams"] as const) {
      for (const status of [400, 401, 403, 404, 410, 413, 422]) {
        expect(isPermanentFailure(new DeliveryFailure("http_error", null, status), format)).toBe(
          true,
        );
      }
      // Rate limits, timeouts and server errors are retried.
      for (const status of [408, 429, 500, 502, 503, 504]) {
        expect(isPermanentFailure(new DeliveryFailure("http_error", null, status), format)).toBe(
          false,
        );
      }
      expect(isPermanentFailure(new DeliveryFailure("timeout"), format)).toBe(false);
      expect(isPermanentFailure(new DeliveryFailure("connection_failed"), format)).toBe(false);
      expect(isPermanentFailure(new DeliveryFailure("redirect", null, 301), format)).toBe(false);
    }
    expect([...CHAT_PERMANENT_STATUSES].sort()).toEqual([400, 401, 403, 404, 410, 413, 422]);
  });
});

describe("planAfterAttempt", () => {
  const exact = () => 0.5;

  it("marks an accepted delivery as delivered", () => {
    expect(planAfterAttempt({ attemptsBefore: 2, failure: null, now: NOW })).toEqual({
      status: "delivered",
      attempts: 3,
      lastError: null,
      nextAttemptAt: null,
      deliveredAt: NOW,
    });
  });

  it("schedules the next attempt after a transient failure", () => {
    const plan = planAfterAttempt({
      attemptsBefore: 0,
      failure: new DeliveryFailure("http_error", "down", 503),
      now: NOW,
      random: exact,
    });
    expect(plan).toEqual({
      status: "pending",
      attempts: 1,
      lastError: "http_error 503: down",
      nextAttemptAt: new Date(NOW.getTime() + MINUTE),
      deliveredAt: null,
    });
  });

  it("honours a longer Retry-After", () => {
    const plan = planAfterAttempt({
      attemptsBefore: 0,
      failure: new DeliveryFailure("http_error", null, 429, 30 * MINUTE),
      now: NOW,
      random: exact,
    });
    expect(plan.nextAttemptAt).toEqual(new Date(NOW.getTime() + 30 * MINUTE));
  });

  it("gives up a chat delivery on its first 404, and retries a 429 after Retry-After", () => {
    expect(
      planAfterAttempt({
        attemptsBefore: 0,
        failure: new DeliveryFailure("http_error", "Unknown Webhook", 404),
        now: NOW,
        format: "discord",
      }),
    ).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "http_error 404: Unknown Webhook",
    });
    const limited = planAfterAttempt({
      attemptsBefore: 0,
      failure: new DeliveryFailure("http_error", null, 429, 5 * MINUTE),
      now: NOW,
      random: exact,
      format: "slack",
    });
    expect(limited).toMatchObject({ status: "pending", attempts: 1 });
    expect(limited.nextAttemptAt).toEqual(new Date(NOW.getTime() + 5 * MINUTE));
  });

  it("gives up after the last attempt and on permanent failures", () => {
    expect(
      planAfterAttempt({
        attemptsBefore: WEBHOOK_MAX_ATTEMPTS - 1,
        failure: new DeliveryFailure("timeout"),
        now: NOW,
      }),
    ).toMatchObject({ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: null });
    expect(
      planAfterAttempt({
        attemptsBefore: 0,
        failure: new DeliveryFailure("blocked_address", "169.254.169.254"),
        now: NOW,
      }),
    ).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "blocked_address: 169.254.169.254",
    });
  });
});

describe("target address policy", () => {
  it.each([
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.178.1", "private"],
    ["100.64.0.1", "private"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link_local"],
    ["0.0.0.0", "unspecified"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["192.0.2.10", "reserved"],
    ["2606:4700:4700::1111", "public"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1%eth0", "link_local"],
    ["fd12:3456::1", "private"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "reserved"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:169.254.169.254", "link_local"],
    ["64:ff9b::a00:1", "private"],
    ["2002:c0a8:0101::1", "private"],
    ["[::1]", "loopback"],
    ["not-an-address", "reserved"],
    ["1:2:3", "reserved"],
  ] as const)("classifies %s as %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it("allows public targets, and loopback/private networks only when configured", () => {
    expect(isAddressAllowed("93.184.216.34", false)).toBe(true);
    expect(isAddressAllowed("10.0.0.5", false)).toBe(false);
    expect(isAddressAllowed("10.0.0.5", true)).toBe(true);
    expect(isAddressAllowed("127.0.0.1", true)).toBe(true);
    // Cloud metadata and friends never.
    expect(isAddressAllowed("169.254.169.254", true)).toBe(false);
    expect(isAddressAllowed("0.0.0.0", true)).toBe(false);
    expect(isAddressAllowed("ff02::1", true)).toBe(false);
  });

  it("checks URLs before connecting", () => {
    expect(checkTargetUrl("https://hooks.example.com/x", false).host).toBe("hooks.example.com");
    expect(problemOf(() => checkTargetUrl("https://10.0.0.5/x", false))).toMatchObject({
      code: "blocked_address",
      detail: "10.0.0.5",
    });
    expect(problemOf(() => checkTargetUrl("http://[::1]:8080/x", false)).code).toBe(
      "blocked_address",
    );
    expect(problemOf(() => checkTargetUrl("ftp://hooks.example.com", false)).code).toBe(
      "invalid_url",
    );
    expect(problemOf(() => checkTargetUrl("https://u:p@hooks.example.com", false)).code).toBe(
      "invalid_url",
    );
    expect(problemOf(() => checkTargetUrl("nonsense", false)).code).toBe("invalid_url");
  });
});

describe("job events", () => {
  const job = {
    id: "j-1",
    queue: "backup" as const,
    protectedObjectId: "o-1",
    startedAt: new Date("2026-09-23T10:00:00Z"),
    completedAt: new Date("2026-09-23T10:05:00Z"),
    errorMessage: "GraphError: 503",
  };

  it("maps final job states to events", () => {
    expect(jobWebhookEvent("completed")).toBe("job.completed");
    expect(jobWebhookEvent("failed")).toBe("job.failed");
    expect(jobWebhookEvent("cancelled")).toBeNull();
    expect(jobWebhookEvent("active")).toBeNull();
  });

  it("describe the job, with the error only for failures", () => {
    expect(jobEventData({ ...job, status: "failed" })).toEqual({
      job: {
        id: "j-1",
        queue: "backup",
        status: "failed",
        protectedObjectId: "o-1",
        startedAt: "2026-09-23T10:00:00.000Z",
        completedAt: "2026-09-23T10:05:00.000Z",
        durationMs: 300_000,
        errorMessage: "GraphError: 503",
        failure: null,
      },
    });
    expect(
      (jobEventData({ ...job, status: "completed" }).job as { errorMessage: unknown }).errorMessage,
    ).toBeNull();
  });

  it("carries the classified cause of a failed job, so a ticket can say why", () => {
    const failure = {
      v: 1 as const,
      code: "graph.consent_missing",
      transient: false,
      params: { aadsts: "AADSTS65001" },
      technical: { aadsts: "AADSTS65001" },
      occurredAt: "2026-09-23T10:05:00.000Z",
      step: null,
      retry: null,
    };
    const data = jobEventData({ ...job, status: "failed", failure }).job as { failure: unknown };
    expect(data.failure).toEqual(failure);
    // A completed job has nothing to explain, whatever an earlier attempt left behind.
    const completed = jobEventData({ ...job, status: "completed", failure }).job as {
      failure: unknown;
    };
    expect(completed.failure).toBeNull();
  });
});

describe("webhookOptionsFromEnv", () => {
  it("reads the tuning knobs and keeps private networks closed by default", () => {
    expect(webhookOptionsFromEnv({})).toEqual(DEFAULT_WEBHOOK_OPTIONS);
    expect(
      webhookOptionsFromEnv({
        WEBHOOK_POLL_MS: "1000",
        WEBHOOK_CONCURRENCY: "8",
        WEBHOOK_TIMEOUT_MS: "5000",
        RESTOW_WEBHOOK_ALLOW_PRIVATE: "TRUE",
      }),
    ).toMatchObject({
      pollIntervalMs: 1000,
      concurrency: 8,
      timeoutMs: 5000,
      allowPrivateNetworks: true,
    });
    expect(webhookOptionsFromEnv({ WEBHOOK_POLL_MS: "-5" }).pollIntervalMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// HTTP transport against a loopback server
// ---------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

async function startServer(handler: Handler): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

describe("createHttpTransport", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function serve(handler: Handler) {
    const started = await startServer(handler);
    servers.push(started.server);
    return started.url;
  }

  const request = (url: string, overrides: Partial<WebhookHttpRequest> = {}) => ({
    url,
    body: '{"id":"evt-1"}',
    headers: deliveryHeaders({
      event: "job.failed",
      deliveryId: "d-1",
      attempt: 1,
      signature: signWebhookBody("whsec_test", '{"id":"evt-1"}'),
    }),
    timeoutMs: 2000,
    signal: new AbortController().signal,
    ...overrides,
  });

  it("posts the signed body and returns status and an excerpt", async () => {
    let seen: { method?: string; headers: IncomingMessage["headers"]; body: string } | null = null;
    const url = await serve((req, res, body) => {
      seen = { method: req.method, headers: req.headers, body };
      res.writeHead(202, { "content-type": "text/plain" });
      res.end("accepted");
    });
    const transport = createHttpTransport({ allowPrivateNetworks: true });
    const response = await transport(request(`${url}/hook?token=abc`));
    expect(response).toEqual({ status: 202, body: "accepted", retryAfter: null });
    const received = seen as unknown as {
      method: string;
      headers: IncomingMessage["headers"];
      body: string;
    };
    expect(received.method).toBe("POST");
    expect(received.body).toBe('{"id":"evt-1"}');
    expect(received.headers["content-type"]).toBe("application/json");
    expect(received.headers["x-restow-event"]).toBe("job.failed");
    expect(received.headers["x-restow-delivery"]).toBe("d-1");
    const expected = createHmac("sha256", "whsec_test").update(received.body).digest("hex");
    expect(received.headers["x-restow-signature"]).toBe(`sha256=${expected}`);
  });

  it("does not follow redirects and passes Retry-After through", async () => {
    const url = await serve((req, res) => {
      if (req.url === "/moved") {
        res.writeHead(301, { location: "http://169.254.169.254/latest/meta-data" });
        res.end();
        return;
      }
      res.writeHead(503, { "retry-after": "120" });
      res.end("maintenance");
    });
    const transport = createHttpTransport({ allowPrivateNetworks: true });
    expect((await transport(request(`${url}/moved`))).status).toBe(301);
    expect(await transport(request(`${url}/busy`))).toEqual({
      status: 503,
      body: "maintenance",
      retryAfter: "120",
    });
  });

  it("reads at most a small excerpt of large responses", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(500);
      res.end("x".repeat(200_000));
    });
    const response = await createHttpTransport({ allowPrivateNetworks: true })(request(url));
    expect(response.status).toBe(500);
    expect(response.body.length).toBeLessThanOrEqual(1024);
  });

  it("refuses loopback targets unless private networks are allowed", async () => {
    const url = await serve((_req, res) => res.end());
    const closed = createHttpTransport({ allowPrivateNetworks: false });
    await expect(closed(request(url))).rejects.toMatchObject({ code: "blocked_address" });
    // Resolved names are checked too, at connect time.
    const byName = url.replace("127.0.0.1", "localhost");
    await expect(closed(request(byName))).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("times out slow receivers", async () => {
    const url = await serve(() => {
      // Never answers.
    });
    const transport = createHttpTransport({ allowPrivateNetworks: true });
    await expect(transport(request(url, { timeoutMs: 150 }))).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("reports refused connections", async () => {
    const url = await serve((_req, res) => res.end());
    const server = servers.pop();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await expect(
      createHttpTransport({ allowPrivateNetworks: true })(request(url)),
    ).rejects.toMatchObject({ code: "connection_failed", detail: "ECONNREFUSED" });
  });
});

// ---------------------------------------------------------------------------
// Dispatcher over an in-memory store
// ---------------------------------------------------------------------------

interface MemoryRow extends LoadedDelivery {
  status: AttemptPlan["status"];
  nextAttemptAt: Date | null;
  lastError: string | null;
}

class MemoryStore implements DeliveryStore {
  readonly rows = new Map<string, MemoryRow>();
  readonly recorded: { id: string; plan: AttemptPlan }[] = [];
  pruned: Date[] = [];

  add(overrides: Partial<MemoryRow> = {}): MemoryRow {
    const row: MemoryRow = {
      id: randomUUID(),
      tenantId: TENANT,
      webhookId: "w-1",
      event: "job.failed",
      payload: { id: "evt-1", event: "job.failed", data: { job: { id: "j-1" } } },
      attempts: 0,
      url: "https://hooks.example.com/restow",
      active: true,
      secretRef: "s-1",
      format: "restow",
      status: "pending",
      nextAttemptAt: null,
      lastError: null,
      ...overrides,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async claimDue(now: Date, limit: number, leaseUntil: Date): Promise<DueDelivery[]> {
    const due = [...this.rows.values()]
      .filter((row) => row.status === "pending" && (!row.nextAttemptAt || row.nextAttemptAt <= now))
      .slice(0, limit);
    for (const row of due) {
      row.nextAttemptAt = leaseUntil;
    }
    return due.map((row) => ({ id: row.id, tenantId: row.tenantId }));
  }

  async load(due: DueDelivery): Promise<LoadedDelivery | null> {
    const row = this.rows.get(due.id);
    return row ? { ...row } : null;
  }

  async record(due: DueDelivery, plan: AttemptPlan): Promise<void> {
    this.recorded.push({ id: due.id, plan });
    const row = this.rows.get(due.id);
    if (row) {
      Object.assign(row, {
        status: plan.status,
        attempts: plan.attempts,
        lastError: plan.lastError,
        nextAttemptAt: plan.nextAttemptAt,
      });
    }
  }

  async prune(before: Date): Promise<number> {
    this.pruned.push(before);
    return 0;
  }
}

function dispatcherWith(
  store: MemoryStore,
  transport: (request: WebhookHttpRequest) => Promise<ReceiverResponse>,
  secrets: (tenantId: string, ref: string) => Promise<string | null> = async () => "whsec_test",
  options = {},
  disabled = false,
  chatContext?: ChatContextSource,
) {
  let clock = NOW.getTime();
  const dispatcher = new WebhookDispatcher(
    {
      store,
      secrets,
      chatContext,
      transport,
      logger: silentLogger,
      now: () => new Date(clock),
      random: () => 0.5,
      disabled,
    },
    { ...DEFAULT_WEBHOOK_OPTIONS, ...options },
  );
  const advance = (ms: number) => {
    clock += ms;
  };
  return { dispatcher, advance };
}

describe("WebhookDispatcher", () => {
  it("delivers a signed body and records success", async () => {
    const store = new MemoryStore();
    const row = store.add();
    const sent: WebhookHttpRequest[] = [];
    const { dispatcher } = dispatcherWith(store, async (request) => {
      sent.push(request);
      return { status: 200, body: "", retryAfter: null };
    });
    expect(await dispatcher.runOnce()).toBe(1);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe(row.url);
    expect(JSON.parse(request?.body ?? "")).toEqual(row.payload);
    expect(request?.headers["X-Restow-Signature"]).toBe(
      signWebhookBody("whsec_test", request?.body ?? ""),
    );
    expect(request?.headers["X-Restow-Attempt"]).toBe("1");
    expect(store.rows.get(row.id)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  it("retries a failed delivery after the backoff and gives up after 8 attempts", async () => {
    const store = new MemoryStore();
    const row = store.add();
    let calls = 0;
    const { dispatcher, advance } = dispatcherWith(store, async () => {
      calls += 1;
      return { status: 500, body: "boom", retryAfter: null };
    });
    await dispatcher.runOnce();
    expect(store.rows.get(row.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "http_error 500: boom",
      nextAttemptAt: new Date(NOW.getTime() + MINUTE),
    });
    // Not due yet.
    expect(await dispatcher.runOnce()).toBe(0);
    for (const wait of RETRY_DELAYS_MS) {
      advance(wait);
      expect(await dispatcher.runOnce()).toBe(1);
    }
    expect(calls).toBe(WEBHOOK_MAX_ATTEMPTS);
    expect(store.rows.get(row.id)).toMatchObject({ status: "failed", attempts: 8 });
    advance(24 * HOUR);
    expect(await dispatcher.runOnce()).toBe(0);
  });

  it("ends deliveries of paused webhooks and without a secret, without sending", async () => {
    const store = new MemoryStore();
    const paused = store.add({ active: false });
    const noRef = store.add({ secretRef: null });
    const vanished = store.add({ secretRef: "gone" });
    let calls = 0;
    const { dispatcher } = dispatcherWith(
      store,
      async () => {
        calls += 1;
        return { status: 200, body: "", retryAfter: null };
      },
      async (_tenant, ref) => (ref === "gone" ? null : "whsec_test"),
    );
    await dispatcher.runOnce();
    expect(calls).toBe(0);
    expect(store.rows.get(paused.id)).toMatchObject({
      status: "failed",
      lastError: "webhook_disabled",
    });
    expect(store.rows.get(noRef.id)).toMatchObject({
      status: "failed",
      lastError: "secret_missing",
    });
    expect(store.rows.get(vanished.id)).toMatchObject({
      status: "failed",
      lastError: "secret_missing",
    });
  });

  it("posts a chat message without signature headers and without needing a secret", async () => {
    const store = new MemoryStore();
    const row = store.add({
      format: "discord",
      secretRef: null,
      url: "https://discord.com/api/webhooks/1/token",
      payload: {
        id: "evt-1",
        event: "job.failed",
        createdAt: NOW.toISOString(),
        tenantId: TENANT,
        data: { job: { id: "j-1", queue: "backup", errorMessage: "quota exceeded" } },
      },
    });
    const sent: WebhookHttpRequest[] = [];
    let secretAsked = false;
    const { dispatcher } = dispatcherWith(
      store,
      async (request) => {
        sent.push(request);
        return { status: 204, body: "", retryAfter: null };
      },
      async () => {
        secretAsked = true;
        return "whsec_test";
      },
      {},
      false,
      async () => ({
        language: "en",
        tenantName: "Contoso",
        publicUrl: "https://backup.example.com",
        objectName: "anna@contoso.example",
      }),
    );
    await dispatcher.runOnce();
    expect(secretAsked).toBe(false);
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.headers).toEqual(chatDeliveryHeaders());
    expect(Object.keys(request?.headers ?? {}).some((name) => name.startsWith("X-Restow"))).toBe(
      false,
    );
    const body = JSON.parse(request?.body ?? "{}");
    expect(body.embeds[0].title).toBe("Backup failed: anna@contoso.example");
    expect(body.embeds[0].url).toBe("https://backup.example.com/history/j-1");
    expect(body.allowed_mentions).toEqual({ parse: [] });
    // The log keeps the envelope; only the request body is the chat message.
    expect(store.rows.get(row.id)).toMatchObject({ status: "delivered", payload: row.payload });
  });

  it("gives up a chat delivery the service refuses, after one attempt", async () => {
    const store = new MemoryStore();
    const row = store.add({ format: "slack", url: "https://hooks.slack.com/services/T/B/x" });
    let calls = 0;
    const { dispatcher, advance } = dispatcherWith(store, async () => {
      calls += 1;
      return { status: 403, body: "invalid_token", retryAfter: null };
    });
    await dispatcher.runOnce();
    advance(24 * HOUR);
    await dispatcher.runOnce();
    expect(calls).toBe(1);
    expect(store.rows.get(row.id)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "http_error 403: invalid_token",
    });
  });

  it("retries a rate-limited chat delivery after Retry-After", async () => {
    const store = new MemoryStore();
    const row = store.add({ format: "teams" });
    const { dispatcher } = dispatcherWith(store, async () => ({
      status: 429,
      body: "",
      retryAfter: "600",
    }));
    await dispatcher.runOnce();
    expect(store.rows.get(row.id)).toMatchObject({
      status: "pending",
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 10 * MINUTE),
    });
  });

  it("retries a chat delivery whose context cannot be loaded", async () => {
    const store = new MemoryStore();
    const row = store.add({ format: "discord" });
    let calls = 0;
    const { dispatcher } = dispatcherWith(
      store,
      async () => {
        calls += 1;
        return { status: 204, body: "", retryAfter: null };
      },
      undefined,
      {},
      false,
      async () => {
        throw new Error("database gone");
      },
    );
    await dispatcher.runOnce();
    expect(calls).toBe(0);
    expect(store.rows.get(row.id)).toMatchObject({
      status: "pending",
      lastError: "internal: message context could not be loaded",
    });
  });

  it("records a secret that cannot be opened as a retryable failure", async () => {
    const store = new MemoryStore();
    const row = store.add();
    const { dispatcher } = dispatcherWith(
      store,
      async () => ({ status: 200, body: "", retryAfter: null }),
      async () => {
        throw new Error("unwrap failed");
      },
    );
    await dispatcher.runOnce();
    expect(store.rows.get(row.id)).toMatchObject({
      status: "pending",
      lastError: "internal: signing secret could not be opened",
    });
  });

  it("records transport failures with their code", async () => {
    const store = new MemoryStore();
    const row = store.add();
    const { dispatcher } = dispatcherWith(store, async () => {
      throw new DeliveryFailure("dns_failed", "ENOTFOUND");
    });
    await dispatcher.runOnce();
    expect(store.rows.get(row.id)?.lastError).toBe("dns_failed: ENOTFOUND");
  });

  it("records nothing for an attempt cut short by shutdown", async () => {
    const store = new MemoryStore();
    store.add();
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { dispatcher } = dispatcherWith(
      store,
      (request) =>
        new Promise((_resolve, reject) => {
          started();
          request.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const run = dispatcher.runOnce();
    await inFlight;
    await dispatcher.stop();
    await run;
    expect(store.recorded).toHaveLength(0);
  });

  it("sends at most `concurrency` requests at once", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 10; i++) {
      store.add();
    }
    let active = 0;
    let peak = 0;
    const { dispatcher } = dispatcherWith(
      store,
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { status: 204, body: "", retryAfter: null };
      },
      undefined,
      { concurrency: 3 },
    );
    expect(await dispatcher.runOnce()).toBe(10);
    expect(peak).toBe(3);
    expect(store.recorded).toHaveLength(10);
  });

  it("prunes finished deliveries past the retention once per interval", async () => {
    const store = new MemoryStore();
    const { dispatcher, advance } = dispatcherWith(store, async () => ({
      status: 200,
      body: "",
      retryAfter: null,
    }));
    await dispatcher.pruneIfDue();
    await dispatcher.pruneIfDue();
    expect(store.pruned).toEqual([new Date(NOW.getTime() - 30 * 24 * HOUR)]);
    advance(HOUR);
    await dispatcher.pruneIfDue();
    expect(store.pruned).toHaveLength(2);
  });

  it("polls until stopped", async () => {
    const store = new MemoryStore();
    store.add();
    let calls = 0;
    const { dispatcher } = dispatcherWith(
      store,
      async () => {
        calls += 1;
        return { status: 200, body: "", retryAfter: null };
      },
      undefined,
      { pollIntervalMs: 10 },
    );
    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    store.add();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dispatcher.stop();
    expect(calls).toBe(2);
  });

  it("never delivers when disabled (demo mode): start() does not poll", async () => {
    const store = new MemoryStore();
    store.add();
    let calls = 0;
    const { dispatcher } = dispatcherWith(
      store,
      async () => {
        calls += 1;
        return { status: 200, body: "", retryAfter: null };
      },
      undefined,
      { pollIntervalMs: 10 },
      true,
    );
    dispatcher.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await dispatcher.stop();
    expect(calls).toBe(0);
  });
});

describe("isDemoModeEnabled", () => {
  it("is off by default and on only for 'true' (case-insensitive)", () => {
    expect(isDemoModeEnabled({})).toBe(false);
    expect(isDemoModeEnabled({ RESTOW_DEMO: "false" })).toBe(false);
    expect(isDemoModeEnabled({ RESTOW_DEMO: "yes" })).toBe(false);
    expect(isDemoModeEnabled({ RESTOW_DEMO: "true" })).toBe(true);
    expect(isDemoModeEnabled({ RESTOW_DEMO: "TRUE" })).toBe(true);
    expect(isDemoModeEnabled({ RESTOW_DEMO: " true " })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Postgres store
// ---------------------------------------------------------------------------

const adminUrl = process.env.RESTOW_TEST_DATABASE_URL;
const TEST_DB = "restow_worker_webhooks_test";

async function recreateTestDatabase(base: string): Promise<string> {
  const admin = createDb(base);
  try {
    await admin.$client.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.$client.query(`CREATE DATABASE ${TEST_DB}`);
  } finally {
    await admin.$client.end();
  }
  const url = new URL(base);
  url.pathname = `/${TEST_DB}`;
  await runMigrations(url.toString());
  return url.toString();
}

describe.skipIf(!adminUrl)("webhook deliveries against Postgres", () => {
  let db: Database;
  let tenantId: string;
  let subscribed: string;
  let other: string;

  beforeAll(async () => {
    db = createDb(await recreateTestDatabase(adminUrl as string));
    // The forced DROP DATABASE in afterAll waits for this pool's connections to
    // close (testing/database.ts); one it still terminates surfaces as an "error"
    // event on the ended pool and would fail the run although every test passed.
    // Only that termination is ignored; any other error is rethrown, and a
    // failing query still rejects its own promise.
    db.$client.on("error", ignoreTerminatedConnection);
    const [provider] = await db.insert(providers).values({ name: "Provider" }).returning();
    const [tenant] = await db
      .insert(tenants)
      .values({ providerId: provider?.id ?? "", name: "Contoso", slug: "contoso" })
      .returning();
    tenantId = tenant?.id ?? "";
    // The sealed secret itself is the API's business; these tests open it with a stub.
    const [secret] = await db
      .insert(secrets)
      .values({ tenantId, kind: "webhook_signing_secret", ciphertext: "sealed-elsewhere" })
      .returning();
    const rows = await db
      .insert(webhooks)
      .values([
        {
          tenantId,
          url: "https://a.example/hook",
          events: ["job.failed", "job.completed"],
          secretRef: secret?.id ?? null,
        },
        { tenantId, url: "https://b.example/hook", events: ["verify.completed"] },
        { tenantId, url: "https://c.example/hook", events: ["job.failed"], active: false },
      ])
      .returning();
    subscribed = rows[0]?.id ?? "";
    other = rows[1]?.id ?? "";
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    if (adminUrl) {
      await dropTestDatabase(adminUrl, TEST_DB);
    }
  });

  it("emits job events to subscribed, active webhooks", async () => {
    const emitted = await emitJobWebhook(db, tenantId, {
      id: randomUUID(),
      queue: "backup",
      status: "failed",
      protectedObjectId: null,
      startedAt: NOW,
      completedAt: NOW,
      errorMessage: "boom",
    });
    expect(emitted?.deliveryIds).toHaveLength(1);
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, emitted?.deliveryIds[0] ?? ""));
    expect(row).toMatchObject({ webhookId: subscribed, event: "job.failed", status: "pending" });
    expect(row?.payload).toMatchObject({ id: emitted?.eventId, version: 1, tenantId });
    expect(
      await emitJobWebhook(db, tenantId, {
        id: randomUUID(),
        queue: "backup",
        status: "cancelled",
        protectedObjectId: null,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
      }),
    ).toBeNull();
    // A tenant without a subscribed webhook gets no deliveries.
    const none = await emitWebhookEvent(db, {
      tenantId: randomUUID(),
      event: "job.completed",
      data: {},
    });
    expect(none.deliveryIds).toEqual([]);
  });

  it("claims each due delivery once, leases it, records and prunes", async () => {
    await db.delete(webhookDeliveries);
    await emitWebhookEvent(db, { tenantId, event: "verify.completed", data: {} });
    await emitWebhookEvent(db, { tenantId, event: "job.completed", data: {} });
    const store = new PgDeliveryStore(db);
    const now = new Date();
    const lease = new Date(now.getTime() + 2 * MINUTE);
    const [first, second] = await Promise.all([
      store.claimDue(now, 10, lease),
      store.claimDue(now, 10, lease),
    ]);
    const claimed = [...(first ?? []), ...(second ?? [])];
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((item) => item.id)).size).toBe(2);
    expect(await store.claimDue(now, 10, lease)).toEqual([]);

    const due = claimed[0] as DueDelivery;
    const loaded = await store.load(due);
    expect(loaded).toMatchObject({ tenantId, active: true, attempts: 0 });
    expect([subscribed, other]).toContain(loaded?.webhookId);

    const plan = planAfterAttempt({ attemptsBefore: 0, failure: null, now });
    await store.record(due, plan, now);
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, due.id));
    expect(row).toMatchObject({ status: "delivered", attempts: 1, nextAttemptAt: null });

    // After the lease the unrecorded one is due again.
    expect(await store.claimDue(new Date(lease.getTime() + 1), 10, lease)).toHaveLength(1);

    expect(await store.prune(new Date(now.getTime() - HOUR))).toBe(0);
    expect(await store.prune(new Date(Date.now() + HOUR))).toBe(1);
  });

  it("delivers end to end through the real store and transport", async () => {
    await db.delete(webhookDeliveries);
    let received: { headers: IncomingMessage["headers"]; body: string } | null = null;
    const { server, url } = await startServer((req, res, body) => {
      received = { headers: req.headers, body };
      res.writeHead(200);
      res.end("ok");
    });
    try {
      await db
        .update(webhooks)
        .set({ url: `${url}/hook` })
        .where(eq(webhooks.id, subscribed));
      const emitted = await emitWebhookEvent(db, {
        tenantId,
        event: "job.completed",
        data: { job: { id: "j-9" } },
      });
      const dispatcher = new WebhookDispatcher(
        {
          store: new PgDeliveryStore(db),
          secrets: async () => "whsec_e2e",
          transport: createHttpTransport({ allowPrivateNetworks: true }),
          logger: silentLogger,
          now: () => new Date(),
        },
        DEFAULT_WEBHOOK_OPTIONS,
      );
      expect(await dispatcher.runOnce()).toBe(1);
      const got = received as unknown as { headers: IncomingMessage["headers"]; body: string };
      expect(JSON.parse(got.body)).toMatchObject({ id: emitted.eventId, event: "job.completed" });
      expect(got.headers["x-restow-signature"]).toBe(signWebhookBody("whsec_e2e", got.body));
      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, emitted.deliveryIds[0] ?? ""));
      expect(row).toMatchObject({ status: "delivered", attempts: 1, lastError: null });
      expect(row?.deliveredAt).toBeInstanceOf(Date);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("renders a chat webhook in the tenant's language with a link to the public URL", async () => {
    await db.delete(webhookDeliveries);
    await db.update(tenants).set({ language: "de" }).where(eq(tenants.id, tenantId));
    await db.insert(settings).values({ publicUrl: "https://backup.example.com" });
    await db.update(webhooks).set({ format: "slack" }).where(eq(webhooks.id, other));
    try {
      const emitted = await emitWebhookEvent(db, {
        tenantId,
        event: "verify.completed",
        data: { readiness: "red", objectName: "Fileserver", reportId: "rep-1", checked: 3 },
      });
      expect(emitted.deliveryIds).toHaveLength(1);
      const store = new PgDeliveryStore(db);
      const loaded = await store.load({ id: emitted.deliveryIds[0] ?? "", tenantId });
      expect(loaded).toMatchObject({ format: "slack", secretRef: null });
      expect(await pgChatContextSource(db, {})(loaded as LoadedDelivery)).toEqual({
        language: "de",
        tenantName: "Contoso",
        publicUrl: "https://backup.example.com",
        objectName: null,
      });
      const sent: WebhookHttpRequest[] = [];
      const dispatcher = new WebhookDispatcher(
        {
          store,
          secrets: async () => {
            throw new Error("a chat webhook needs no secret");
          },
          chatContext: pgChatContextSource(db, {}),
          transport: async (request) => {
            sent.push(request);
            return { status: 200, body: "ok", retryAfter: null };
          },
          logger: silentLogger,
          now: () => new Date(),
        },
        DEFAULT_WEBHOOK_OPTIONS,
      );
      expect(await dispatcher.runOnce()).toBe(1);
      const [request] = sent;
      expect(request?.headers["X-Restow-Signature"]).toBeUndefined();
      const body = JSON.parse(request?.body ?? "{}");
      expect(body.blocks[0].text.text).toContain("Restore-Prüfung nicht bestanden: Fileserver");
      expect(JSON.stringify(body)).toContain(
        "<https://backup.example.com/verify/reports/rep-1|In Restow öffnen>",
      );
      const [row] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, emitted.deliveryIds[0] ?? ""));
      expect(row).toMatchObject({ status: "delivered", attempts: 1 });
      // The log keeps the envelope.
      expect(row?.payload).toMatchObject({ event: "verify.completed", tenantId });
    } finally {
      await db.update(webhooks).set({ format: "restow" }).where(eq(webhooks.id, other));
      await db.delete(settings);
      await db.update(tenants).set({ language: null }).where(eq(tenants.id, tenantId));
    }
  });
});
