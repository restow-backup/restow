// Single-leader election via a Postgres session-level advisory lock.
//
// A session-level advisory lock is bound to the connection that holds it, so we
// keep one dedicated pg.Client open for the lifetime of the leadership. If the
// leader crashes, Postgres drops the session and releases the lock, and a
// stand-by replica picks it up on its next attempt.

import pg from "pg";
import { errorMessage, logger } from "./logger.js";

const { Client } = pg;
type PgClient = InstanceType<typeof Client>;

export interface LeaderElectionDeps {
  readonly connectionString: string;
  /** Advisory-lock key all replicas contend for. */
  readonly lockKey: number;
  /** Delay between stand-by re-election attempts, in milliseconds. */
  readonly retryIntervalMs: number;
  /** Invoked when leadership is gained (true) or lost (false). */
  readonly onChange: (isLeader: boolean) => void;
}

export class LeaderElection {
  private client: PgClient | null = null;
  private leader = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly deps: LeaderElectionDeps) {}

  isLeader(): boolean {
    return this.leader;
  }

  /** Begin trying to acquire leadership; retries in the background until stopped. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.attempt();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.leader || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.attempt();
    }, this.deps.retryIntervalMs);
    // Do not let the retry timer alone keep the process alive during shutdown.
    this.retryTimer.unref();
  }

  private async ensureClient(): Promise<PgClient> {
    if (this.client !== null) return this.client;
    const client = new Client({ connectionString: this.deps.connectionString });
    client.on("error", (err) => this.onConnectionError(err));
    await client.connect();
    this.client = client;
    return client;
  }

  private onConnectionError(err: unknown): void {
    logger.warn("leader connection lost, re-electing", { err: errorMessage(err) });
    const wasLeader = this.leader;
    this.leader = false;
    // node-postgres destroys the client on a connection error; drop our handle
    // so the next attempt reconnects.
    this.client = null;
    if (wasLeader) this.deps.onChange(false);
    this.scheduleRetry();
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.leader) return;
    try {
      const client = await this.ensureClient();
      const result = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS locked",
        [this.deps.lockKey],
      );
      if (result.rows[0]?.locked === true) {
        this.leader = true;
        logger.info("acquired scheduler leadership");
        this.deps.onChange(true);
      } else {
        logger.debug("another instance is the scheduler leader, standing by");
        this.scheduleRetry();
      }
    } catch (err) {
      logger.warn("leadership attempt failed, will retry", { err: errorMessage(err) });
      await this.disconnect();
      this.scheduleRetry();
    }
  }

  /** Release the lock (if held) and close the dedicated connection. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.client !== null && this.leader) {
      try {
        await this.client.query("SELECT pg_advisory_unlock($1)", [this.deps.lockKey]);
      } catch (err) {
        logger.warn("failed to release advisory lock", { err: errorMessage(err) });
      }
    }
    this.leader = false;
    await this.disconnect();
  }

  private async disconnect(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client === null) return;
    try {
      await client.end();
    } catch {
      // Already closed or never fully connected; nothing to do.
    }
  }
}
