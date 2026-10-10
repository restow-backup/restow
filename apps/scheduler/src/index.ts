// Restow scheduler entrypoint (Docker CMD role: scheduler).
//
// One process per installation should act at a time. Leadership is enforced by a
// Postgres advisory lock, so several replicas can run for redundancy while only
// the elected leader enqueues due jobs onto pg-boss. Shutdown is graceful:
// finish the in-flight tick, release the lock, drain the queue client, close the
// pools. The process refuses to start when its application pool could bypass
// Row Level Security (packages/db/src/roles.ts).

import {
  ServiceHeartbeatReporter,
  assertDatabaseRoles,
  createDb,
  heartbeatStore,
  retryConcurrentSetup,
  safeErrorMessage,
} from "@restow/db";
import PgBoss from "pg-boss";
import { loadConfig } from "./config.js";
import { ENDPOINT_QUEUE_OPTIONS, EndpointJobPlanner } from "./endpoints.js";
import { FILE_SHARE_QUEUE_OPTIONS, FileShareJobPlanner } from "./file-shares.js";
import { LeaderElection } from "./leader.js";
import { errorMessage, logger } from "./logger.js";
import { JOB_QUEUES, pgBossQueueOptions } from "./queues.js";
import { ReportRuleStore } from "./reports.js";
import { SchedulerLoop } from "./scheduler.js";
import { ScheduleStore } from "./store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info("scheduler starting", {
    tickIntervalMs: config.tickIntervalMs,
    leaderRetryIntervalMs: config.leaderRetryIntervalMs,
    defaultTimezone: config.defaultTimezone,
  });

  const db = createDb(config.databaseUrl);
  const providerDb = createDb(config.databaseProviderUrl);
  await assertDatabaseRoles({ tenant: db.$client, installation: providerDb.$client });

  // pg-boss owns its schema as the installation role (like the worker's instance).
  const boss = new PgBoss({ connectionString: config.databaseProviderUrl });
  boss.on("error", (err) => logger.error("pg-boss error", { err: errorMessage(err) }));
  // The worker sets up the same schema and queues at the same time on a fresh
  // installation; a conflict between the two is retried, not fatal.
  const onSetupRetry = (info: { attempt: number; code: string | null; delayMs: number }) =>
    logger.info("job queue setup raced with another process, retrying", info);
  await retryConcurrentSetup(() => boss.start(), { onRetry: onSetupRetry });
  // Same definitions as the worker (policy, retries, expiry): whichever role
  // starts first creates the queue correctly, updateQueue keeps it current.
  for (const queue of JOB_QUEUES) {
    const options = pgBossQueueOptions(queue);
    await retryConcurrentSetup(
      async () => {
        await boss.createQueue(queue, options);
        await boss.updateQueue(queue, options);
      },
      { onRetry: onSetupRetry },
    );
  }
  logger.info("job queues ready", { queues: [...JOB_QUEUES] });
  // The endpoint backup queues (docs/AGENT.md) and the file share queues (docs/FILESHARES.md
  // 8.1): the worker creates the same ones.
  for (const options of [
    ...Object.values(ENDPOINT_QUEUE_OPTIONS),
    ...Object.values(FILE_SHARE_QUEUE_OPTIONS),
  ]) {
    await retryConcurrentSetup(
      async () => {
        await boss.createQueue(options.name, options);
        await boss.updateQueue(options.name, options);
      },
      { onRetry: onSetupRetry },
    );
  }

  const loop = new SchedulerLoop({
    store: new ScheduleStore({ tenant: db.$client, installation: providerDb.$client }),
    boss,
    tickIntervalMs: config.tickIntervalMs,
    batchSize: config.batchSize,
    deferMs: config.deferMs,
    // Tenants with a first active source get the recommended schedules once.
    recommendedDefaults: { timezone: config.defaultTimezone },
    // Time-triggered report rules queue their deliveries here; the API sends them.
    reports: new ReportRuleStore({ tenant: db.$client, installation: providerDb.$client }),
    // Retention, check and restore tests of endpoint repositories, queued for the worker.
    endpoints: new EndpointJobPlanner({ installation: providerDb.$client }, boss),
    // Backups, copies and maintenance of file shares, queued for the worker.
    fileShares: new FileShareJobPlanner({ installation: providerDb.$client }, boss),
    // Read leadership lazily; `election` is initialised just below and the tick
    // that calls this only runs after startup completes.
    isLeader: () => election.isLeader(),
  });

  const election = new LeaderElection({
    connectionString: config.databaseProviderUrl,
    lockKey: config.advisoryLockKey,
    retryIntervalMs: config.leaderRetryIntervalMs,
    onChange: (isLeader) => {
      if (isLeader) {
        logger.info("this instance is now the scheduler leader");
        loop.start();
      } else {
        logger.warn("this instance is no longer the scheduler leader");
      }
    },
  });

  // Liveness for /readyz: every instance reports, the leader or a stand-by
  // (docs/ARCHITECTURE.md, Health). Removed again on a graceful shutdown.
  let shuttingDown = false;
  const heartbeat = new ServiceHeartbeatReporter({
    store: heartbeatStore(db),
    role: "scheduler",
    details: () => {
      const leader = election.isLeader();
      return { state: shuttingDown ? "stopping" : leader ? "leader" : "standby", leader };
    },
    onError: (err) => logger.warn("heartbeat failed", { err: safeErrorMessage(err) }),
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("scheduler shutting down", { signal });
    try {
      await heartbeat.beat();
      await loop.stop();
      await election.stop();
      await boss.stop();
      await heartbeat.stop();
      await Promise.all([db.$client.end(), providerDb.$client.end()]);
    } catch (err) {
      logger.error("error during shutdown", { err: errorMessage(err) });
    } finally {
      logger.info("scheduler stopped");
      process.exit(0);
    }
  };

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, (received) => {
      void shutdown(received);
    });
  }

  await election.start();
  await heartbeat.start();
}

main().catch((err) => {
  logger.error("scheduler failed to start", { err: errorMessage(err) });
  process.exit(1);
});
