import { describe, expect, it } from "vitest";
import {
  bulkConfirmInactiveSchema,
  bulkFilterSchema,
  bulkProtectionSchema,
  confirmInactiveSchema,
  objectsFilterSchema,
  objectsQuerySchema,
  peopleQuerySchema,
} from "./schemas.js";

describe("peopleQuerySchema", () => {
  it("searches everyone by default and caps the page", () => {
    expect(peopleQuerySchema.parse({})).toEqual({ search: "", limit: 20 });
    expect(peopleQuerySchema.parse({ search: "  ali ", limit: "5" })).toEqual({
      search: "ali",
      limit: 5,
    });
    expect(peopleQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(peopleQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
    expect(peopleQuerySchema.safeParse({ search: "x".repeat(201) }).success).toBe(false);
  });
});

describe("objectsQuerySchema", () => {
  it("reads `sharedOrBlocked` from the query string as `true`/`false` text", () => {
    expect(objectsQuerySchema.parse({ sharedOrBlocked: "true" }).sharedOrBlocked).toBe(true);
    expect(objectsQuerySchema.parse({ sharedOrBlocked: "false" }).sharedOrBlocked).toBe(false);
    expect(objectsQuerySchema.safeParse({ sharedOrBlocked: true }).success).toBe(false);
  });
});

describe("bulkFilterSchema", () => {
  it("reads `sharedOrBlocked` as a real JSON boolean, not query-string text", () => {
    // Regression test for HIGH-1: the web client's "select all N matching"
    // sends this filter as a JSON body (apps/web/.../api.ts bulkSetProtection),
    // where `sharedOrBlocked` is a genuine boolean, never the string the
    // query-string schema expects.
    expect(bulkFilterSchema.parse({ sharedOrBlocked: true }).sharedOrBlocked).toBe(true);
    expect(bulkFilterSchema.parse({ sharedOrBlocked: false }).sharedOrBlocked).toBe(false);
    expect(bulkFilterSchema.parse({}).sharedOrBlocked).toBeUndefined();
    expect(bulkFilterSchema.safeParse({ sharedOrBlocked: "true" }).success).toBe(false);
  });

  it("still accepts the other filter fields unchanged", () => {
    const parsed = bulkFilterSchema.parse({
      search: "alice",
      kind: "mailbox",
      status: "not_selected",
      sourceId: "11111111-1111-4111-8111-111111111111",
      sharedOrBlocked: false,
    });
    expect(parsed).toEqual({
      search: "alice",
      kind: "mailbox",
      status: "not_selected",
      sourceId: "11111111-1111-4111-8111-111111111111",
      sharedOrBlocked: false,
    });
  });
});

describe("bulkProtectionSchema", () => {
  const objectIds = ["11111111-1111-4111-8111-111111111111"];

  it("accepts a bulk request whose filter carries a real boolean `sharedOrBlocked`", () => {
    // Before HIGH-1 was fixed, the bulk endpoint reused `objectsFilterSchema`
    // (query-string shape) for its JSON body, and this exact request — what
    // "select all N matching" sends when a shared/blocked filter is active —
    // failed with a validation error.
    const result = bulkProtectionSchema.safeParse({
      action: "exclude",
      filter: { sharedOrBlocked: true },
    });
    expect(result.success).toBe(true);
  });

  it("still requires exactly one of objectIds or filter", () => {
    expect(bulkProtectionSchema.safeParse({ action: "include" }).success).toBe(false);
    expect(
      bulkProtectionSchema.safeParse({ action: "include", objectIds, filter: {} }).success,
    ).toBe(false);
    expect(bulkProtectionSchema.safeParse({ action: "include", objectIds }).success).toBe(true);
  });
});

describe("objectsFilterSchema", () => {
  it("keeps the query-string `true`/`false` text shape for the objects list and groups search", () => {
    expect(objectsFilterSchema.safeParse({ sharedOrBlocked: true }).success).toBe(false);
    expect(objectsFilterSchema.parse({ sharedOrBlocked: "true" }).sharedOrBlocked).toBe(true);
  });
});

describe("the confirmation of objects no longer backed up", () => {
  it("filters by to_confirm and confirmed", () => {
    expect(objectsQuerySchema.parse({ status: "to_confirm" }).status).toBe("to_confirm");
    expect(objectsQuerySchema.parse({ status: "confirmed" }).status).toBe("confirmed");
  });

  it("takes an optional note for one object and exactly one selection for several", () => {
    expect(confirmInactiveSchema.parse({})).toEqual({});
    expect(confirmInactiveSchema.safeParse({ note: "x".repeat(1001) }).success).toBe(false);
    const id = "9b2f2c6e-3d1a-4a1b-8e3f-0c1d2e3f4a5b";
    expect(bulkConfirmInactiveSchema.safeParse({ objectIds: [id] }).success).toBe(true);
    expect(bulkConfirmInactiveSchema.safeParse({ filter: { kind: "onedrive" } }).success).toBe(
      true,
    );
    expect(bulkConfirmInactiveSchema.safeParse({}).success).toBe(false);
    expect(bulkConfirmInactiveSchema.safeParse({ objectIds: [id], filter: {} }).success).toBe(
      false,
    );
  });
});
