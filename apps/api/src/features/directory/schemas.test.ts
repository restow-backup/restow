import { describe, expect, it } from "vitest";
import {
  bulkFilterSchema,
  bulkProtectionSchema,
  objectsFilterSchema,
  objectsQuerySchema,
} from "./schemas.js";

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
      sourceId: "11111111-1111-1111-1111-111111111111",
      sharedOrBlocked: false,
    });
    expect(parsed).toEqual({
      search: "alice",
      kind: "mailbox",
      status: "not_selected",
      sourceId: "11111111-1111-1111-1111-111111111111",
      sharedOrBlocked: false,
    });
  });
});

describe("bulkProtectionSchema", () => {
  const objectIds = ["11111111-1111-1111-1111-111111111111"];

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
