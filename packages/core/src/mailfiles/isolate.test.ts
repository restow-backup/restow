import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type IsolatedTask,
  IsolatedTaskError,
  RECYCLE_AFTER_TASKS,
  SHARED_INPUT_BYTES,
  configureIsolation,
  isolatedHeapLimitMb,
  isolatedTimeoutMs,
  runIsolated,
  shutdownIsolation,
} from "./isolate.js";

const fixtures = new URL("./testing/isolate-fixtures.js", import.meta.url).href;
const task = (exportName: string): IsolatedTask => ({ module: fixtures, exportName });

afterAll(async () => {
  await shutdownIsolation();
});

async function failureOf(promise: Promise<unknown>): Promise<IsolatedTaskError> {
  const failure = await promise.catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(IsolatedTaskError);
  return failure as IsolatedTaskError;
}

describe("runIsolated", { timeout: 90_000 }, () => {
  it("runs a task in a child process and returns its value", async () => {
    const result = await runIsolated<{ length: number; options: unknown; sum: number }>(
      task("echo"),
      Buffer.from([1, 2, 3, 250]),
      { taskOptions: { a: 1 } },
    );
    expect(result).toEqual({ length: 4, options: { a: 1 }, sum: 256 });
    const pid = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    expect(pid).not.toBe(process.pid);
  });

  it("sends the bytes of a view, not the buffer it is cut from, and gets bytes and dates back as they are", async () => {
    const big = Buffer.alloc(1 << 20, 7);
    const view = big.subarray(10, 20);
    const result = await runIsolated<{ bytes: Uint8Array; date: Date; length: number }>(
      task("bytesAndDate"),
      view,
    );
    expect(result.length).toBe(10);
    expect(Buffer.from(result.bytes).equals(view)).toBe(true);
    expect(result.date).toBeInstanceOf(Date);
    expect(result.date.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(big.length).toBe(1 << 20);
  });

  it("reuses a process for the next small task", async () => {
    const first = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    const second = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    expect(second).toBe(first);
  });

  it("reports an error of the task as a task failure and keeps the process usable", async () => {
    const failure = await failureOf(runIsolated(task("explode"), Buffer.alloc(1)));
    expect(failure.kind).toBe("task");
    expect(failure.message).toContain("not acceptable");
    await expect(runIsolated(task("echo"), Buffer.alloc(3))).resolves.toMatchObject({ length: 3 });
  });

  it("reports an error thrown from a callback of the task for that task, and replaces the process", async () => {
    const before = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    const failure = await failureOf(
      runIsolated(task("errorWhileWaiting"), Buffer.alloc(1), { timeoutMs: 30_000 }),
    );
    expect(failure.kind).toBe("task");
    expect(failure.message).toContain("callback failed while the task waited");
    const after = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    expect(after).not.toBe(before);
  });

  it("kills a task that never ends and runs the next one in a fresh process", async () => {
    const before = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    const started = Date.now();
    const failure = await failureOf(runIsolated(task("spin"), Buffer.alloc(1), { timeoutMs: 300 }));
    expect(failure.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5000);
    const after = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    expect(after).not.toBe(before);
  });

  it("does not block the event loop of the caller while a task spins", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await runIsolated(task("spin"), Buffer.alloc(1), { timeoutMs: 500 }).catch(() => undefined);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(20);
  });

  it("survives a process that runs out of memory", async () => {
    for (const exportName of ["allocate", "growForever"]) {
      const failure = await failureOf(
        runIsolated(task(exportName), Buffer.alloc(1), { heapLimitMb: 64, timeoutMs: 60_000 }),
      );
      expect(failure.kind, exportName).toBe("memory");
    }
    await expect(runIsolated(task("echo"), Buffer.alloc(2))).resolves.toMatchObject({ length: 2 });
  });

  it("survives one large allocation that crosses the heap limit at once (this aborts a whole process when it happens in a worker thread)", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const failure = await failureOf(
      runIsolated(task("oneBigAllocation"), Buffer.alloc(1), {
        heapLimitMb: 96,
        taskOptions: { chars: 60_000_000 },
        timeoutMs: 60_000,
      }),
    );
    clearInterval(timer);
    expect(failure.kind).toBe("memory");
    expect(failure.message).toMatch(/heap limit|out of memory|SIGABRT/i);
    // This process is still here and its event loop kept running.
    expect(ticks).toBeGreaterThan(5);
    await expect(runIsolated(task("echo"), Buffer.alloc(2))).resolves.toMatchObject({ length: 2 });
  });

  it("contains mailparser asked for the HTML of a 30 MB text of '<': the process aborts at its heap limit, the caller never stalls and lives on", async () => {
    // mailparser with its defaults makes a 125 MB string of it in one allocation. In a worker thread
    // that is "FATAL ERROR: Reached heap limit" for the whole process.
    const hostile = Buffer.from(
      `From: a@example.test\r\nSubject: report\r\nContent-Type: text/plain\r\n\r\n${"<".repeat(30 * 1024 * 1024)}`,
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    const failure = await failureOf(
      runIsolated(task("mailparserDefaults"), hostile, { timeoutMs: 60_000 }),
    );
    clearInterval(timer);
    expect(failure.kind).toBe("memory");
    expect(failure.message).toContain("Reached heap limit");
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(ticks).toBeGreaterThan(5);
    await expect(runIsolated(task("echo"), Buffer.alloc(2))).resolves.toMatchObject({ length: 2 });
  });

  it("reports a process that dies without a word as crashed, and one that exits as crashed", async () => {
    const segfault = await failureOf(runIsolated(task("dieWithoutReport"), Buffer.alloc(1)));
    expect(segfault.kind).toBe("crashed");
    expect(segfault.message).toContain("SIGSEGV");
    const exited = await failureOf(runIsolated(task("exitAtOnce"), Buffer.alloc(1)));
    expect(exited.kind).toBe("crashed");
    expect(exited.message).toContain("exit code 3");
    await expect(runIsolated(task("echo"), Buffer.alloc(2))).resolves.toMatchObject({ length: 2 });
  });

  it("reports a task that does not exist and a module that cannot be loaded as task failures", async () => {
    expect((await failureOf(runIsolated(task("noSuchTask"), Buffer.alloc(1)))).kind).toBe("task");
    const missing = {
      module: new URL("./testing/no-such-module.js", import.meta.url).href,
      exportName: "x",
    };
    expect((await failureOf(runIsolated(missing, Buffer.alloc(1)))).kind).toBe("task");
  });

  it("aborts a running task and a waiting one", async () => {
    configureIsolation({ workers: 1 });
    try {
      const running = new AbortController();
      const waiting = new AbortController();
      const first = runIsolated(task("slowEcho"), Buffer.alloc(1), {
        signal: running.signal,
        taskOptions: { delayMs: 5000 },
      }).catch((e: unknown) => e);
      const second = runIsolated(task("echo"), Buffer.alloc(1), { signal: waiting.signal }).catch(
        (e: unknown) => e,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      waiting.abort();
      running.abort();
      for (const outcome of await Promise.all([first, second])) {
        expect((outcome as Error).name).toBe("AbortError");
      }
      await expect(runIsolated(task("echo"), Buffer.alloc(4))).resolves.toMatchObject({
        length: 4,
      });
      const already = new AbortController();
      already.abort();
      await expect(
        runIsolated(task("echo"), Buffer.alloc(1), { signal: already.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      configureIsolation({ workers: 2 });
    }
  });

  it("runs at most the configured number of tasks at once and queues the rest", async () => {
    configureIsolation({ workers: 1 });
    try {
      const started = Date.now();
      const outcomes = await Promise.all(
        [1, 2, 3].map(() =>
          runIsolated<number>(task("slowEcho"), Buffer.alloc(1), { taskOptions: { delayMs: 150 } }),
        ),
      );
      expect(outcomes).toEqual([1, 1, 1]);
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    } finally {
      configureIsolation({ workers: 2 });
    }
  });

  it("refuses a task beyond the queue it is allowed instead of letting a burst pile up", async () => {
    configureIsolation({ workers: 1, maxQueued: 1 });
    try {
      const run = () =>
        runIsolated<number>(task("slowEcho"), Buffer.alloc(1), { taskOptions: { delayMs: 300 } });
      const first = run();
      const second = run();
      const third = await failureOf(run());
      expect(third.kind).toBe("busy");
      expect(await Promise.all([first, second])).toEqual([1, 1]);
      await expect(run()).resolves.toBe(1);
    } finally {
      configureIsolation({ workers: 2, maxQueued: Number.POSITIVE_INFINITY });
    }
  });

  it("runs two tasks side by side with two processes", async () => {
    configureIsolation({ workers: 2 });
    // Two warm processes first: starting one takes longer than the tasks below.
    await Promise.all(
      [1, 2].map(() =>
        runIsolated(task("timed"), Buffer.alloc(1), { taskOptions: { delayMs: 200 } }),
      ),
    );
    const [first, second] = await Promise.all(
      [1, 2].map(() =>
        runIsolated<{ start: number; end: number }>(task("timed"), Buffer.alloc(1), {
          taskOptions: { delayMs: 300 },
        }),
      ),
    );
    const overlap =
      Math.min(first?.end ?? 0, second?.end ?? 0) - Math.max(first?.start ?? 0, second?.start ?? 0);
    expect(overlap).toBeGreaterThan(150);
  });

  it("gives inputs above the shared size a process of their own", async () => {
    const small = await runIsolated<number>(task("whichProcess"), Buffer.alloc(1));
    const bigInput = Buffer.alloc(SHARED_INPUT_BYTES + 1);
    const first = await runIsolated<number>(task("whichProcess"), bigInput);
    const second = await runIsolated<number>(task("whichProcess"), bigInput);
    expect(first).not.toBe(small);
    expect(second).not.toBe(first);
  });

  it("hands a 30 MB input over and back without a stall of the caller", async () => {
    const input = Buffer.alloc(30 * 1024 * 1024, 0x3c);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const result = await runIsolated<{ length: number }>(task("echo"), input);
    clearInterval(timer);
    expect(result.length).toBe(input.length);
    expect(ticks).toBeGreaterThan(0);
  });

  it("lets a program exit that used the pool and never shut it down: idle processes do not hold it", async () => {
    const hooks = new URL("./dev/register-ts.mjs", import.meta.url).href;
    const isolate = new URL("./isolate.js", import.meta.url).href;
    const script = `
      const { runIsolated } = await import(${JSON.stringify(isolate)});
      const r = await runIsolated({ module: ${JSON.stringify(fixtures)}, exportName: "echo", typescript: true }, Buffer.from("abc"));
      console.log("length", r.length);
    `;
    const started = Date.now();
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", hooks, "--input-type=module", "-e", script],
        { cwd: fileURLToPath(new URL("../..", import.meta.url)), timeout: 60_000 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
    expect(output).toContain("length 3");
    expect(Date.now() - started).toBeLessThan(60_000);
  });

  it("reports options that cannot be sent as a failure of the task, not as a hang", async () => {
    const failure = await failureOf(
      runIsolated(task("echo"), Buffer.alloc(1), {
        taskOptions: { notCloneable: () => 1 },
        timeoutMs: 5000,
      }),
    );
    expect(failure.kind).toBe("unavailable");
    await expect(runIsolated(task("echo"), Buffer.alloc(5))).resolves.toMatchObject({ length: 5 });
  });
});

describe("limits", () => {
  it("grows the time limit with the input and keeps it finite", () => {
    expect(isolatedTimeoutMs(1000)).toBe(15_500);
    expect(isolatedTimeoutMs(100 * 1024 * 1024)).toBe(65_000);
    expect(isolatedTimeoutMs(10 * 1024 ** 3)).toBe(120_000);
  });

  it("grows the heap limit with the input and caps it", () => {
    expect(isolatedHeapLimitMb(10 * 1024 * 1024)).toBe(316);
    expect(isolatedHeapLimitMb(256 * 1024 * 1024)).toBe(1792);
    expect(isolatedHeapLimitMb(10 * 1024 ** 3)).toBe(3072);
  });

  it("recycles shared processes after a fixed number of tasks", () => {
    expect(RECYCLE_AFTER_TASKS).toBeGreaterThan(100);
  });
});
