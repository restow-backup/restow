import { describe, expect, it } from "vitest";
import {
  assertSafeTenantSlug,
  effectiveSegmentSize,
  findOverlappingFolderEntries,
  mapWithConcurrency,
  storedFolderPath,
  tenantRelativeFolderPath,
} from "./logic.js";

describe("effectiveSegmentSize", () => {
  const SERVER = 8 * 1024 * 1024;

  it("uses the server's size when the client proposes nothing", () => {
    expect(effectiveSegmentSize(undefined, SERVER)).toBe(SERVER);
  });

  it("honours a smaller proposal but never exceeds the server's setting", () => {
    expect(effectiveSegmentSize(1024 * 1024, SERVER)).toBe(1024 * 1024);
    expect(effectiveSegmentSize(64 * 1024 * 1024, SERVER)).toBe(SERVER);
  });

  it("stays inside the range the segment store supports", () => {
    expect(effectiveSegmentSize(10, SERVER)).toBe(64 * 1024);
  });
});

describe("findOverlappingFolderEntries", () => {
  it("finds a path inside a selected directory", () => {
    expect(findOverlappingFolderEntries(["MailStore", "MailStore/2019/a.eml"])).toEqual([
      "MailStore",
      "MailStore/2019/a.eml",
    ]);
  });

  it("treats the import folder itself as containing everything", () => {
    expect(findOverlappingFolderEntries(["", "x.mbox"])).toEqual(["", "x.mbox"]);
  });

  it("does not confuse a shared name prefix with containment", () => {
    expect(findOverlappingFolderEntries(["Mail", "Mail2/a.eml", "Mailbox.mbox"])).toBeNull();
  });

  it("finds nothing in unrelated paths", () => {
    expect(findOverlappingFolderEntries(["a.eml", "b/c.mbox", "b/d.mbox"])).toBeNull();
    expect(findOverlappingFolderEntries([])).toBeNull();
  });
});

describe("mapWithConcurrency", () => {
  it("keeps the input order and never exceeds the limit", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5 - (n % 3)));
      running--;
      return n * 10;
    });
    expect(results).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("handles no items", async () => {
    expect(await mapWithConcurrency([], 4, async (n: number) => n)).toEqual([]);
  });
});

describe("tenant folder paths", () => {
  it("stores tenant-relative paths below the tenant's slug and strips them again", () => {
    expect(storedFolderPath("acme", "mail/a.eml")).toBe("acme/mail/a.eml");
    expect(storedFolderPath("acme", "/mail//./a.eml")).toBe("acme/mail/a.eml");
    expect(storedFolderPath("acme", "")).toBe("acme/");
    expect(tenantRelativeFolderPath("acme", "acme/mail/a.eml")).toBe("mail/a.eml");
    expect(tenantRelativeFolderPath("acme", "acme/")).toBe("");
    expect(tenantRelativeFolderPath("acme", "acme")).toBe("");
    // Another tenant's prefix, or a longer slug sharing the start, is left as it is.
    expect(tenantRelativeFolderPath("acme", "acme2/x.eml")).toBe("acme2/x.eml");
    expect(tenantRelativeFolderPath("acme", "other/x.eml")).toBe("other/x.eml");
    for (const relative of ["", "a", "a/b/c.eml"]) {
      expect(tenantRelativeFolderPath("acme", storedFolderPath("acme", relative))).toBe(relative);
    }
  });

  it("only accepts slugs that cannot act as paths", () => {
    expect(() => assertSafeTenantSlug("acme")).not.toThrow();
    expect(() => assertSafeTenantSlug("acme-gmbh-2")).not.toThrow();
    for (const slug of ["", ".", "..", "a/b", "../x", "a\\b", "A", "a b", "-a", "a--b", "a\0"]) {
      expect(() => assertSafeTenantSlug(slug), slug).toThrow();
    }
  });
});
