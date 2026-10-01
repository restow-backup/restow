/**
 * Tasks for the tests of the parser isolation (../isolate.ts): well-behaved,
 * slow, memory-hungry and throwing functions, run in child processes.
 */

export function echo(
  input: Buffer,
  options?: unknown,
): { length: number; options: unknown; sum: number } {
  let sum = 0;
  for (const byte of input) {
    sum = (sum + byte) % 65521;
  }
  return { length: input.length, options, sum };
}

/** A synchronous loop that never ends. */
export function spin(): never {
  for (;;) {
    // busy
  }
}

/** Fills the heap with live objects until the limit of the process is hit. */
export function allocate(): never {
  const keep: object[][] = [];
  for (;;) {
    keep.push(Array.from({ length: 10_000 }, (_, i) => ({ i, text: `entry ${i}` })));
  }
}

/** The kind of loop a looping FAT chain makes msgreader run: an array that grows with every turn. */
export function growForever(): never {
  const chain: number[] = [];
  for (let i = 0; ; i++) {
    chain.push(i, i + 1, i + 2, i + 3);
  }
}

/**
 * One large allocation that crosses the heap limit at once, the way mailparser turns a 30 MB text
 * into HTML: the case that aborts a whole process when it happens in a worker thread.
 */
export function oneBigAllocation(_input: Buffer, options?: { chars?: number }): number {
  const text = "<".repeat(options?.chars ?? 40_000_000);
  return text.replace(/</g, "&lt;").length;
}

export function explode(): never {
  throw new RangeError("this input is not acceptable");
}

/** An error thrown from a callback nobody awaits, after the task function returned. */
export function lateError(): string {
  setTimeout(() => {
    throw new Error("late failure of a callback");
  }, 20);
  return "returned";
}

/** Throws from a timer while the task is still waiting: reported for this task, then the process ends. */
export async function errorWhileWaiting(): Promise<never> {
  setTimeout(() => {
    throw new Error("a callback failed while the task waited");
  }, 20);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  throw new Error("not reached");
}

export function dieWithoutReport(): never {
  // A crash of a native part looks like this from the outside: the process is simply gone.
  process.kill(process.pid, "SIGSEGV");
  throw new Error("not reached");
}

export function exitAtOnce(): never {
  process.exit(3);
}

export async function slowEcho(input: Buffer, options?: { delayMs?: number }): Promise<number> {
  await new Promise((resolve) => setTimeout(resolve, options?.delayMs ?? 50));
  return input.length;
}

export function whichProcess(): number {
  return process.pid;
}

/** Starts, waits, ends: the interval shows whether two tasks ran side by side. */
export async function timed(
  _input: Buffer,
  options?: { delayMs?: number },
): Promise<{ start: number; end: number }> {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, options?.delayMs ?? 50));
  return { start, end: Date.now() };
}

/** Hands back bytes and a date, to see what crosses the process boundary. */
export function bytesAndDate(input: Buffer): { bytes: Buffer; date: Date; length: number } {
  return {
    bytes: Buffer.from(input),
    date: new Date("2026-01-02T03:04:05Z"),
    length: input.length,
  };
}

/**
 * mailparser with its defaults, which turn the text of a message into HTML as well (textAsHtml):
 * for a 30 MB text of "<" that is one string of 125 MB made in one go.
 */
export async function mailparserDefaults(input: Buffer): Promise<number> {
  const { simpleParser } = await import("mailparser");
  const parsed = await simpleParser(input);
  return (parsed.textAsHtml ?? "").length;
}
