import auditDe from "@restow/i18n/resources/de/audit.json" with { type: "json" };
import auditEn from "@restow/i18n/resources/en/audit.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { V1_AUDIT_ACTIONS } from "../../routes/v1/audit.js";
import { KEY_READ_AUDIT, type KeyRead, keyReadEvent, readShape } from "./read-audit.js";
import { API_SCOPES } from "./scopes.js";

const TENANT = "5a0c7c1e-8d2b-4c3a-9f1e-2b3c4d5e6f70";
const JOB = "0b4b8a9e-3c1d-4e2f-8a7b-6c5d4e3f2a1b";

function keyRead(overrides: Partial<KeyRead> = {}): KeyRead {
  return {
    scope: "jobs:read",
    tenantId: TENANT,
    actor: { keyId: "key-1", label: "api-key:key-1", ip: "203.0.113.7" },
    method: "GET",
    route: "/api/v1/jobs",
    itemId: undefined,
    stream: false,
    query: {},
    ...overrides,
  };
}

type Tree = { [key: string]: string | Tree };

function label(tree: Tree, action: string): unknown {
  let node: string | Tree | undefined = tree;
  for (const segment of ["events", ...action.split(".")]) {
    node = typeof node === "object" ? node[segment] : undefined;
  }
  return node;
}

describe("readShape", () => {
  it("tells lists, single items and streams apart", () => {
    expect(readShape({ itemId: undefined, stream: false })).toBe("list");
    expect(readShape({ itemId: JOB, stream: false })).toBe("item");
    expect(readShape({ itemId: JOB, stream: true })).toBe("stream");
  });
});

describe("KEY_READ_AUDIT", () => {
  it("decides every scope", () => {
    expect(Object.keys(KEY_READ_AUDIT).sort()).toEqual([...API_SCOPES].sort());
  });

  it("records only under the integration API's own, translated action names", () => {
    const known = new Set<string>(Object.values(V1_AUDIT_ACTIONS));
    for (const rule of Object.values(KEY_READ_AUDIT)) {
      for (const action of Object.values(rule?.actions ?? {})) {
        expect(known).toContain(action);
        expect(typeof label(auditEn as Tree, action)).toBe("string");
        expect(typeof label(auditDe as Tree, action)).toBe("string");
      }
    }
  });

  it("records reads of user and backup data, not configuration or changes", () => {
    const recorded = API_SCOPES.filter((scope) => KEY_READ_AUDIT[scope] !== null);
    expect(recorded.sort()).toEqual(["archive:read", "items:read", "jobs:read", "users:read"]);
  });
});

describe("keyReadEvent", () => {
  it("records a list against the tenant with the filters that were set", () => {
    expect(keyReadEvent(keyRead({ query: { status: "failed" } }))).toEqual({
      tenantId: TENANT,
      actor: "api-key:key-1",
      actorUserId: null,
      action: "api.jobs.read",
      target: TENANT,
      targetType: "tenant",
      ip: "203.0.113.7",
      details: { keyId: "key-1", route: "GET /api/v1/jobs", filters: { status: "failed" } },
    });
  });

  it("records one item and a stream against the item", () => {
    expect(keyReadEvent(keyRead({ route: "/api/v1/jobs/:id", itemId: JOB }))).toMatchObject({
      action: "api.job.read",
      target: JOB,
      targetType: "job",
    });
    expect(
      keyReadEvent(keyRead({ route: "/api/v1/jobs/:id/events", itemId: JOB, stream: true })),
    ).toMatchObject({ action: "api.job.events.opened", target: JOB, targetType: "job" });
  });

  it("records nothing for scopes without user or backup data", () => {
    expect(keyReadEvent(keyRead({ scope: "webhooks:manage" }))).toBeNull();
    expect(keyReadEvent(keyRead({ scope: "status:read" }))).toBeNull();
  });
});
