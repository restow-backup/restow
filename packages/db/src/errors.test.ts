import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { DrizzleQueryError, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reportableError, safeErrorMessage, withoutQueryText } from "./errors.js";
import { type Database, createDb } from "./index.js";
import { session } from "./schema/index.js";

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

describe("a failed query against an unreachable database", () => {
  // A throwaway value standing in for a session token; the point is to see
  // whether it travels from the bound parameters into the reported error.
  const token = `token-under-test-${randomBytes(12).toString("hex")}`;
  let db: Database;
  let failure: unknown;

  beforeAll(async () => {
    db = createDb(`postgres://restow:unused@127.0.0.1:${await closedPort()}/restow`);
    failure = await db
      .select({ id: session.id })
      .from(session)
      .where(eq(session.token, token))
      .then(
        () => null,
        (error: unknown) => error,
      );
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("is thrown by Drizzle with the SQL text and the bound token in its message", () => {
    // This is the hazard the helpers exist for.
    expect(failure).toBeInstanceOf(DrizzleQueryError);
    expect((failure as Error).message).toContain("Failed query");
    expect((failure as Error).message).toContain(token);
  });

  it("is reported as the driver error, without query text or parameters", () => {
    const reportable = reportableError(failure);
    expect(reportable).toBe((failure as Error).cause);
    const message = safeErrorMessage(failure);
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain(token);
    expect(message).not.toContain("Failed query");
    expect(message).not.toContain("select");
  });
});

describe("reportableError", () => {
  const driverError = Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });

  it("returns the cause of a failed query", () => {
    const failure = new DrizzleQueryError(
      "insert into t values ($1)",
      ["secret-value"],
      driverError,
    );
    expect(reportableError(failure)).toBe(driverError);
  });

  it("stands in a generic error for a failed query without a cause", () => {
    const failure = new DrizzleQueryError("select 1 where x = $1", ["secret-value"]);
    const reportable = reportableError(failure);
    expect(reportable).toBeInstanceOf(Error);
    expect((reportable as Error).message).toBe("database query failed");
  });

  it("unwraps a failed query nested in another failed query", () => {
    const inner = new DrizzleQueryError("select $1", ["inner-secret"], driverError);
    const outer = new DrizzleQueryError("select $1", ["outer-secret"], inner);
    expect(reportableError(outer)).toBe(driverError);
  });

  it("recognises the failed-query shape from another copy of drizzle-orm", () => {
    const foreign = Object.assign(new Error("Failed query: select $1\nparams: foreign-secret"), {
      query: "select $1",
      params: ["foreign-secret"],
      cause: driverError,
    });
    expect(reportableError(foreign)).toBe(driverError);
  });

  it("passes every other error and value through unchanged", () => {
    const plain = new Error("storage target unreachable");
    expect(reportableError(plain)).toBe(plain);
    expect(reportableError("text")).toBe("text");
    expect(reportableError(undefined)).toBeUndefined();
  });
});

describe("safeErrorMessage", () => {
  it("gives the driver message of a failed query", () => {
    const failure = new DrizzleQueryError(
      "update jobs set state = $1",
      ["secret-state"],
      new Error("connection terminated unexpectedly"),
    );
    expect(safeErrorMessage(failure)).toBe("connection terminated unexpectedly");
  });

  it("keeps ordinary messages and stringifies non-errors", () => {
    expect(safeErrorMessage(new Error("webhook endpoint answered 500"))).toBe(
      "webhook endpoint answered 500",
    );
    expect(safeErrorMessage(42)).toBe("42");
  });

  it("cuts query text out of a message that embeds one", () => {
    const wrapped = new Error("prune failed: Failed query: delete from t where id = $1\nparams: x");
    expect(safeErrorMessage(wrapped)).toBe("prune failed: database query failed");
  });
});

describe("withoutQueryText", () => {
  it("leaves a message without query text alone", () => {
    expect(withoutQueryText("relation does not exist")).toBe("relation does not exist");
  });

  it("replaces everything from the failed-query marker on", () => {
    expect(withoutQueryText("Failed query: select $1\nparams: secret")).toBe(
      "database query failed",
    );
  });
});
