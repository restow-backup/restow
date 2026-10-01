/**
 * Entry point of the child processes of ./isolate.ts. The parent sends one request
 * at a time over the IPC channel (`{ id, module, exportName, input, options }`); the
 * process loads the module once, calls the export with the input bytes and sends back
 * the value, or the error. Everything that goes wrong inside a request is reported, so
 * the only ways this process ends are the ones the parent causes on purpose (timeout,
 * abort) or has to survive: the heap limit (`--max-old-space-size`, V8 aborts the
 * process, which is exactly why the parsers do not run in the parent) and a crash of a
 * native part.
 *
 * Keep the static imports to `node:` modules: the process says "ready" before it loads
 * anything of the task, so the parent can tell a process that never started from one
 * that died on its input. The module URL comes from the code of this package, never
 * from user input.
 */

interface Request {
  readonly id: number;
  readonly module: string;
  readonly exportName: string;
  readonly input: Uint8Array;
  readonly options?: unknown;
}

let current: number | null = null;

function send(message: unknown): void {
  try {
    process.send?.(message);
  } catch {
    // The parent is gone; the disconnect handler ends this process.
  }
}

function describe(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * An error nobody caught (a late callback of a parser): report it for the task that is running and
 * tell the parent that this process is going away, so it is not given another task.
 */
function fatal(error: unknown): void {
  if (current !== null) {
    send({ id: current, ok: false, exiting: true, ...describe(error) });
  }
  // The state of a parser that threw out of its own callbacks is not worth keeping.
  setTimeout(() => process.exit(1), 50);
}

process.on("uncaughtException", fatal);
process.on("unhandledRejection", fatal);
process.on("disconnect", () => process.exit(0));

async function handle(request: Request): Promise<void> {
  current = request.id;
  try {
    const loaded = (await import(request.module)) as Record<string, unknown>;
    const task = loaded[request.exportName];
    if (typeof task !== "function") {
      throw new Error(`${request.module} has no function ${request.exportName}`);
    }
    const input = Buffer.from(
      request.input.buffer,
      request.input.byteOffset,
      request.input.byteLength,
    );
    const value = await (task as (input: Buffer, options?: unknown) => unknown)(
      input,
      request.options,
    );
    send({ id: request.id, ok: true, value, rss: process.memoryUsage().rss });
  } catch (error) {
    send({ id: request.id, ok: false, ...describe(error) });
  } finally {
    current = null;
  }
}

process.on("message", (request: Request) => {
  void handle(request);
});
send({ type: "ready" });

export {};
