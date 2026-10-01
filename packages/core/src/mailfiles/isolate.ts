/**
 * Runs the parsers that read hostile bytes in child processes with a memory limit
 * and a wall-clock timeout (docs/IMPORT.md, "Isolation of the parsers").
 *
 * Why: the MSG reader, mailparser, the HTML sanitiser and the HTML to text
 * conversion walk structures that come from a file somebody uploaded, in plain
 * synchronous loops. A V8 execution timeout stops a loop but not an allocation; a
 * parse on the main thread blocks the event loop of the process for every tenant
 * while it runs; and a worker thread is no better when it matters: a single large
 * allocation (tens of MiB at once, a text turned into HTML, a string replaced) that
 * crosses the heap limit of a worker thread makes Node abort the WHOLE process
 * ("FATAL ERROR: Reached heap limit"), and terminating a thread that is still loading
 * CommonJS modules aborts it too (`cjs_lexer::Parse`). Only a process of its own
 * contains that: the child dies, the parent reads the exit code and reports an
 * unreadable item, the other tenants' jobs and the event loop never notice.
 *
 * How: a small pool of forked processes (`node --max-old-space-size=N`), one request
 * at a time each, over the IPC channel with the structured clone serialization (so
 * Buffers and Dates cross as they are). Inputs up to {@link SHARED_INPUT_BYTES} run in
 * long-lived shared processes with a fixed heap limit (starting a process costs more
 * than parsing such a message); bigger inputs get a process of their own whose limit
 * grows with the input, which is dropped afterwards. A process that ran out of memory,
 * hit its time limit, was aborted or crashed is replaced; one that finished normally is
 * reused for up to {@link RECYCLE_AFTER_TASKS} tasks (and not past
 * {@link RECYCLE_AT_RSS_MB} of resident memory). At most `workers` processes run at a
 * time, further requests wait their turn (optionally in a bounded queue).
 *
 * A task is an exported function of a module (`{ module, exportName }`) that takes the
 * input bytes and returns a structured-cloneable value; see ./isolate-child.ts.
 */
import { type ChildProcess, fork } from "node:child_process";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

const MIB = 1024 * 1024;

/** The package runs from its TypeScript sources (tests, `tsx`): the child then does as well. */
const SOURCE_MODE = import.meta.url.endsWith(".ts");

/** Inputs up to this size run on the shared processes. */
export const SHARED_INPUT_BYTES = 8 * MIB;
/** Heap limit of a shared process, in MiB. */
export const SHARED_HEAP_MB = 512;
/** A shared process is replaced after this many tasks (bounds slow leaks of a parser). */
export const RECYCLE_AFTER_TASKS = 2000;
/** A shared process that reports more resident memory than this after a task is replaced. */
export const RECYCLE_AT_RSS_MB = 1024;
const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 8;
/** What is kept of the standard error of a process, for the explanation of its death. */
const STDERR_TAIL_BYTES = 4096;

/** What went wrong with a task that did not return a value. */
export type IsolatedFailureKind =
  /** The time limit passed; the process was killed. */
  | "timeout"
  /** The process ran out of memory (its heap limit, or the operating system's). */
  | "memory"
  /** The process died in another way (a crash of a native part, a signal). */
  | "crashed"
  /** The task function threw: the input is damaged or hostile in a way the parser reported. */
  | "task"
  /** No process could run the task at all (the child entry is missing, the process never started). */
  | "unavailable"
  /** Too many tasks were already waiting for a process (see `maxQueued`); the task never started. */
  | "busy";

export class IsolatedTaskError extends Error {
  constructor(
    readonly kind: IsolatedFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "IsolatedTaskError";
  }
}

export interface IsolatedTask {
  /** URL of the module (`new URL("./x.js", import.meta.url).href`). */
  readonly module: string;
  readonly exportName: string;
  /**
   * The module is part of a package that runs from its TypeScript sources (its tests, a `tsx`
   * run): `./x.js` then stands for `./x.ts`, and the process loads it through the module hook.
   */
  readonly typescript?: boolean;
}

export interface RunIsolatedOptions {
  /** Kills the process and rejects with an `AbortError`. */
  readonly signal?: AbortSignal;
  /** Wall-clock limit of the task itself (not of the wait for a free process). */
  readonly timeoutMs?: number;
  /** Runs the task in a process of its own with this heap limit (MiB). */
  readonly heapLimitMb?: number;
  /** Passed to the task function as its second argument (structured-cloneable). */
  readonly taskOptions?: unknown;
}

/** Wall-clock limit for a task on `bytes` of input: generous for an honest file, finite for a bad one. */
export function isolatedTimeoutMs(bytes: number): number {
  return Math.min(120_000, 15_000 + Math.ceil(bytes / MIB) * 500);
}

/** Heap limit (MiB) of a process of its own: room for the text and base64 forms of an honest message. */
export function isolatedHeapLimitMb(bytes: number): number {
  return Math.min(3072, 256 + 6 * Math.ceil(bytes / MIB));
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

interface Pending {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly stopListening: () => void;
}

interface Slot {
  readonly child: ChildProcess;
  readonly dedicated: boolean;
  /** The process runs with the module hook for TypeScript sources. */
  readonly typescript: boolean;
  tasks: number;
  /** The process said it is up (it has not died while starting). */
  ready: boolean;
  dead: boolean;
  /** Replace the process after the task that is running (it grew too big). */
  worn: boolean;
  /** The last bytes of the standard error of the process. */
  stderr: string;
  /** The "FATAL ERROR: ..." line V8 or Node wrote before they aborted the process, if they did. */
  fatal: string | null;
  pending: Pending | null;
}

interface Waiter {
  grant(): void;
}

/**
 * Where the module hook for TypeScript sources lies: next to this file when the package runs from
 * its sources, in the package's `src` when it runs from `dist` (a task module of another package
 * that is itself run from TypeScript, like the tests of the API, needs the hook as well).
 */
function devHooksUrl(): string {
  return new URL(
    SOURCE_MODE ? "./dev/register-ts.mjs" : "../../src/mailfiles/dev/register-ts.mjs",
    import.meta.url,
  ).href;
}

/**
 * The child entry, and the module hook it needs when the package or the task runs from
 * TypeScript. A built package with built tasks needs none.
 */
function childEntry(typescript: boolean): { path: string; execArgv: string[] } {
  if (SOURCE_MODE) {
    return {
      path: fileURLToPath(new URL("./isolate-child.ts", import.meta.url)),
      execArgv: ["--import", devHooksUrl()],
    };
  }
  return {
    path: fileURLToPath(new URL("./isolate-child.js", import.meta.url)),
    execArgv: typescript ? ["--import", devHooksUrl()] : [],
  };
}

/** A task module that is a TypeScript source (a test or a `tsx` run of the package that owns it). */
function isTypeScriptTask(task: IsolatedTask): boolean {
  return task.typescript === true || task.module.endsWith(".ts") || SOURCE_MODE;
}

/** V8 says so on the standard error before it aborts a process that crossed its heap limit. */
const HEAP_LIMIT_TEXT = /heap limit|out of memory|allocation failed/i;

/** Why a process that nobody killed is gone, as the failure kind and a sentence. */
function explainExit(
  slot: Slot,
  code: number | null,
  signal: NodeJS.Signals | null,
): { kind: IsolatedFailureKind; message: string } {
  const how = signal ? `signal ${signal}` : `exit code ${code}`;
  const said = (slot.fatal ?? slot.stderr.trim().split("\n").slice(-2).join(" ")).slice(0, 300);
  const detail = said.length > 0 ? ` (${said})` : "";
  if (!slot.ready) {
    return {
      kind: "unavailable",
      message: `the parser process did not start (${how})${detail}`,
    };
  }
  if (slot.fatal !== null && HEAP_LIMIT_TEXT.test(slot.fatal)) {
    return { kind: "memory", message: `the parser ran out of memory (${how})${detail}` };
  }
  if (signal === "SIGKILL") {
    // Nobody here sent it: the operating system's out-of-memory killer does.
    return { kind: "memory", message: `the parser process was killed (${how})${detail}` };
  }
  return { kind: "crashed", message: `the parser process stopped unexpectedly (${how})${detail}` };
}

class IsolationPool {
  size = DEFAULT_WORKERS;
  /** Most tasks that may wait for a process; more are refused with the failure kind "busy". */
  maxQueued = Number.POSITIVE_INFINITY;
  private readonly idle: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  private running = 0;
  private nextId = 1;

  async run<T>(task: IsolatedTask, input: Uint8Array, options: RunIsolatedOptions): Promise<T> {
    await this.enter(options.signal);
    let slot: Slot | null = null;
    try {
      const dedicated = options.heapLimitMb !== undefined || input.byteLength > SHARED_INPUT_BYTES;
      const typescript = isTypeScriptTask(task);
      slot = dedicated
        ? this.spawn(options.heapLimitMb ?? isolatedHeapLimitMb(input.byteLength), true, typescript)
        : (this.takeIdle(typescript) ?? this.spawn(SHARED_HEAP_MB, false, typescript));
      return (await this.execute(slot, task, input, options)) as T;
    } finally {
      if (slot) {
        this.release(slot);
      }
      this.leave();
    }
  }

  /** Kill the idle processes (tests, graceful shutdown). Running tasks finish first. */
  async shutdown(): Promise<void> {
    const slots = this.idle.splice(0);
    await Promise.all(slots.map((slot) => this.stop(slot)));
  }

  private enter(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortError());
    }
    if (this.running < this.size) {
      this.running++;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new IsolatedTaskError("busy", "all parser processes are busy and the queue is full"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
        reject(abortError());
      };
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private leave(): void {
    const next = this.waiters.shift();
    if (next) {
      // The slot passes straight to the next waiter: `running` stays as it is.
      next.grant();
    } else {
      this.running--;
    }
  }

  /** A live idle process of the right kind, if there is one (one that died while it waited is dropped). */
  private takeIdle(typescript: boolean): Slot | undefined {
    for (let index = this.idle.length - 1; index >= 0; index--) {
      const slot = this.idle[index] as Slot;
      if (slot.dead) {
        this.idle.splice(index, 1);
      } else if (slot.typescript === typescript) {
        this.idle.splice(index, 1);
        return slot;
      }
    }
    return undefined;
  }

  /** Hold the event loop of the parent while a task runs, let go of it while the process idles. */
  private hold(slot: Slot, held: boolean): void {
    const child = slot.child;
    const stderr = child.stderr as
      | (NodeJS.ReadableStream & { ref?(): void; unref?(): void })
      | null;
    if (held) {
      child.ref();
      child.channel?.ref();
      stderr?.ref?.();
    } else {
      child.unref();
      child.channel?.unref();
      stderr?.unref?.();
    }
  }

  private spawn(heapMb: number, dedicated: boolean, typescript: boolean): Slot {
    const entry = childEntry(typescript);
    const child = fork(entry.path, [], {
      execArgv: [`--max-old-space-size=${heapMb}`, ...entry.execArgv],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    const slot: Slot = {
      child,
      dedicated,
      typescript,
      tasks: 0,
      ready: false,
      dead: false,
      worn: false,
      stderr: "",
      fatal: null,
      pending: null,
    };
    this.hold(slot, false);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (text: string) => {
      const joined = slot.stderr + text;
      if (slot.fatal === null) {
        // The message comes first and the native stack trace after it: look before the tail is cut.
        slot.fatal = /FATAL ERROR[^\n]*/.exec(joined)?.[0] ?? null;
      }
      slot.stderr = joined.slice(-STDERR_TAIL_BYTES);
    });
    child.on(
      "message",
      (message: {
        type?: string;
        id?: number;
        ok?: boolean;
        value?: unknown;
        name?: string;
        message?: string;
        rss?: number;
        exiting?: boolean;
      }) => {
        if (message.type === "ready") {
          slot.ready = true;
          return;
        }
        const pending = slot.pending;
        if (!pending || pending.id !== message.id) {
          return;
        }
        this.settle(slot);
        if (
          message.exiting ||
          (typeof message.rss === "number" && message.rss > RECYCLE_AT_RSS_MB * MIB)
        ) {
          // Going away or grown too big: it does not get another task.
          slot.worn = true;
        }
        if (message.ok) {
          pending.resolve(message.value);
        } else {
          pending.reject(
            new IsolatedTaskError("task", `${message.name ?? "Error"}: ${message.message ?? ""}`),
          );
        }
      },
    );
    child.on("error", (error: Error) => {
      // The process could not be started or reached (a missing entry, no more processes).
      slot.dead = true;
      const pending = slot.pending;
      if (pending) {
        this.settle(slot);
        pending.reject(
          new IsolatedTaskError("unavailable", `the parser process failed: ${error.message}`),
        );
      }
    });
    child.on("exit", () => {
      slot.dead = true;
      const index = this.idle.indexOf(slot);
      if (index >= 0) {
        this.idle.splice(index, 1);
      }
    });
    // `close` comes after the standard error of the process was read to its end, which is where
    // V8 says that it ran out of memory.
    child.on("close", (code, signal) => {
      slot.dead = true;
      const pending = slot.pending;
      if (pending) {
        this.settle(slot);
        const why = explainExit(slot, code, signal);
        pending.reject(new IsolatedTaskError(why.kind, why.message));
      }
    });
    return slot;
  }

  /** Detach the running task from its slot: timer, abort listener, event loop reference. */
  private settle(slot: Slot): void {
    const pending = slot.pending;
    if (!pending) {
      return;
    }
    slot.pending = null;
    clearTimeout(pending.timer);
    pending.stopListening();
    this.hold(slot, false);
  }

  /** Kill a process and wait until it is gone. */
  private stop(slot: Slot): Promise<void> {
    slot.dead = true;
    if (slot.child.exitCode !== null || slot.child.signalCode !== null) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      // The exit is only seen while the handle of the process holds the event loop.
      this.hold(slot, true);
      slot.child.once("exit", () => resolve());
      slot.child.kill("SIGKILL");
    });
  }

  private execute(
    slot: Slot,
    task: IsolatedTask,
    input: Uint8Array,
    options: RunIsolatedOptions,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = this.nextId++;
      const kill = (error: unknown): void => {
        const pending = slot.pending;
        if (!pending) {
          return;
        }
        slot.dead = true;
        this.settle(slot);
        slot.child.kill("SIGKILL");
        pending.reject(error);
      };
      const timeoutMs = options.timeoutMs ?? isolatedTimeoutMs(input.byteLength);
      const timer = setTimeout(
        () =>
          kill(
            new IsolatedTaskError("timeout", `the parser did not finish within ${timeoutMs} ms`),
          ),
        timeoutMs,
      );
      const onAbort = (): void => kill(abortError());
      options.signal?.addEventListener("abort", onAbort, { once: true });
      slot.pending = {
        id,
        resolve,
        reject,
        timer,
        stopListening: () => options.signal?.removeEventListener("abort", onAbort),
      };
      slot.tasks++;
      this.hold(slot, true);
      // The structured clone serializes the bytes of the view only (not the larger buffer a
      // Buffer may be a slice of) and does it before `send` returns: the caller's buffer is
      // not touched again.
      try {
        slot.child.send(
          {
            id,
            module: task.module,
            exportName: task.exportName,
            input,
            options: options.taskOptions,
          },
          (error) => {
            if (error) {
              kill(
                new IsolatedTaskError(
                  "unavailable",
                  `the task could not be sent to the parser process: ${error.message}`,
                ),
              );
            }
          },
        );
      } catch (error) {
        kill(
          new IsolatedTaskError(
            "unavailable",
            `the task could not be sent to the parser process: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  private release(slot: Slot): void {
    if (slot.dead || slot.dedicated || slot.worn || slot.tasks >= RECYCLE_AFTER_TASKS) {
      void this.stop(slot);
      return;
    }
    this.idle.push(slot);
  }
}

const pool = new IsolationPool();

/**
 * Configure the pool: how many parser processes run at once (1 to 8, default 2) and how many
 * tasks may wait for one (default: any number; a process that answers requests, like the API,
 * bounds it so a burst is refused instead of queued without end). Takes effect for the tasks
 * that start afterwards.
 */
export function configureIsolation(options: { workers?: number; maxQueued?: number }): void {
  if (options.workers !== undefined && Number.isFinite(options.workers)) {
    pool.size = Math.min(MAX_WORKERS, Math.max(1, Math.floor(options.workers)));
  }
  if (options.maxQueued !== undefined) {
    pool.maxQueued = Number.isFinite(options.maxQueued)
      ? Math.max(0, Math.floor(options.maxQueued))
      : Number.POSITIVE_INFINITY;
  }
}

/** The default number of parser processes for this machine (never more than the cores it has). */
export function defaultIsolationWorkers(): number {
  return Math.min(DEFAULT_WORKERS, Math.max(1, availableParallelism()));
}

/**
 * Run `task` on `input` in a child process. Rejects with an {@link IsolatedTaskError} when the
 * task threw, ran out of memory, ran out of time, crashed or could not run, and with an
 * `AbortError` when the signal fired.
 */
export function runIsolated<T>(
  task: IsolatedTask,
  input: Uint8Array,
  options: RunIsolatedOptions = {},
): Promise<T> {
  return pool.run<T>(task, input, options);
}

/** Kill the idle parser processes. For tests and a graceful shutdown. */
export function shutdownIsolation(): Promise<void> {
  return pool.shutdown();
}
