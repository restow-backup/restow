import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../verify/testing.js";
import {
  DELETION_PASS_BEHAVIOUR,
  installDeletionEnforcement,
  withDeletionPermit,
  withStorageOperation,
} from "./deletion-guard.js";
import {
  RestoreModeGuard,
  type RestoreModeSnapshot,
  type RestoreModeStore,
} from "./restore-mode-guard.js";

const T = "4b5c6d7e-8f9a-4b1c-9d2e-3f4a5b6c7d8e";

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

/**
 * A failed enrollment's repository: restic wrote it through the loopback, so its objects are
 * not among the request's own writes. The clean-up runs the way enrollEndpoint runs it.
 */
async function failedEnrollment(storage: MemoryStorage): Promise<string[]> {
  const endpointId = randomUUID();
  const prefix = `tenants/${T}/endpoints/${endpointId}/`;
  for (const name of ["config", "keys/k1", "data/00/0001", "restow-repository-password.json"]) {
    await storage.put(`${prefix}${name}`, Buffer.from(name));
  }
  await withStorageOperation(() =>
    withDeletionPermit({ pass: "enrollment_cleanup", tenantId: T }, async () => {
      for (const key of await storage.list(prefix)) {
        await storage.delete(key);
      }
    }),
  );
  return storage.list(prefix);
}

describe("a failed enrollment removing the repository it began (enrollment_cleanup)", () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
  });

  it("is an own_scope pass", () => {
    expect(DELETION_PASS_BEHAVIOUR.enrollment_cleanup).toBe("own_scope");
  });

  it("removes the whole repository in restore mode, with no refusal recorded", async () => {
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
    await guard.restoreMode(true);
    uninstall = installDeletionEnforcement(guard, { strict: true });
    expect(await failedEnrollment(new MemoryStorage())).toEqual([]);
    expect(store.refusals).toEqual([]);
  });

  it("removes the whole repository while a copy target cannot be compared", async () => {
    const guard = new RestoreModeGuard({
      store: new MemoryStore(),
      targetsOf: async () => [
        { id: "primary", backend: new MemoryStorage() },
        { id: "copy", backend: offline() },
      ],
      logger,
    });
    uninstall = installDeletionEnforcement(guard, { strict: true });
    expect(await failedEnrollment(new MemoryStorage())).toEqual([]);
  });
});
