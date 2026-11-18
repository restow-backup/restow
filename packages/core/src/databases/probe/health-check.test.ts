import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkDatabaseHealthFromServer, type DbHealthCheckTarget } from "./health-check.js";

/**
 * The server's health check (docs/DATABASES.md 8, 10): one overall deadline that closes every
 * socket, and the network protection before any connection.
 */

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function target(overrides: Partial<DbHealthCheckTarget> = {}): DbHealthCheckTarget {
  return {
    engine: "postgresql",
    host: "127.0.0.1",
    port: 5432,
    database: null,
    user: "restow_backup",
    password: "s3cret-pass",
    allowUnencrypted: false,
    pinnedFingerprintSha256: null,
    sizes: false,
    ...overrides,
  };
}

describe("the server's health check [DB-004]", () => {
  it("ends at its deadline and closes the socket of a server that never answers", {
    timeout: 40_000,
  }, async () => {
    const closed: Promise<void>[] = [];
    const server = createServer((socket: Socket) => {
      socket.on("error", () => undefined);
      // Read and drop what the check sends, never answer.
      socket.resume();
      closed.push(new Promise((resolve) => socket.once("close", () => resolve())));
    });
    servers.push(server);
    const port = await new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : 0);
      }),
    );
    // Every step may wait a minute: only the deadline of one second can end the check.
    const started = Date.now();
    const result = await checkDatabaseHealthFromServer(target({ port }), {
      allowPrivateNetworks: true,
      approvedAddresses: [],
      forbiddenTargets: [],
      timeoutSeconds: 1,
      stepTimeoutMs: 60_000,
    });
    const elapsed = Date.now() - started;
    // The deadline's own answer (a step's timeout would name the address it waited for).
    expect(result).toMatchObject({
      login: "skipped",
      error: { code: "db_unreachable", message: "the probe did not finish in time" },
    });
    // Not before the deadline (nothing else ended it), and long before any step could have:
    // a slow machine may take a while, the bound only rules out the step timeout.
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(30_000);
    // Every socket the check opened is closed by the server's side too.
    expect(closed.length).toBeGreaterThan(0);
    await Promise.all(closed);
  });

  it("refuses loopback and reserved addresses before connecting", async () => {
    const none = { allowPrivateNetworks: false, approvedAddresses: [], forbiddenTargets: [] };
    expect((await checkDatabaseHealthFromServer(target(), none)).error?.code).toBe(
      "db_private_network",
    );
    expect(
      (
        await checkDatabaseHealthFromServer(target({ host: "169.254.169.254" }), {
          ...none,
          allowPrivateNetworks: true,
        })
      ).error?.code,
    ).toBe("db_forbidden_address");
    expect(
      (await checkDatabaseHealthFromServer(target({ host: "localhost" }), none)).error?.code,
    ).toBe("db_private_network");
  });
});
