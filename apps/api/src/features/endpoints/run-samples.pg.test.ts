/**
 * The throughput history of the runs an agent reports, against Postgres: the measurement taken
 * with every progress report, what the machine transferred (how much its repository grew since
 * the run began), the final point at the end of the run, and the bound on the history. These
 * tests need no restic: the machine is a row and the agent is the service.
 *
 * Runs when RESTOW_TEST_DATABASE_URL points at a Postgres server as a superuser.
 */
import { randomUUID } from "node:crypto";
import { defaultEndpointConfig } from "@restow/core";
import { endpointRuns, endpoints, runSamples } from "@restow/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixture, testDatabaseAdminUrl } from "./testing/fixture.js";
import type { EndpointFixture } from "./testing/fixture.js";

type AgentService = typeof import("./agent-service.js");

const DATABASE = "restow_api_run_samples_test";
const SNAPSHOT = "a1".repeat(32);

describe.skipIf(!testDatabaseAdminUrl)("run samples of agent runs against Postgres", () => {
  let fixture: EndpointFixture;
  let agentService: AgentService;

  beforeAll(async () => {
    fixture = await startFixture(DATABASE);
    agentService = await import("./agent-service.js");
  }, 90_000);

  afterAll(async () => {
    await fixture?.cleanup();
  });

  async function machine(values: Partial<typeof endpoints.$inferInsert> = {}) {
    const [row] = await fixture.db
      .insert(endpoints)
      .values({
        tenantId: fixture.tenantId,
        hostname: `srv-${randomUUID().slice(0, 6)}`,
        os: "linux",
        arch: "amd64",
        profile: "server",
        secretHash: randomUUID(),
        config: defaultEndpointConfig("linux", "server", { timeZone: "Europe/Berlin" }),
        ...values,
      })
      .returning();
    const id = row?.id ?? "";
    return {
      id,
      agent: {
        endpointId: id,
        tenantId: fixture.tenantId,
        hostname: row?.hostname ?? "",
        profile: "server" as const,
        os: "linux" as const,
        ip: null,
      },
    };
  }

  const setRepositoryBytes = (id: string, bytes: number | null) =>
    fixture.db.update(endpoints).set({ repositoryBytes: bytes }).where(eq(endpoints.id, id));

  const samplesOf = async (runId: string) => {
    const [row] = await fixture.db
      .select()
      .from(runSamples)
      .where(eq(runSamples.endpointRunId, runId));
    return row;
  };

  const t0 = new Date("2026-10-02T10:00:00.000Z");
  const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

  it("measures what a machine transferred by how much its repository grew since the run began", async () => {
    const { id, agent } = await machine({ repositoryBytes: 5_000_000, lastBackupAt: t0 });
    const { runId } = await agentService.startRun(
      agent,
      { kind: "backup", startedAt: t0.toISOString() },
      t0,
    );
    expect((await samplesOf(runId))?.baselineBytes).toBe(5_000_000);

    // The agent uploads through the REST route, which keeps the repository's size current.
    await setRepositoryBytes(id, 5_300_000);
    await agentService.reportProgress(agent, runId, { filesDone: 10, bytesDone: 2_000_000 }, at(5));
    await setRepositoryBytes(id, 5_900_000);
    await agentService.reportProgress(
      agent,
      runId,
      { filesDone: 30, bytesDone: 6_000_000 },
      at(10),
    );
    expect((await samplesOf(runId))?.points).toEqual([
      [t0.getTime(), 0, 0],
      [at(5).getTime(), 2_000_000, 300_000],
      [at(10).getTime(), 6_000_000, 900_000],
    ]);

    // The end of the run adds the final counters, and the history stays after the run.
    await agentService.finishRun(
      agent,
      runId,
      {
        status: "succeeded",
        finishedAt: at(12).toISOString(),
        snapshotId: SNAPSHOT,
        stats: { totalBytesProcessed: 8_000_000, filesNew: 3 },
        errors: [],
        logTail: "",
      } as never,
      at(12),
    );
    const points = (await samplesOf(runId))?.points ?? [];
    expect(points).toHaveLength(4);
    expect(points[3]).toEqual([at(12).getTime(), 8_000_000, 900_000]);
    const [run] = await fixture.db.select().from(endpointRuns).where(eq(endpointRuns.id, runId));
    expect(run?.status).toBe("succeeded");
  }, 30_000);

  it("never reports a negative transfer when the repository shrank (retention ran meanwhile)", async () => {
    const { id, agent } = await machine({ repositoryBytes: 9_000_000, lastBackupAt: t0 });
    const { runId } = await agentService.startRun(
      agent,
      { kind: "backup", startedAt: t0.toISOString() },
      t0,
    );
    await setRepositoryBytes(id, 4_000_000);
    await agentService.reportProgress(agent, runId, { filesDone: 1, bytesDone: 500 }, at(5));
    const points = (await samplesOf(runId))?.points ?? [];
    expect(points[points.length - 1]).toEqual([at(5).getTime(), 500, 0]);
  }, 30_000);

  it("starts from zero for a machine that never backed up, and from the first measurement otherwise", async () => {
    const fresh = await machine();
    const first = await agentService.startRun(
      fresh.agent,
      { kind: "backup", startedAt: t0.toISOString() },
      t0,
    );
    // A new machine has a new, empty repository.
    expect((await samplesOf(first.runId))?.baselineBytes).toBe(0);

    // A machine with backups but a repository nobody measured yet: unknown at the start ...
    const known = await machine({ lastBackupAt: t0, repositoryBytes: null });
    const second = await agentService.startRun(
      known.agent,
      { kind: "backup", startedAt: t0.toISOString() },
      t0,
    );
    expect((await samplesOf(second.runId))?.baselineBytes).toBeNull();
    // ... so what the first report finds is where it counts from: nothing transferred yet.
    await setRepositoryBytes(known.id, 80_000_000);
    await agentService.reportProgress(
      known.agent,
      second.runId,
      { filesDone: 1, bytesDone: 1000 },
      at(5),
    );
    const row = await samplesOf(second.runId);
    expect(row?.baselineBytes).toBe(80_000_000);
    expect(row?.points[row.points.length - 1]).toEqual([at(5).getTime(), 1000, 0]);
  }, 30_000);

  it("keeps the history of a run bounded, from its start to its newest point", async () => {
    const { agent } = await machine({ repositoryBytes: 1, lastBackupAt: t0 });
    const { runId } = await agentService.startRun(
      agent,
      { kind: "backup", startedAt: t0.toISOString() },
      t0,
    );
    for (let step = 1; step <= 340; step++) {
      await agentService.reportProgress(
        agent,
        runId,
        { filesDone: step, bytesDone: step * 1000 },
        at(step * 5),
      );
    }
    const points = (await samplesOf(runId))?.points ?? [];
    expect(points.length).toBeLessThanOrEqual(300);
    expect(points[0]).toEqual([t0.getTime(), 0, 0]);
    expect(points[points.length - 1]?.[1]).toBe(340_000);
  }, 60_000);

  it("refuses progress for a run that ended, and records no point for it", async () => {
    const { agent } = await machine({ lastBackupAt: t0 });
    const { runId } = await agentService.startRun(
      agent,
      { kind: "backup", startedAt: t0.toISOString() },
      t0,
    );
    await agentService.finishRun(
      agent,
      runId,
      {
        status: "failed",
        finishedAt: at(3).toISOString(),
        errors: [{ message: "boom" }],
        logTail: "",
      } as never,
      at(3),
    );
    const before = (await samplesOf(runId))?.points.length;
    await expect(
      agentService.reportProgress(agent, runId, { filesDone: 1, bytesDone: 1 }, at(9)),
    ).rejects.toMatchObject({ status: 404 });
    expect((await samplesOf(runId))?.points.length).toBe(before);
  }, 30_000);
});
