/**
 * New job starts paused for an update (#46, @restow/db `job_start_pause`).
 *
 * While an administrator's update waits for running jobs, or is announced, the
 * worker takes no new job from its queues: every pg-boss worker registered
 * through {@link JobPauseGate.wrap} is taken off its queue (a job it is running
 * finishes first) and put back once the pause lifts. In `drain` mode the jobs
 * that are running are asked to checkpoint and stop as well (abort reason
 * `update`, framework.ts); they go back to their queue without using up an
 * attempt (continuation.ts) and continue after the update.
 *
 * The pause is read every few seconds from the database, so it holds across a
 * restart of this process (an update restarts it) and lifts by itself: the api
 * removes the row after the update, and an expired row counts as lifted.
 * Queues that only finish or watch what already runs stay on (`ungated`).
 */

import type { Logger } from "@restow/core";
import { type JobStartPauseState, NOT_PAUSED } from "@restow/db";
import type { UpdateDrain } from "./handlers/framework.js";

/** How often the pause is read. */
export const JOB_PAUSE_POLL_MS = 5_000;

type Work = (queue: string, options: object, handler: unknown) => Promise<string>;

/** The two pg-boss calls the gate makes. */
export interface GateBoss {
  work: Work;
  offWork(options: { id: string }): Promise<void>;
}

interface Registration {
  readonly queue: string;
  readonly options: object;
  readonly handler: unknown;
  /** The pg-boss worker id while the queue is consumed; null while paused. */
  id: string | null;
}

export interface JobPauseGateOptions {
  /** Reads the pause (readJobStartPause on the installation pool). */
  readonly read: () => Promise<JobStartPauseState>;
  readonly logger: Logger;
  /** Queues that keep running during a pause (finishing and watching what already runs). */
  readonly ungated?: ReadonlySet<string>;
  readonly pollMs?: number;
}

export class JobPauseGate implements UpdateDrain {
  private state: JobStartPauseState = NOT_PAUSED;
  private boss: GateBoss | null = null;
  private readonly registrations: Registration[] = [];
  private readonly listeners = new Set<() => void>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private applying: Promise<void> = Promise.resolve();

  constructor(private readonly options: JobPauseGateOptions) {}

  /** Whether new starts are paused right now (PVE planning, the file share dispatcher). */
  paused(): boolean {
    return this.state.paused;
  }

  /** Whether running jobs are to stop now. */
  draining(): boolean {
    return this.state.drain;
  }

  /**
   * pg-boss whose `work` goes through the gate; everything else is pg-boss itself. The
   * gate takes queues off and puts them back with this same instance.
   */
  wrap<T extends object>(boss: T): T {
    this.boss = boss as unknown as GateBoss;
    const work: Work = (queue, options, handler) => this.work(queue, options, handler);
    return new Proxy(boss, {
      get(target, property, receiver) {
        if (property === "work") {
          return work;
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Consume a queue unless new starts are paused; a paused queue is consumed once it lifts. */
  async work(queue: string, options: object, handler: unknown): Promise<string> {
    const boss = this.requireBoss();
    if (this.options.ungated?.has(queue)) {
      return boss.work(queue, options, handler);
    }
    const registration: Registration = { queue, options, handler, id: null };
    this.registrations.push(registration);
    if (!this.state.paused) {
      registration.id = await boss.work(queue, options, handler);
    }
    return registration.id ?? `paused:${queue}`;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    if (this.state.drain) {
      listener();
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Read the pause and follow it. A failed read keeps the last state. */
  async refresh(): Promise<void> {
    let next: JobStartPauseState;
    try {
      next = await this.options.read();
    } catch (error) {
      this.options.logger.warn("could not read whether job starts are paused", {
        errorMessage: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
      return;
    }
    this.applying = this.applying.then(() => this.apply(next));
    await this.applying;
  }

  /** Read the pause every few seconds until {@link stop}. */
  start(): void {
    const loop = () => {
      if (this.stopped) {
        return;
      }
      this.timer = setTimeout(() => {
        void this.refresh().finally(loop);
      }, this.options.pollMs ?? JOB_PAUSE_POLL_MS);
      this.timer.unref();
    };
    loop();
  }

  /** Stop following the pause (before pg-boss stops: it must not consume a queue again). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private requireBoss(): GateBoss {
    if (!this.boss) {
      throw new Error("JobPauseGate.wrap(boss) must come before work()");
    }
    return this.boss;
  }

  private async apply(next: JobStartPauseState): Promise<void> {
    const before = this.state;
    this.state = next;
    const { logger } = this.options;
    if (next.paused && !before.paused) {
      logger.info("new job starts paused for an update", {
        version: next.version,
        mode: next.mode,
        phase: next.phase,
      });
      for (const registration of this.registrations) {
        if (registration.id) {
          const id = registration.id;
          registration.id = null;
          await this.requireBoss()
            .offWork({ id })
            .catch((error: unknown) =>
              logger.warn("could not take a queue off for the pause", {
                queue: registration.queue,
                errorMessage: error instanceof Error ? error.message : String(error),
              }),
            );
        }
      }
    } else if (!next.paused && !this.stopped) {
      if (before.paused) {
        logger.info("job starts resumed");
      }
      // Also a queue that could not be consumed again at the last read.
      for (const registration of this.registrations) {
        if (!registration.id) {
          try {
            registration.id = await this.requireBoss().work(
              registration.queue,
              registration.options,
              registration.handler,
            );
          } catch (error) {
            logger.warn("could not consume a queue again after the pause", {
              queue: registration.queue,
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
    if (next.drain && !before.drain) {
      logger.info("running jobs stop for the update and continue after it", {
        version: next.version,
      });
      for (const listener of [...this.listeners]) {
        listener();
      }
    }
  }
}
