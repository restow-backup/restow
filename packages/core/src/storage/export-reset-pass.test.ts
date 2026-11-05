import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../verify/testing.js";
import {
  DELETION_PASS_BEHAVIOUR,
  type DeletionGuard,
  installDeletionEnforcement,
  withDeletionPermit,
} from "./deletion-guard.js";
import {
  RestoreModeGuard,
  type RestoreModeSnapshot,
  type RestoreModeStore,
} from "./restore-mode-guard.js";

const T = "3a4b5c6d-7e8f-4a1b-9c2d-3e4f5a6b7c8d";

/** The database side of restore mode, in memory. */
class MemoryStore implements RestoreModeStore {
  state: RestoreModeSnapshot = {
    active: false,
    id: null,
    activatedAt: null,
    holdJobsBefore: null,
    keepUnknownBefore: null,
  };
  readonly refusals: string[] = [];
  async read() {
    return this.state;
  }
  async readDbSeq() {
    return 0;
  }
  async readDbKeyMax() {
    return 1;
  }
  async installationId() {
    return "inst-1";
  }
  async recordCheck() {}
  async activateDetected() {
    return { id: "rm-1", created: true };
  }
  async recordRefusal(input: { pass: string }) {
    this.refusals.push(input.pass);
  }
}

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return logger;
  },
};

function offline(): MemoryStorage {
  const storage = new MemoryStorage();
  storage.list = async () => {
    throw new Error("copy target offline");
  };
  return storage;
}

describe("an export starting its own file over (export_reset)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("is an own_scope pass", () => {
    expect(DELETION_PASS_BEHAVIOUR.export_reset).toBe("own_scope");
  });

  it("is not held by a copy target that cannot be compared, unlike a pass over database rows", async () => {
    const store = new MemoryStore();
    const guard = new RestoreModeGuard({
      store,
      targetsOf: async () => [
        { id: "primary", backend: new MemoryStorage() },
        { id: "copy", backend: offline() },
      ],
      logger,
    });
    expect(await guard.decide({ pass: "export_reset", tenantId: T })).toMatchObject({
      allowed: true,
    });
    expect(await guard.decide({ pass: "mail_files_cleanup", tenantId: T })).toMatchObject({
      allowed: false,
      reason: "progress_unknown",
    });
  });

  it("is allowed in restore mode for an export created before restore mode began", async () => {
    const store = new MemoryStore();
    const activatedAt = new Date("2026-11-01T00:00:00Z");
    store.state = {
      active: true,
      id: "rm-1",
      activatedAt,
      holdJobsBefore: activatedAt,
      keepUnknownBefore: null,
    };
    const guard = new RestoreModeGuard({ store, targetsOf: async () => [], logger });
    expect(
      await guard.decide({
        pass: "export_reset",
        tenantId: T,
        createdAt: new Date("2026-10-31T23:00:00Z"),
      }),
    ).toMatchObject({ allowed: true, inRestoreMode: true });
    expect(store.refusals).toEqual([]);
  });

  it("deletes its segments even when restore mode comes on after the permit was given", async () => {
    let holding = false;
    const guard: DeletionGuard = {
      decide: async () => ({ allowed: true, keepUnknownBefore: null, inRestoreMode: false }),
      holding: () => holding,
    };
    uninstall = installDeletionEnforcement(guard);
    const storage = new MemoryStorage();
    const key = `tenants/${T}/exports/e1/00000000.seg`;
    await storage.put(key, Buffer.from("x"));
    await withDeletionPermit({ pass: "export_reset", tenantId: T }, async () => {
      holding = true;
      await storage.delete(key);
    });
    expect(await storage.head(key)).toBeNull();
  });
});
