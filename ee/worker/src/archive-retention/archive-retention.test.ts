import type { Database } from "@restow/db";
import { describe, expect, it, vi } from "vitest";
import type { WorkerJobContext } from "../../../../apps/worker/src/handlers/framework.js";
import { createArchiveRetentionTask } from "./archive-retention.js";

/** A providerDb whose `license` lookup returns no row, so the environment
 *  (community, unset in tests) applies and the capability is missing. */
function communityDb() {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => [],
          }),
        }),
      }),
    }),
  };
  return db as unknown as Database;
}

function fakeContext(): WorkerJobContext {
  return {
    tenantId: "tenant-1",
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    now: () => new Date("2026-06-01T00:00:00.000Z"),
    protectedObject: null,
  } as unknown as WorkerJobContext;
}

describe("createArchiveRetentionTask", () => {
  it("skips the run rather than deleting anything on an edition without the capability", async () => {
    const task = createArchiveRetentionTask(communityDb());
    const ctx = fakeContext();
    const result = await task.run(ctx, { dryRun: false });
    expect(result).toEqual({ skipped: true, reason: "edition_required" });
    expect(ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("skipped"),
      expect.objectContaining({ task: "archive" }),
    );
  });
});
