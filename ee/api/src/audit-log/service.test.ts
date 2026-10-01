import type { SQL } from "drizzle-orm";
import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { ProblemError } from "../../../../apps/api/src/problem.js";
import { decodeAuditCursor, encodeAuditCursor, pageOf } from "./cursor.js";
import { overallStatus } from "./dto.js";
import { INSTALLATION_CHAIN, chainQuerySchema, listAuditQuerySchema } from "./schemas.js";
import { escapeLike, listConditions, selectChains } from "./service.js";

const TENANT = "0f1e2d3c-4b5a-4978-8899-aabbccddeeff";
const OTHER = "11111111-2222-4333-8444-555555555555";
const dialect = new PgDialect();

function render(conditions: SQL[]) {
  return dialect.sqlToQuery(and(...conditions) as SQL);
}

describe("selectChains", () => {
  it("gives provider admins everything, the installation chain or one tenant", () => {
    expect(selectChains({ kind: "provider" }, undefined)).toEqual({ kind: "all" });
    expect(selectChains({ kind: "provider" }, INSTALLATION_CHAIN)).toEqual({
      kind: "installation",
    });
    expect(selectChains({ kind: "provider" }, TENANT)).toEqual({
      kind: "tenant",
      tenantId: TENANT,
    });
  });

  it("pins tenant admins to their own tenant", () => {
    const scope = { kind: "tenant", tenantId: TENANT } as const;
    expect(selectChains(scope, undefined)).toEqual({ kind: "tenant", tenantId: TENANT });
    expect(selectChains(scope, TENANT)).toEqual({ kind: "tenant", tenantId: TENANT });
    for (const requested of [OTHER, INSTALLATION_CHAIN]) {
      expect(() => selectChains(scope, requested)).toThrow(ProblemError);
      try {
        selectChains(scope, requested);
      } catch (error) {
        expect((error as ProblemError).status).toBe(404);
      }
    }
  });
});

describe("escapeLike", () => {
  it("escapes wildcards and the escape character", () => {
    expect(escapeLike("role_changed")).toBe("role\\_changed");
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("plain")).toBe("plain");
  });
});

describe("listConditions", () => {
  it("adds nothing for an unfiltered provider view", () => {
    expect(listConditions({ kind: "all" }, {}, null)).toEqual([]);
  });

  it("scopes to the installation chain or one tenant", () => {
    expect(render(listConditions({ kind: "installation" }, {}, null)).sql).toBe(
      '"audit_log"."tenant_id" is null',
    );
    const tenant = render(listConditions({ kind: "tenant", tenantId: TENANT }, {}, null));
    expect(tenant.sql).toBe('"audit_log"."tenant_id" = $1');
    expect(tenant.params).toEqual([TENANT]);
  });

  it("matches an action exactly or as a dotted prefix, with wildcards escaped", () => {
    const query = render(
      listConditions({ kind: "all" }, { action: "tenant.member.role_changed" }, null),
    );
    expect(query.sql).toBe('("audit_log"."action" = $1 or "audit_log"."action" like $2)');
    expect(query.params).toEqual(["tenant.member.role_changed", "tenant.member.role\\_changed.%"]);
  });

  it("searches actor labels and ids, targets and the time window", () => {
    const query = render(
      listConditions(
        { kind: "all" },
        {
          actor: "ops@",
          target: "50%",
          from: "2026-09-01T00:00:00+02:00",
          to: "2026-09-02T00:00:00Z",
        },
        null,
      ),
    );
    expect(query.sql).toBe(
      '(("audit_log"."actor" ilike $1 or "audit_log"."actor_user_id" = $2) and "audit_log"."target" ilike $3 and "audit_log"."created_at" >= $4 and "audit_log"."created_at" < $5)',
    );
    expect(query.params).toEqual([
      "%ops@%",
      "ops@",
      "%50\\%%",
      "2026-08-31T22:00:00.000Z",
      "2026-09-02T00:00:00.000Z",
    ]);
  });

  it("continues strictly after the cursor, newest first", () => {
    const cursor = { createdAt: "2026-09-21T10:00:00.000Z", id: OTHER };
    const query = render(listConditions({ kind: "tenant", tenantId: TENANT }, {}, cursor));
    expect(query.sql).toBe(
      '("audit_log"."tenant_id" = $1 and ("audit_log"."created_at" < $2 or ("audit_log"."created_at" = $3 and "audit_log"."id" < $4)))',
    );
    expect(query.params).toEqual([TENANT, cursor.createdAt, cursor.createdAt, OTHER]);
  });
});

describe("audit cursor", () => {
  it("round-trips and rejects anything else", () => {
    const cursor = { createdAt: "2026-09-21T10:00:00.000Z", id: OTHER };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor("not-a-cursor")).toBeNull();
    expect(decodeAuditCursor(Buffer.from("[]").toString("base64url"))).toBeNull();
    expect(
      decodeAuditCursor(
        Buffer.from(JSON.stringify({ createdAt: "x", id: OTHER })).toString("base64url"),
      ),
    ).toBeNull();
    expect(
      decodeAuditCursor(
        Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: "1" })).toString("base64url"),
      ),
    ).toBeNull();
  });

  it("pages limit + 1 rows and points the cursor at the last returned row", () => {
    const rows = [3, 2, 1].map((n) => ({
      id: `0000000${n}-0000-4000-8000-000000000000`,
      createdAt: new Date(`2026-09-2${n}T00:00:00.000Z`),
    }));
    const full = pageOf(rows, 2, (row) => row);
    expect(full.rows).toEqual(rows.slice(0, 2));
    expect(decodeAuditCursor(full.next as string)).toEqual({
      createdAt: "2026-09-22T00:00:00.000Z",
      id: rows[1]?.id,
    });
    expect(pageOf(rows, 3, (row) => row)).toEqual({ rows, next: null });
    expect(pageOf([], 3, (row: { id: string; createdAt: Date }) => row)).toEqual({
      rows: [],
      next: null,
    });
  });
});

describe("query schemas", () => {
  it("applies defaults and treats blank text as no filter", () => {
    expect(listAuditQuerySchema.parse({ actor: "  ", target: "" })).toEqual({ limit: 50 });
    expect(listAuditQuerySchema.parse({ actor: " ops@example.com ", limit: "10" })).toEqual({
      actor: "ops@example.com",
      limit: 10,
    });
  });

  it("accepts dotted action codes and prefixes only", () => {
    expect(listAuditQuerySchema.safeParse({ action: "restore" }).success).toBe(true);
    expect(listAuditQuerySchema.safeParse({ action: "tenant.member.role_changed" }).success).toBe(
      true,
    );
    expect(listAuditQuerySchema.safeParse({ action: "restore.%" }).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ action: "restore." }).success).toBe(false);
  });

  it("rejects an empty or inverted time window and oversized pages", () => {
    const window = { from: "2026-09-02T00:00:00Z", to: "2026-09-01T00:00:00Z" };
    expect(listAuditQuerySchema.safeParse(window).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ ...window, to: window.from }).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false);
    expect(listAuditQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("names a chain by tenant id or as the installation chain", () => {
    expect(chainQuerySchema.parse({ tenant: INSTALLATION_CHAIN })).toEqual({
      tenant: "installation",
    });
    expect(chainQuerySchema.parse({ tenant: TENANT })).toEqual({ tenant: TENANT });
    expect(chainQuerySchema.safeParse({ tenant: "acme" }).success).toBe(false);
  });
});

describe("overallStatus", () => {
  it("lets any break win, then any entries", () => {
    expect(overallStatus(["intact", "broken", "empty"])).toBe("broken");
    expect(overallStatus(["empty", "intact"])).toBe("intact");
    expect(overallStatus(["empty"])).toBe("empty");
    expect(overallStatus([])).toBe("empty");
  });
});
