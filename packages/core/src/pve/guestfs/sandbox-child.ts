import type { ChildMessage, ParentMessage } from "./protocol.js";
import { type ByteSource, checkRange, type FsFile, GuestFsError } from "./source.js";
import { discoverVolumes, GuestFiles } from "./volumes.js";

/**
 * The sandboxed reader of a VM restore point's file systems (sandbox.ts starts it). It runs in
 * a child process under Node's permission model: no file system access beyond its own code, no
 * child processes, no workers, an empty environment, a small heap. All it gets of the guest are
 * the bytes it asks its parent for; all it gives back are listings and file contents. Guest
 * data that crashes or hangs a reader ends this process, never the API.
 */

const send = (message: ChildMessage) => {
  process.send?.(message);
};

let nextRead = 1;
const pendingReads = new Map<
  number,
  { resolve: (b: Buffer) => void; reject: (e: Error) => void }
>();

class RemoteDisk implements ByteSource {
  constructor(
    private readonly index: number,
    readonly size: number,
  ) {}
  read(offset: number, length: number): Promise<Buffer> {
    checkRange(this.size, offset, length);
    const id = nextRead++;
    return new Promise((resolve, reject) => {
      pendingReads.set(id, { resolve, reject });
      send({ t: "read", id, disk: this.index, offset, length });
    });
  }
}

let files: Promise<GuestFiles> | null = null;
let opened: { path: string; file: FsFile } | null = null;

async function handle(message: Extract<ParentMessage, { t: "op" }>) {
  if (!files) throw new GuestFsError("io", "not initialised");
  const guest = await files;
  switch (message.op) {
    case "volumes":
      return {
        volumes: guest.found.volumes.map(({ fs: _fs, ...info }) => info),
        skipped: guest.found.skipped,
      };
    case "list":
      return guest.list(message.path);
    case "stat":
      return guest.stat(message.path);
    case "open": {
      const file = await guest.open(message.path);
      opened = { path: message.path, file };
      return { size: file.size };
    }
    case "read": {
      if (opened?.path !== message.path) {
        opened = { path: message.path, file: await guest.open(message.path) };
      }
      return opened.file.read(message.offset, message.length);
    }
  }
}

process.on("message", (raw: ParentMessage) => {
  if (raw.t === "init") {
    const disks = raw.disks.map((d, i) => ({
      device: d.device,
      source: new RemoteDisk(i, d.size),
    }));
    files = discoverVolumes(disks).then((found) => new GuestFiles(found));
    send({ t: "ready" });
    return;
  }
  if (raw.t === "data") {
    const pending = pendingReads.get(raw.id);
    pendingReads.delete(raw.id);
    if (!pending) return;
    if (raw.data) pending.resolve(Buffer.from(raw.data));
    else pending.reject(new GuestFsError("io", raw.error ?? "the read failed"));
    return;
  }
  if (raw.t === "op") {
    handle(raw).then(
      (value) => send({ t: "result", id: raw.id, ok: true, value: value as never }),
      (error: unknown) =>
        send({
          t: "result",
          id: raw.id,
          ok: false,
          code: error instanceof GuestFsError ? error.code : "damaged",
          message: error instanceof Error ? error.message.slice(0, 500) : "failed",
        }),
    );
  }
});

process.on("disconnect", () => process.exit(0));
