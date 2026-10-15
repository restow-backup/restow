import { type ChildProcess, fork } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChildMessage, ParentMessage, VolumeInfo } from "./protocol.js";
import { type FsEntry, GuestFsError, MAX_READ_BYTES } from "./source.js";

/**
 * Starts the reader of a VM restore point's file systems in a throwaway child process and talks
 * to it (docs/PVE.md, "Files of a VM", and its threat model):
 *
 *   - Node's permission model: the child may read its own code and nothing else; no child
 *     processes, no worker threads, no native addons. Its environment is empty: it holds no
 *     secret, no key, no database address.
 *   - A small V8 heap, a deadline per operation, a budget of disk bytes per session: a guest
 *     file system built to make the reader loop, allocate or read forever ends in an error.
 *   - The child gets the disk bytes from this process, read from the restore point; it never
 *     mounts anything, and nothing of the guest reaches a kernel file system driver.
 *
 * One sandbox serves one request (a folder page, a download) and is killed afterwards.
 */

export interface SandboxDisk {
  device: string;
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface SandboxOptions {
  /** How long one operation may take (default 60 s). */
  timeoutMs?: number;
  /** How many disk bytes the child may ask for in all (default 4 GiB). */
  maxReadBytes?: number;
  /** The V8 heap of the child in MiB (default 256). */
  heapMiB?: number;
  /** The child's script (default: sandbox-child.js next to this module, as built). */
  childScript?: string;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_READ = 4 * 1024 ** 3;

function permissionFlag(): string {
  // `--permission` is stable from Node 22.13; before, the same model was experimental.
  return process.allowedNodeEnvironmentFlags.has("--permission")
    ? "--permission"
    : "--experimental-permission";
}

export class GuestFsSandbox {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private bytesRead = 0;
  private closed = false;
  private failure: Error | null = null;
  private readonly timeoutMs: number;
  private readonly maxReadBytes: number;

  private constructor(
    private readonly disks: readonly SandboxDisk[],
    options: SandboxOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ;
    const script =
      options.childScript ?? fileURLToPath(new URL("./sandbox-child.js", import.meta.url));
    const real = realpathSync(script);
    this.child = fork(real, [], {
      execArgv: [
        permissionFlag(),
        `--allow-fs-read=${dirname(real)}`,
        `--max-old-space-size=${options.heapMiB ?? 256}`,
        "--disallow-code-generation-from-strings",
      ],
      env: {},
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    this.child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString("utf8");
    });
    this.child.on("message", (message: ChildMessage) => this.onMessage(message));
    this.child.on("exit", (code, signal) => {
      this.fail(
        new GuestFsError(
          "damaged",
          this.closed
            ? "the reader was closed"
            : `the reader ended (${signal ?? code}): ${stderr.trim().split("\n").at(-1) ?? ""}`.trim(),
        ),
      );
    });
    this.child.on("error", (error) => this.fail(error));
    options.signal?.addEventListener("abort", () => this.close(), { once: true });
  }

  /** Start a reader over `disks` and find their file systems. */
  static async start(disks: readonly SandboxDisk[], options: SandboxOptions = {}) {
    const sandbox = new GuestFsSandbox(disks, options);
    const init: ParentMessage = {
      t: "init",
      disks: disks.map((d) => ({ device: d.device, size: d.size })),
    };
    sandbox.child.send(init);
    return sandbox;
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(this.failure);
      this.pending.delete(id);
    }
  }

  private onMessage(message: ChildMessage): void {
    if (message.t === "read") {
      void this.serveRead(message);
      return;
    }
    if (message.t === "result") {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new GuestFsError(message.code as GuestFsError["code"], message.message));
    }
  }

  private async serveRead(message: Extract<ChildMessage, { t: "read" }>): Promise<void> {
    const reply = (data: Buffer | null, error?: string) => {
      if (this.closed || !this.child.connected) return;
      const answer: ParentMessage = data
        ? { t: "data", id: message.id, data }
        : { t: "data", id: message.id, error: error ?? "the read failed" };
      this.child.send(answer);
    };
    const disk = this.disks[message.disk];
    const { offset, length } = message;
    if (
      !disk ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      length > MAX_READ_BYTES ||
      offset + length > disk.size
    ) {
      reply(null, "a read outside the disk");
      return;
    }
    this.bytesRead += length;
    if (this.bytesRead > this.maxReadBytes) {
      this.fail(new GuestFsError("limit", "the reader read more of the disk than allowed"));
      this.close();
      return;
    }
    try {
      reply(await disk.read(offset, length));
    } catch (error) {
      reply(null, error instanceof Error ? error.message : "the read failed");
    }
  }

  private op<T>(message: ParentMessage & { t: "op" }): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new GuestFsError("limit", "the reader took too long"));
        this.close();
      }, this.timeoutMs);
      this.pending.set(message.id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.child.send(message);
    });
  }

  private id(): number {
    return this.nextId++;
  }

  volumes(): Promise<{ volumes: VolumeInfo[]; skipped: { id: string; reason: string }[] }> {
    return this.op({ t: "op", id: this.id(), op: "volumes" });
  }

  list(path: string): Promise<FsEntry[]> {
    return this.op({ t: "op", id: this.id(), op: "list", path });
  }

  stat(path: string): Promise<FsEntry | null> {
    return this.op({ t: "op", id: this.id(), op: "stat", path });
  }

  async open(path: string): Promise<{ size: number }> {
    return this.op({ t: "op", id: this.id(), op: "open", path });
  }

  read(path: string, offset: number, length: number): Promise<Buffer> {
    return this.op<Buffer>({ t: "op", id: this.id(), op: "read", path, offset, length }).then(
      (data) => Buffer.from(data),
    );
  }

  /** Whether the reader ended (it crashed, hit a limit or was closed): nothing more comes. */
  get failed(): boolean {
    return this.failure !== null;
  }

  /** How many disk bytes the child asked for. */
  get diskBytesRead(): number {
    return this.bytesRead;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.kill("SIGKILL");
  }
}
