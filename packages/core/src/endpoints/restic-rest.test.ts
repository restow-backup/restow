import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../verify/testing.js";
import type { ResticPrincipal } from "./restic-authz.js";
import {
  QUOTA_EXCEEDED_PROBLEM,
  type ResticLockRegistry,
  handleResticRequest,
  objectKey,
  parseRange,
} from "./restic-rest.js";

/** The lock registry of the API, in memory. */
function lockRegistry(): ResticLockRegistry & { names: Set<string> } {
  const names = new Set<string>();
  return {
    names,
    isOwn: async (name) => names.has(name),
    created: async (name) => {
      names.add(name);
    },
    removed: async (name) => {
      names.delete(name);
    },
  };
}

const PREFIX = "endpoints/11111111-1111-4111-8111-111111111111/";
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const V2 = { accept: "application/vnd.x.restic.rest.v2" };

async function call(
  storage: MemoryStorage,
  principal: ResticPrincipal,
  method: string,
  path: string,
  init: {
    body?: Buffer;
    headers?: Record<string, string>;
    query?: string;
    maxBodyBytes?: number;
    locks?: ResticLockRegistry;
    remainingBytes?: number | null;
  } = {},
) {
  const request = new Request(`http://localhost${path}${init.query ?? ""}`, {
    method,
    headers: init.headers,
    body: init.body ? new Uint8Array(init.body) : undefined,
  });
  const denied: { action: string; reason: string }[] = [];
  const allowed: { action: string; bytes: number }[] = [];
  const overBudget: (number | null)[] = [];
  const response = await handleResticRequest(request, {
    storage,
    prefix: PREFIX,
    principal,
    path,
    query: new URLSearchParams(init.query?.replace(/^\?/, "") ?? ""),
    maxBodyBytes: init.maxBodyBytes,
    onDenied: ({ action, reason }) => denied.push({ action, reason }),
    onAllowed: ({ action, bytes }) => {
      allowed.push({ action, bytes });
    },
    locks: init.locks,
    remainingBytes:
      init.remainingBytes === undefined ? undefined : async () => init.remainingBytes ?? null,
    onQuotaExceeded: ({ declaredBytes }) => {
      overBudget.push(declaredBytes);
    },
  });
  return {
    response,
    denied,
    allowed,
    overBudget,
    text: async () => Buffer.from(await response.arrayBuffer()),
  };
}

describe("restic REST protocol on the storage abstraction", () => {
  it("keeps the folder layout of restic's own rest-server", () => {
    const name = `ab${"c".repeat(62)}`;
    expect(objectKey(PREFIX, { kind: "config" })).toBe(`${PREFIX}config`);
    expect(objectKey(PREFIX, { kind: "object", type: "data", name })).toBe(
      `${PREFIX}data/ab/${name}`,
    );
    expect(objectKey(PREFIX, { kind: "object", type: "index", name })).toBe(
      `${PREFIX}index/${name}`,
    );
  });

  it("stores an object under its content hash and reads it back", async () => {
    const storage = new MemoryStorage();
    const bytes = Buffer.from("a restic pack");
    const name = sha256(bytes);
    const post = await call(storage, "agent", "POST", `/data/${name}`, { body: bytes });
    expect(post.response.status).toBe(200);
    expect(storage.files.has(`${PREFIX}data/${name.slice(0, 2)}/${name}`)).toBe(true);

    const get = await call(storage, "agent", "GET", `/data/${name}`);
    expect(get.response.status).toBe(200);
    expect((await get.text()).equals(bytes)).toBe(true);

    const head = await call(storage, "agent", "HEAD", `/data/${name}`);
    expect(head.response.status).toBe(200);
    expect(head.response.headers.get("content-length")).toBe(String(bytes.length));
  });

  it("refuses an upload whose content does not match its name, and stores nothing", async () => {
    const storage = new MemoryStorage();
    const name = sha256("something else");
    const { response } = await call(storage, "agent", "POST", `/index/${name}`, {
      body: Buffer.from("not that"),
    });
    expect(response.status).toBe(400);
    expect(storage.files.size).toBe(0);
  });

  it("never overwrites an object for an agent (403), while maintenance may", async () => {
    const storage = new MemoryStorage();
    const bytes = Buffer.from("original");
    const name = sha256(bytes);
    await call(storage, "agent", "POST", `/snapshots/${name}`, { body: bytes });
    const again = await call(storage, "agent", "POST", `/snapshots/${name}`, { body: bytes });
    expect(again.response.status).toBe(403);
    expect(again.denied).toEqual([{ action: "write", reason: "exists" }]);
    const maintenance = await call(storage, "maintenance", "POST", `/snapshots/${name}`, {
      body: bytes,
    });
    expect(maintenance.response.status).toBe(200);
  });

  it("lets an agent delete the locks it wrote and nothing else", async () => {
    const storage = new MemoryStorage();
    const locks = lockRegistry();
    const lock = Buffer.from("lock");
    const pack = Buffer.from("pack");
    await call(storage, "agent", "POST", `/locks/${sha256(lock)}`, { body: lock, locks });
    expect(locks.names).toEqual(new Set([sha256(lock)]));
    await call(storage, "agent", "POST", `/data/${sha256(pack)}`, { body: pack, locks });

    const released = await call(storage, "agent", "DELETE", `/locks/${sha256(lock)}`, { locks });
    expect(released.response.status).toBe(200);
    expect(released.allowed).toEqual([{ action: "delete", bytes: lock.length }]);
    expect(locks.names.size).toBe(0);
    expect(storage.files.size).toBe(1);
    const refused = await call(storage, "agent", "DELETE", `/data/${sha256(pack)}`);
    expect(refused.response.status).toBe(403);
    expect(storage.files.size).toBe(1);
    expect(
      (await call(storage, "maintenance", "DELETE", `/data/${sha256(pack)}`)).response.status,
    ).toBe(200);
    expect(storage.files.size).toBe(0);
  });

  it("keeps the server's locks, and every lock the agent did not write, from the agent", async () => {
    const storage = new MemoryStorage();
    const locks = lockRegistry();
    // The exclusive lock of the server's prune, written through the maintenance listener.
    const pruneLock = Buffer.from('{"exclusive":true,"hostname":"restow-server"}');
    await call(storage, "maintenance", "POST", `/locks/${sha256(pruneLock)}`, { body: pruneLock });
    const refused = await call(storage, "agent", "DELETE", `/locks/${sha256(pruneLock)}`, {
      locks,
    });
    expect(refused.response.status).toBe(403);
    expect(refused.denied).toEqual([{ action: "delete", reason: "foreign_lock" }]);
    expect(storage.files.size).toBe(1);
    // Without a registry an agent cannot delete any lock.
    const own = Buffer.from("own lock");
    await call(storage, "agent", "POST", `/locks/${sha256(own)}`, { body: own });
    expect((await call(storage, "agent", "DELETE", `/locks/${sha256(own)}`)).response.status).toBe(
      403,
    );
    // The server may remove any lock.
    expect(
      (await call(storage, "maintenance", "DELETE", `/locks/${sha256(pruneLock)}`)).response.status,
    ).toBe(200);
  });

  it("forgets a lock that failed to upload or that is gone already", async () => {
    const storage = new MemoryStorage();
    const locks = lockRegistry();
    const name = sha256("the real content");
    const failed = await call(storage, "agent", "POST", `/locks/${name}`, {
      body: Buffer.from("other content"),
      locks,
    });
    expect(failed.response.status).toBe(400);
    expect(locks.names.size).toBe(0);
    // The server removed a stale lock; the agent releasing it later gets 404, not a refusal.
    locks.names.add(name);
    const gone = await call(storage, "agent", "DELETE", `/locks/${name}`, { locks });
    expect(gone.response.status).toBe(404);
    expect(gone.denied).toEqual([]);
    expect(locks.names.size).toBe(0);
  });

  it("answers 404 for a delete of something that is not there", async () => {
    const storage = new MemoryStorage();
    const missing = await call(storage, "maintenance", "DELETE", `/locks/${"a".repeat(64)}`);
    expect(missing.response.status).toBe(404);
  });

  describe("storage budget", () => {
    const pack = Buffer.alloc(2048, 7);
    const name = sha256(pack);

    it("refuses an upload that does not fit, by declared length and while streaming", async () => {
      const storage = new MemoryStorage();
      const declared = await call(storage, "agent", "POST", `/data/${name}`, {
        body: pack,
        headers: { "content-length": String(pack.length) },
        remainingBytes: 1000,
      });
      expect(declared.response.status).toBe(403);
      expect(declared.response.headers.get("content-type")).toBe("application/problem+json");
      expect(JSON.parse((await declared.text()).toString())).toMatchObject({
        type: QUOTA_EXCEEDED_PROBLEM,
        status: 403,
      });
      expect(declared.overBudget).toEqual([pack.length]);

      const streamed = await call(storage, "agent", "POST", `/data/${name}`, {
        body: pack,
        remainingBytes: 1000,
      });
      expect(streamed.response.status).toBe(403);
      expect(streamed.overBudget).toEqual([null]);
      expect(storage.files.size).toBe(0);

      const usedUp = await call(storage, "agent", "POST", `/data/${name}`, {
        body: pack,
        remainingBytes: 0,
      });
      expect(usedUp.response.status).toBe(403);
      expect(storage.files.size).toBe(0);
    });

    it("stores what fits and reports its size", async () => {
      const storage = new MemoryStorage();
      const stored = await call(storage, "agent", "POST", `/data/${name}`, {
        body: pack,
        remainingBytes: pack.length,
      });
      expect(stored.response.status).toBe(200);
      expect(stored.allowed).toEqual([{ action: "write", bytes: pack.length }]);
      const unlimited = await call(storage, "agent", "POST", `/index/${sha256("i")}`, {
        body: Buffer.from("i"),
        remainingBytes: null,
      });
      expect(unlimited.response.status).toBe(200);
    });

    it("never refuses a lock file, so a restore still works with the budget used up", async () => {
      const storage = new MemoryStorage();
      const locks = lockRegistry();
      const lock = Buffer.from("restore lock");
      const written = await call(storage, "agent", "POST", `/locks/${sha256(lock)}`, {
        body: lock,
        remainingBytes: 0,
        locks,
      });
      expect(written.response.status).toBe(200);
    });
  });

  it("refuses the config and the repository itself to an agent", async () => {
    const storage = new MemoryStorage();
    const config = await call(storage, "agent", "POST", "/config", { body: Buffer.from("{}") });
    expect(config.response.status).toBe(403);
    const create = await call(storage, "agent", "POST", "/", { query: "?create=true" });
    expect(create.response.status).toBe(403);
    const purge = await call(storage, "agent", "DELETE", "/");
    expect(purge.response.status).toBe(403);
    expect(storage.files.size).toBe(0);
  });

  it("lets maintenance create the repository and write its config once", async () => {
    const storage = new MemoryStorage();
    expect(
      (await call(storage, "maintenance", "POST", "/", { query: "?create=true" })).response.status,
    ).toBe(200);
    expect((await call(storage, "maintenance", "POST", "/")).response.status).toBe(400);
    const config = await call(storage, "maintenance", "POST", "/config", {
      body: Buffer.from("{}"),
    });
    expect(config.response.status).toBe(200);
    expect((await call(storage, "agent", "HEAD", "/config")).response.status).toBe(200);
    expect((await (await call(storage, "agent", "GET", "/config")).text()).toString()).toBe("{}");
  });

  it("purges only what belongs to the repository", async () => {
    const storage = new MemoryStorage();
    await storage.put("endpoints/other/config", Buffer.from("other"));
    await call(storage, "maintenance", "POST", "/config", { body: Buffer.from("{}") });
    const purge = await call(storage, "maintenance", "DELETE", "/");
    expect(purge.response.status).toBe(200);
    expect([...storage.files.keys()]).toEqual(["endpoints/other/config"]);
  });

  it("refuses names that could leave the repository", async () => {
    const storage = new MemoryStorage();
    for (const path of ["/data/../../x", "/nope/x", `/data/${"z".repeat(64)}`]) {
      const { response } = await call(storage, "maintenance", "GET", path);
      expect(response.status, path).toBe(404);
    }
  });

  describe("listing", () => {
    it("lists names and sizes in protocol v2", async () => {
      const storage = new MemoryStorage();
      const bytes = Buffer.from("twelve bytes");
      const name = sha256(bytes);
      await call(storage, "agent", "POST", `/data/${name}`, { body: bytes });
      const list = await call(storage, "agent", "GET", "/data/", { headers: V2 });
      expect(list.response.headers.get("content-type")).toBe("application/vnd.x.restic.rest.v2");
      expect(JSON.parse((await list.text()).toString())).toEqual([{ name, size: 12 }]);
    });

    it("lists names only in protocol v1", async () => {
      const storage = new MemoryStorage();
      const bytes = Buffer.from("x");
      const name = sha256(bytes);
      await call(storage, "agent", "POST", `/keys/${name}`, { body: bytes });
      const list = await call(storage, "agent", "GET", "/keys/");
      expect(JSON.parse((await list.text()).toString())).toEqual([name]);
    });

    it("is empty for a type nothing was written to", async () => {
      const list = await call(new MemoryStorage(), "agent", "GET", "/locks/", { headers: V2 });
      expect(JSON.parse((await list.text()).toString())).toEqual([]);
    });
  });

  describe("ranges", () => {
    const bytes = Buffer.from("0123456789");
    const name = sha256(bytes);
    const seed = async () => {
      const storage = new MemoryStorage();
      await call(storage, "agent", "POST", `/data/${name}`, { body: bytes });
      return storage;
    };

    it("serves a byte range with 206", async () => {
      const storage = await seed();
      const { response, text } = await call(storage, "agent", "GET", `/data/${name}`, {
        headers: { range: "bytes=2-5" },
      });
      expect(response.status).toBe(206);
      expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
      expect((await text()).toString()).toBe("2345");
    });

    it("serves an open-ended and a suffix range", async () => {
      const storage = await seed();
      const open = await call(storage, "agent", "GET", `/data/${name}`, {
        headers: { range: "bytes=7-" },
      });
      expect((await open.text()).toString()).toBe("789");
      const tail = await call(storage, "agent", "GET", `/data/${name}`, {
        headers: { range: "bytes=-3" },
      });
      expect((await tail.text()).toString()).toBe("789");
    });

    it("answers 416 for a range behind the end", async () => {
      const storage = await seed();
      const { response } = await call(storage, "agent", "GET", `/data/${name}`, {
        headers: { range: "bytes=50-60" },
      });
      expect(response.status).toBe(416);
      expect(response.headers.get("content-range")).toBe("bytes */10");
    });

    it("parses the header forms", () => {
      expect(parseRange(null, 10)).toBe("ignore");
      expect(parseRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
      expect(parseRange("bytes=3-", 10)).toEqual({ start: 3, end: 9 });
      expect(parseRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
      expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
      expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
      expect(parseRange("bytes=0-1,4-5", 10)).toBe("ignore");
      expect(parseRange("items=0-1", 10)).toBe("ignore");
    });
  });

  it("refuses a body over the limit, by declared length and while streaming", async () => {
    const storage = new MemoryStorage();
    const bytes = Buffer.alloc(2048, 1);
    const name = sha256(bytes);
    const declared = await call(storage, "agent", "POST", `/data/${name}`, {
      body: bytes,
      headers: { "content-length": String(bytes.length) },
      maxBodyBytes: 1024,
    });
    expect(declared.response.status).toBe(413);

    const request = new Request(`http://localhost/data/${name}`, {
      method: "POST",
      body: Readable.toWeb(Readable.from([bytes.subarray(0, 1024), bytes.subarray(1024)])) as never,
      duplex: "half",
    } as RequestInit);
    const streamed = await handleResticRequest(request, {
      storage,
      prefix: PREFIX,
      principal: "agent",
      path: `/data/${name}`,
      maxBodyBytes: 1024,
    });
    expect(streamed.status).toBe(413);
    expect(storage.files.size).toBe(0);
  });
});
