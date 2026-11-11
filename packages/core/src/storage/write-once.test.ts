import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ObjectLockedError, type StorageBackend } from "./backend.js";
import { probeStorageBackend, resolveStorageTargets, storageProbePrefix } from "./factory.js";
import { LocalStorageBackend } from "./local.js";
import { WriteOnceBackend } from "./testing/write-once-backend.js";
import { isWriteRefused, writeOnceOfConfig, writeRefusalCode } from "./write-once.js";

const TENANT = "11111111-1111-4111-8111-111111111111";

describe("the write-once probe", () => {
  let dir: string;
  let local: LocalStorageBackend;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "restow-write-once-"));
    local = new LocalStorageBackend(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds an ordinary directory not write-once and leaves nothing behind", async () => {
    const probe = await probeStorageBackend(local, { keyPrefix: storageProbePrefix(TENANT) });
    expect(probe.ok).toBe(true);
    expect(probe.warnings).not.toContain("write_once");
    expect(probe.writeOnce).toMatchObject({ writeOnce: false, refused: [], code: null });
    expect(await local.list(storageProbePrefix(TENANT))).toEqual([]);
  });

  it("finds a share that refuses overwrite and delete (EPERM) write-once, and the probe passes [RETAIN-010]", async () => {
    const worm = new WriteOnceBackend(local);
    const probe = await probeStorageBackend(worm, { keyPrefix: storageProbePrefix(TENANT) });
    expect(probe.ok).toBe(true);
    expect(probe.failedStep).toBeNull();
    expect(probe.steps.map((step) => [step.step, step.ok])).toEqual([
      ["write", true],
      ["read", true],
      ["list", true],
      ["delete", true],
    ]);
    expect(probe.warnings).toContain("write_once");
    expect(probe.writeOnce).toMatchObject({
      writeOnce: true,
      refused: ["overwrite", "delete"],
      code: "EPERM",
    });
    // Nothing was deleted: the probe object stays where the share keeps it.
    expect(worm.refused.map((entry) => entry.op)).toEqual(["overwrite", "delete"]);
    expect(await local.list(storageProbePrefix(TENANT))).toHaveLength(1);
  });

  it("counts an overwrite the storage accepts but ignores, and an Object Lock refusal [RETAIN-010]", async () => {
    const ignoring: StorageBackend = {
      ...bind(local),
      async put(key, data, options) {
        if ((await local.head(key)) !== null) {
          return;
        }
        await local.put(key, data, options);
      },
      async delete(key) {
        throw new ObjectLockedError(key, new Date("2027-01-01T00:00:00Z"));
      },
    };
    const probe = await probeStorageBackend(ignoring, { keyPrefix: storageProbePrefix(TENANT) });
    expect(probe.ok).toBe(true);
    expect(probe.writeOnce).toMatchObject({
      writeOnce: true,
      refused: ["overwrite", "delete"],
      code: "ignored",
    });
  });

  it("still fails on a storage that cannot be written at all", async () => {
    const readOnly: StorageBackend = {
      ...bind(local),
      async put() {
        const error = new Error("read-only file system") as NodeJS.ErrnoException;
        error.code = "EROFS";
        throw error;
      },
    };
    const probe = await probeStorageBackend(readOnly, { keyPrefix: storageProbePrefix(TENANT) });
    expect(probe.ok).toBe(false);
    expect(probe.failedStep).toBe("write");
    expect(probe.writeOnce ?? null).toBeNull();
  });

  it("tells refusals from other errors", () => {
    const eperm = Object.assign(new Error("nope"), { code: "EPERM" });
    expect(writeRefusalCode(eperm)).toBe("EPERM");
    expect(writeRefusalCode(new Error("wrapped", { cause: eperm }))).toBe("EPERM");
    expect(writeRefusalCode({ name: "AccessDenied", $metadata: { httpStatusCode: 403 } })).toBe(
      "AccessDenied",
    );
    expect(writeRefusalCode(new ObjectLockedError("k", null))).toBe("object_lock");
    expect(isWriteRefused(Object.assign(new Error("gone"), { code: "ECONNRESET" }))).toBe(false);
    expect(isWriteRefused(Object.assign(new Error("gone"), { code: "ENOENT" }))).toBe(false);
  });

  it("reads the finding recorded with a target and resolves targets with it", async () => {
    const finding = {
      writeOnce: true,
      refused: ["delete"],
      code: "EPERM",
      checkedAt: "2026-11-05T10:00:00.000Z",
    };
    expect(writeOnceOfConfig({ basePath: dir, lastProbe: { writeOnce: finding } })).toEqual(
      finding,
    );
    expect(writeOnceOfConfig({ basePath: dir, lastProbe: { ok: true } })).toBeNull();
    expect(writeOnceOfConfig(null)).toBeNull();

    const resolved = await resolveStorageTargets(
      [
        {
          id: "row-primary",
          kind: "local",
          role: "primary",
          config: { basePath: dir, lastProbe: { writeOnce: finding } },
          secretRef: null,
        },
        {
          id: "row-copy",
          kind: "local",
          role: "copy",
          config: { basePath: dir },
          secretRef: null,
        },
      ],
      { secrets: { get: async () => null }, defaults: { primary: local, copies: [] } },
    );
    expect(resolved.targets.map((target) => [target.id, target.writeOnce])).toEqual([
      ["row-primary", true],
      ["row-copy", false],
    ]);
    const onDefault = await resolveStorageTargets([], {
      secrets: { get: async () => null },
      defaults: { primary: local, copies: [] },
      defaultWriteOnce: async () => true,
    });
    expect(onDefault.targets[0]).toMatchObject({ id: "installation_default", writeOnce: true });
  });
});

function bind(backend: LocalStorageBackend): StorageBackend {
  return {
    put: backend.put.bind(backend),
    get: backend.get.bind(backend),
    getStream: backend.getStream.bind(backend),
    head: backend.head.bind(backend),
    list: backend.list.bind(backend),
    delete: backend.delete.bind(backend),
  };
}
