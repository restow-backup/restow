import { describe, expect, it } from "vitest";
import { shippedMigrationCount } from "./migrate.js";
import { nodeHold } from "./node-guard.js";
import type { Queryable } from "./roles.js";

/**
 * When a process on a worker node must not work (node-guard.ts): the database is newer than its
 * image, or an update to another release was handed to the updater; an update to its own
 * release, a pause that only drains, and no pause at all leave it working.
 */

function database(options: {
  readonly applied: number;
  readonly pause?: { phase: string; version: string } | null;
}): Queryable {
  return {
    async query<R extends Record<string, unknown>>(text: string) {
      if (text.includes("to_regclass('drizzle.__drizzle_migrations')")) {
        return { rows: [{ present: true }] as unknown as R[] };
      }
      if (text.includes("FROM drizzle.__drizzle_migrations")) {
        return { rows: [{ count: String(options.applied) }] as unknown as R[] };
      }
      if (text.includes("FROM job_start_pause")) {
        return {
          rows: (options.pause ? [{ mode: "wait", ...options.pause }] : []) as unknown as R[],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

describe("nodeHold", () => {
  const shipped = shippedMigrationCount();

  it("holds a node whose image is older than the database", async () => {
    expect(await nodeHold(database({ applied: shipped + 1 }), "0.5.0")).toMatchObject({
      reason: "version_mismatch",
      applied: shipped + 1,
      shipped,
    });
  });

  it("holds a node of the old release while an update to another one runs", async () => {
    for (const phase of ["announced", "fleet"]) {
      expect(
        await nodeHold(database({ applied: shipped, pause: { phase, version: "0.5.1" } }), "0.5.0"),
      ).toMatchObject({ reason: "update_announced", updateTo: "0.5.1" });
    }
  });

  it("leaves a node working otherwise", async () => {
    expect(await nodeHold(database({ applied: shipped }), "0.5.0")).toBeNull();
    expect(await nodeHold(database({ applied: shipped - 1 }), "0.5.0")).toBeNull();
    // Updated first: the node runs the release being installed.
    expect(
      await nodeHold(
        database({ applied: shipped, pause: { phase: "announced", version: "v0.5.1" } }),
        "0.5.1",
      ),
    ).toBeNull();
    // Running jobs (also the node's) are still being waited for.
    expect(
      await nodeHold(
        database({ applied: shipped, pause: { phase: "draining", version: "0.5.1" } }),
        "0.5.0",
      ),
    ).toBeNull();
  });
});
