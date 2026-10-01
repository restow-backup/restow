import { describe, expect, it } from "vitest";
import { featureUnavailable } from "../../lib/features.js";
import { ProblemError } from "../../problem.js";
import { TENANT_ID } from "../../routes/v1/testing/keys.js";
import { type ScriptedDb, scriptedDb } from "../../routes/v1/testing/scripted-db.js";
import { type KeyTenantDeps, isWriteMethod, resolveKeyTenant } from "./key-tenant.js";

/**
 * The tenant rules every API-key surface shares: the integration API and the
 * feature routes on the same `/api/v1` paths (jobs, webhooks). A provider key
 * works only while `apiKeys.provider` is on, and nobody changes a tenant that
 * is suspended or being deleted.
 */

type Status = "active" | "suspended" | "deleting";

const tenantRow = (status: Status = "active") => ({
  id: TENANT_ID,
  name: "Contoso",
  slug: "contoso",
  status,
  mailboxCap: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const providerKey = { tenantId: null, isProvider: true };
const tenantKey = { tenantId: TENANT_ID, isProvider: false };

function deps(script: ScriptedDb, providerKeys = true): KeyTenantDeps {
  return {
    db: script.db,
    requireFeature: async (_db, feature) => {
      if (!providerKeys) {
        throw featureUnavailable(feature);
      }
    },
  };
}

async function problemOf(promise: Promise<unknown>): Promise<ProblemError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProblemError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a problem");
}

describe("isWriteMethod", () => {
  it("treats every method but GET, HEAD and OPTIONS as a change", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "post"]) {
      expect(isWriteMethod(method)).toBe(true);
    }
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(isWriteMethod(method)).toBe(false);
    }
  });
});

describe("resolveKeyTenant", () => {
  it("resolves a provider key's named tenant while provider keys are on", async () => {
    const script = scriptedDb([[tenantRow()]]);
    const tenant = await resolveKeyTenant(deps(script), providerKey, TENANT_ID, true);
    expect(tenant).toMatchObject({ id: TENANT_ID, slug: "contoso" });
    expect(script.pending()).toBe(0);
  });

  it("refuses provider keys once they are off, before touching any tenant", async () => {
    const script = scriptedDb([]);
    const problem = await problemOf(
      resolveKeyTenant(deps(script, false), providerKey, TENANT_ID, false),
    );
    expect(problem.status).toBe(403);
    expect(problem.type).toBe("urn:restow:problem:feature-unavailable");
    expect(problem.extensions).toEqual({ feature: "apiKeys.provider" });
    expect(script.executed).toBe(0);
  });

  it("does not ask tenant keys for the provider key feature", async () => {
    const script = scriptedDb([[tenantRow()]]);
    const tenant = await resolveKeyTenant(deps(script, false), tenantKey, undefined, true);
    expect(tenant.id).toBe(TENANT_ID);
  });

  it("reports a tenant that does not exist", async () => {
    const problem = await problemOf(
      resolveKeyTenant(deps(scriptedDb([[]])), providerKey, TENANT_ID, false),
    );
    expect(problem.status).toBe(404);
  });

  it("lets a provider key read a suspended or deleting tenant but change nothing", async () => {
    for (const status of ["suspended", "deleting"] as const) {
      const read = await resolveKeyTenant(
        deps(scriptedDb([[tenantRow(status)]])),
        providerKey,
        TENANT_ID,
        false,
      );
      expect(read.status).toBe(status);

      const write = await problemOf(
        resolveKeyTenant(deps(scriptedDb([[tenantRow(status)]])), providerKey, TENANT_ID, true),
      );
      expect(write.status).toBe(409);
      expect(write.type).toBe("urn:restow:problem:tenant-not-active");
    }
  });

  it("refuses a suspended tenant's own key even for reads", async () => {
    const problem = await problemOf(
      resolveKeyTenant(deps(scriptedDb([[tenantRow("suspended")]])), tenantKey, undefined, false),
    );
    expect(problem.status).toBe(403);
  });
});
