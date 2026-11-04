import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStorageBackend, type StorageBackend } from "@restow/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blocksSwitch,
  planRepositories,
  type RepositoryOwner,
  type RepositorySource,
} from "./storage-migration-restic.js";

/**
 * How a restic repository is judged across the storage targets (docs/STORAGE.md, "restic
 * repositories in a move", "Repository repair"), on folders with restic's layout.
 */

const PREFIX = "pve-guests/3043b333-7b6e-4a0d-b186-955c5f426621/";
const owner: RepositoryOwner = {
  prefix: PREFIX,
  kind: "container",
  ownerId: "3043b333-7b6e-4a0d-b186-955c5f426621",
  name: "ct109",
  secretId: null,
  secretKind: "pve_ct_repository",
  created: true,
};

let root: string;
let primary: RepositorySource;
let other: RepositorySource;

async function file(backend: StorageBackend, kind: string, content: string): Promise<string> {
  const hash = createHash("sha256").update(content).digest("hex");
  const key =
    kind === "data" ? `${PREFIX}data/${hash.slice(0, 2)}/${hash}` : `${PREFIX}${kind}/${hash}`;
  await backend.put(key, Buffer.from(content));
  return key;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "restow-plan-"));
  primary = {
    id: "nfw",
    name: "NFW-01",
    role: "primary",
    backend: new LocalStorageBackend(join(root, "nfw")),
  };
  other = {
    id: "installation_default",
    name: "Installation default",
    role: "installation_default",
    backend: new LocalStorageBackend(join(root, "default")),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("planRepositories", () => {
  it("calls a repository split across two targets split, and collects both halves", async () => {
    await other.backend.put(`${PREFIX}config`, Buffer.from("config"));
    const key = await file(other.backend, "keys", "key");
    const early = await file(other.backend, "data", "early");
    const late = await file(primary.backend, "data", "late");
    const snapshot = await file(primary.backend, "snapshots", "snapshot");
    await primary.backend.put(`${PREFIX}locks/${"0".repeat(64)}`, Buffer.from("lock"));
    const [plan] = await planRepositories([owner], [primary, other]);
    expect(plan?.class).toBe("split");
    expect(plan?.configSource?.id).toBe("installation_default");
    expect(plan?.items.map((item) => item.key).sort()).toEqual(
      [`${PREFIX}config`, key, early, late, snapshot].sort(),
    );
    expect(plan?.missingOnReference).toBe(3);
    expect(blocksSwitch(plan as never)).toBe(false);
  });

  it("calls one complete elsewhere `elsewhere`, and one complete on the primary `ok`", async () => {
    await other.backend.put(`${PREFIX}config`, Buffer.from("config"));
    await file(other.backend, "keys", "key");
    await file(other.backend, "snapshots", "snapshot");
    expect((await planRepositories([owner], [primary, other]))[0]?.class).toBe("elsewhere");
    expect((await planRepositories([owner], [other, primary]))[0]?.class).toBe("ok");
  });

  it("leaves another chain out: a new one on the primary, the old one on a retired target", async () => {
    await primary.backend.put(`${PREFIX}config`, Buffer.from("new chain"));
    const key = await file(primary.backend, "keys", "new key");
    await other.backend.put(`${PREFIX}config`, Buffer.from("old chain"));
    const old = await file(other.backend, "snapshots", "old snapshot");
    const [plan] = await planRepositories([owner], [primary, other]);
    expect(plan?.class).toBe("ok");
    expect(plan?.items.map((item) => item.key)).toEqual([`${PREFIX}config`, key]);
    expect(plan?.items.map((item) => item.key)).not.toContain(old);
  });

  it("calls two chains and none on the primary a conflict, which stops a switch", async () => {
    await primary.backend.put(`${PREFIX}restow-repository-password.json`, Buffer.from("sealed"));
    const third: RepositorySource = {
      id: "previous",
      name: "Old NAS",
      role: "previous",
      backend: new LocalStorageBackend(join(root, "old")),
    };
    await other.backend.put(`${PREFIX}config`, Buffer.from("one"));
    await file(other.backend, "keys", "key one");
    await third.backend.put(`${PREFIX}config`, Buffer.from("two"));
    await file(third.backend, "keys", "key two");
    const [plan] = await planRepositories([owner], [primary, other, third]);
    expect(plan?.class).toBe("conflict");
    expect(plan?.items).toEqual([]);
    expect(blocksSwitch(plan as never)).toBe(true);
  });

  it("calls data without config or key `data_only` (it stops a switch) and a lone password file `password_only`", async () => {
    await file(primary.backend, "data", "pack");
    await file(primary.backend, "snapshots", "snapshot");
    const [dataOnly] = await planRepositories([owner], [primary, other]);
    expect(dataOnly?.class).toBe("data_only");
    expect(blocksSwitch(dataOnly as never)).toBe(true);

    await rm(join(root, "nfw"), { recursive: true, force: true });
    await other.backend.put(`${PREFIX}restow-repository-password.json`, Buffer.from("sealed"));
    const [passwordOnly] = await planRepositories([owner], [primary, other]);
    expect(passwordOnly?.class).toBe("password_only");
    expect(blocksSwitch(passwordOnly as never)).toBe(false);

    await rm(join(root, "default"), { recursive: true, force: true });
    const [missing] = await planRepositories([owner], [primary, other]);
    expect(missing?.class).toBe("missing");
    expect(blocksSwitch(missing as never)).toBe(false);
  });

  it("skips an optional place that does not answer, but never the primary", async () => {
    await primary.backend.put(`${PREFIX}config`, Buffer.from("config"));
    await file(primary.backend, "keys", "key");
    const broken: StorageBackend = {
      ...primary.backend,
      list: async () => {
        throw new Error("ECONNREFUSED");
      },
    } as StorageBackend;
    const optional = { ...other, backend: broken, optional: true };
    expect((await planRepositories([owner], [primary, optional]))[0]?.class).toBe("ok");
    await expect(
      planRepositories([owner], [{ ...primary, backend: broken }, other]),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
