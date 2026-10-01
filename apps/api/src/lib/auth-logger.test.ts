import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { inspect } from "node:util";
import { DrizzleQueryError } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loggable, writeAuthLog } from "./auth-logger.js";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

interface CapturedLine {
  method: ConsoleMethod;
  text: string;
}

/** Record everything written through the console, rendered the way a terminal would show it. */
function captureConsole() {
  const lines: CapturedLine[] = [];
  const spies = CONSOLE_METHODS.map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      const text = args
        .map((arg) => (typeof arg === "string" ? arg : inspect(arg, { depth: 10 })))
        .join(" ");
      lines.push({ method, text });
    }),
  );
  return {
    lines,
    text: () => lines.map((line) => line.text).join("\n"),
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    },
  };
}

/** A loopback port nothing listens on: bound once by the OS, then released. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") {
    throw new Error("no port assigned");
  }
  return address.port;
}

/** A throwaway value standing in for a session token. */
function tokenUnderTest(): string {
  return `token-under-test-${randomBytes(12).toString("hex")}`;
}

function refusedConnection(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
    code: "ECONNREFUSED",
  });
}

describe("writeAuthLog", () => {
  const token = tokenUnderTest();
  const failure = new DrizzleQueryError(
    'select "id" from "session" where "session"."token" = $1',
    [token],
    refusedConnection(),
  );
  let output: ReturnType<typeof captureConsole>;

  beforeEach(() => {
    output = captureConsole();
  });

  afterEach(() => {
    output.restore();
  });

  it("writes a failed query as the driver error behind it", () => {
    writeAuthLog("error", "INTERNAL_SERVER_ERROR", failure);

    expect(output.lines).toHaveLength(1);
    expect(output.lines[0]?.method).toBe("error");
    const record = JSON.parse(output.lines[0]?.text ?? "");
    expect(record).toMatchObject({
      level: "error",
      component: "better-auth",
      message: "INTERNAL_SERVER_ERROR",
      details: [
        { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:5432", code: "ECONNREFUSED" },
      ],
    });
    expect(output.text()).not.toContain(token);
    expect(output.text()).not.toContain("Failed query");
  });

  it("cuts query text out of a logged message", () => {
    // better-auth's router logs `error.message` for some errors.
    writeAuthLog("error", failure.message);

    expect(JSON.parse(output.lines[0]?.text ?? "").message).toBe("database query failed");
    expect(output.text()).not.toContain(token);
  });

  it("takes an error logged in place of the message", () => {
    writeAuthLog("error", failure as unknown as string);

    const record = JSON.parse(output.lines[0]?.text ?? "");
    expect(record.message).toBe("connect ECONNREFUSED 127.0.0.1:5432");
    expect(record.details).toHaveLength(1);
    expect(output.text()).not.toContain(token);
  });

  it("follows an error that wraps a failed query", () => {
    writeAuthLog(
      "error",
      "Failed to run background task:",
      new Error("wrapped", { cause: failure }),
    );

    const record = JSON.parse(output.lines[0]?.text ?? "");
    expect(record.details[0]).toMatchObject({
      message: "wrapped",
      cause: { message: "connect ECONNREFUSED 127.0.0.1:5432" },
    });
    expect(output.text()).not.toContain(token);
  });

  it("writes warnings to stderr and information to stdout", () => {
    writeAuthLog("warn", "a warning");
    writeAuthLog("info", "a note");
    writeAuthLog("debug", "a detail");

    expect(output.lines.map((line) => line.method)).toEqual(["error", "log", "log"]);
  });
});

describe("loggable", () => {
  it("redacts secret-named fields and reduces nested errors", () => {
    const token = tokenUnderTest();
    const value = loggable({
      token,
      user: { id: "u1", attempts: 2n, at: new Date("2026-01-01T00:00:00.000Z") },
      failures: [new DrizzleQueryError("select $1", [token], refusedConnection())],
      body: Buffer.from("abc"),
    });

    expect(value).toEqual({
      token: "[redacted]",
      user: { id: "u1", attempts: "2", at: "2026-01-01T00:00:00.000Z" },
      failures: [
        { name: "Error", message: "connect ECONNREFUSED 127.0.0.1:5432", code: "ECONNREFUSED" },
      ],
      body: "<3 bytes>",
    });
  });

  it("stops at a bounded depth, so a cyclic value still serialises", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;

    expect(() => JSON.stringify(loggable(cyclic))).not.toThrow();
  });
});

describe("better-auth on an unreachable database", () => {
  const token = tokenUnderTest();
  const secret = randomBytes(32).toString("base64url");
  let auth: typeof import("../auth.js")["auth"];
  let sessionCookie: string;
  let output: ReturnType<typeof captureConsole>;

  beforeAll(async () => {
    // The API's configuration and pools are read on import: point both pools at
    // a port where nothing listens, so every query fails like in an outage.
    const unreachable = `postgres://restow:unused@127.0.0.1:${await closedPort()}/restow`;
    vi.stubEnv("DATABASE_URL", unreachable);
    vi.stubEnv("DATABASE_PROVIDER_URL", unreachable);
    vi.stubEnv("BETTER_AUTH_SECRET", secret);
    vi.stubEnv("RESTOW_PUBLIC_URL", "http://localhost:3000");
    ({ auth } = await import("../auth.js"));

    // A session cookie signed the way better-auth signs it, so the lookup
    // reaches the database instead of failing the signature check.
    const context = await auth.$context;
    const signature = createHmac("sha256", secret).update(token).digest("base64");
    sessionCookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${token}.${signature}`)}`;
  });

  afterAll(async () => {
    const { db, providerDb } = await import("../db.js");
    await Promise.all([db.$client.end(), providerDb.$client.end()]);
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    output = captureConsole();
  });

  afterEach(() => {
    output.restore();
  });

  it("logs a failed getSession without the session token or the query", async () => {
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) }),
    ).rejects.toThrow();

    const text = output.text();
    // Something was logged, and it names the actual cause.
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain(token);
    expect(text).not.toContain("Failed query");
  });

  it("answers the get-session endpoint with a 500 and logs no token or query", async () => {
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: sessionCookie },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(token);
    const text = output.text();
    expect(text).toContain("ECONNREFUSED");
    expect(text).not.toContain(token);
    expect(text).not.toContain("Failed query");
  });
});
