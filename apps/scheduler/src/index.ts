// Restow scheduler entrypoint (Docker CMD role: scheduler).
//
// One process per installation should act at a time. Leadership is enforced by a
// Postgres advisory lock, so several replicas can run for redundancy while only
// the elected leader enqueues due jobs onto pg-boss. Shutdown is graceful:
// finish the in-flight tick, release the lock, drain the queue client, close the
// pools. The process refuses to start when its application pool could bypass
// Row Level Security (packages/db/src/roles.ts).
//
// A standby scheduler on a worker node of another host (docs/SIZING.md) runs the node's image,
// which may be older than the main host's: it does not stand for election while the database is
// newer than its image or an update to another release is under way, and gives the leadership up
// (by stopping; it restarts into that wait) as soon as either holds (packages/db node-guard.ts).

import {
  assertDatabaseRoles,
  clearRestartRequests,
  createDb,
  grantQueueAccess,
  heartbeatStore,
  idleWhileHeld,
  nodeHold,
  nodeIdentity,
  readJobStartPause,
  retryConcurrentSetup,
  ServiceHeartbeatReporter,
  safeErrorMessage,
  serviceVersion,
  startNodeWatch,
} from "@restow/db";
import PgBoss from "pg-boss";
import { loadConfig } from "./config.js";
import { ENDPOINT_QUEUE_OPTIONS, EndpointJobPlanner } from "./endpoints.js";
import { FILE_SHARE_QUEUE_OPTIONS, FileShareJobPlanner } from "./file-shares.js";
import { LeaderElection } from "./leader.js";
import { errorMessage, logger } from "./logger.js";
import { LoginProbePlanner } from "./login-probes.js";
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

  const db = createDb(config.databaseUrl, { max: config.dbPool.app });
  const providerDb = createDb(config.databaseProviderUrl, { max: config.dbPool.installation });
  const roles = await assertDatabaseRoles({ tenant: db.$client, installation: providerDb.$client });
  // On a worker node: no election while the node is held (node-guard.ts), not even pg-boss.
  const node = nodeIdentity();
  const ownVersion = serviceVersion();
  if (node.nodeId) {
    const hold = await nodeHold(providerDb.$client, ownVersion);
    if (hold) {
      logger.warn("this node's scheduler stands by without election until the hold is gone", {
        reason: hold.reason,
        applied: hold.applied,
        shipped: hold.shipped,
        updateTo: hold.updateTo,
      });
      const idle = new ServiceHeartbeatReporter({
        store: heartbeatStore(providerDb),
        role: "scheduler",
        details: () => ({ state: hold.reason, leader: false }),
      });
      await idle.start();
      await idleWhileHeld({
        check: () => nodeHold(providerDb.$client, ownVersion),
        beat: () => idle.beat(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      await idle.stop();
    }
  }
  // This process has just started, so the restart requests recorded for its role are
  // followed (packages/db restart-requests.ts); cleared before it does any work of its own.
  try {
    await clearRestartRequests(providerDb, "scheduler");
  } catch (error) {
    logger.warn("the restart requests for the scheduler could not be cleared", {
      err: safeErrorMessage(error),
    });
  }

  // pg-boss owns its schema as the installation role (like the worker's instance).
  const boss = new PgBoss({
    connectionString: config.databaseProviderUrl,
    max: config.dbPool.queue,
  });
  boss.on("error", (err) => logger.error("pg-boss error", { err: errorMessage(err) }));
  // The worker sets up the same schema and queues at the same time on a fresh
  // installation; a conflict between the two is retried, not fatal.
  const onSetupRetry = (info: { attempt: number; code: string | null; delayMs: number }) =>
    logger.info("job queue setup raced with another process, retrying", info);
  await retryConcurrentSetup(() => boss.start(), { onRetry: onSetupRetry });
  // pg-boss has just created or upgraded its schema: the application role gets
  // its enqueue-only access to it (again; packages/db roles.ts).
  await grantQueueAccess(providerDb.$client, roles.tenant.name);
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
    // The weekly login probe of IMAP accounts an admin confirmed as shut down.
    loginProbes: new LoginProbePlanner(
      { tenant: db.$client, installation: providerDb.$client },
      boss,
    ),
    // Read leadership lazily; `election` is initialised just below and the tick
    // that calls this only runs after startup completes.
    isLeader: () => election.isLeader(),
    // An update pauses new job starts while it waits for running jobs (#46).
    startsPaused: async () => (await readJobStartPause(providerDb.$client)).paused,
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
    // Installation-level (packages/db roles.ts): the installation pool.
    store: heartbeatStore(providerDb),
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

  // The heartbeat first: its start comes before the first tick queues anything, so a restore
  // mode detected later holds only jobs from before this process (packages/db restore-mode.ts
  // `detectedHoldBoundary`).
  await heartbeat.start();
  // On a node, the hold is asked before every election and now and then while running: the lock
  // is never taken or kept while the database is newer than this image or an update runs.
  if (node.nodeId && (await nodeHold(providerDb.$client, ownVersion))) {
    logger.warn("this node's scheduler is held; stopping before the election");
    await shutdown("SIGTERM");
    return;
  }
  await election.start();
  if (node.nodeId) {
    startNodeWatch({
      check: () => nodeHold(providerDb.$client, ownVersion),
      onHold: (hold) => {
        logger.warn("this node's scheduler is held; giving up leadership and stopping", {
          reason: hold.reason,
          updateTo: hold.updateTo,
        });
        void shutdown("SIGTERM");
      },
      onError: (err) =>
        logger.warn("the node's hold could not be checked", { err: errorMessage(err) }),
    });
  }
}

main().catch((err) => {
  logger.error("scheduler failed to start", { err: errorMessage(err) });
  process.exit(1);
});
