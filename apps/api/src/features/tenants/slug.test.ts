import { describe, expect, it } from "vitest";
import { tenantSlugSchema } from "./schemas.js";
import { FALLBACK_SLUG, availableSlug, slugify } from "./slug.js";

describe("slugify", () => {
  it("writes German letters the conventional way and joins words with single hyphens", () => {
    expect(slugify("Müller & Söhne GmbH")).toBe("mueller-soehne-gmbh");
    expect(slugify("  Straße 7 – Büro  ")).toBe("strasse-7-buero");
    expect(slugify("Crème Brûlée AG")).toBe("creme-brulee-ag");
  });

  it("is empty for a name without a letter or digit, and never ends in a hyphen when cut", () => {
    expect(slugify("§$%&")).toBe("");
    expect(slugify("日本語")).toBe("");
    const cut = slugify(`${"a".repeat(62)} b`);
    expect(cut.length).toBeLessThanOrEqual(63);
    expect(cut.endsWith("-")).toBe(false);
  });

  it("always yields a slug the tenant schema accepts, when it yields one", () => {
    for (const name of ["Acme", "A & B", "Müller IT GmbH", "x".repeat(300), "2026 Backup"]) {
      const slug = slugify(name);
      expect(tenantSlugSchema.safeParse(slug).success, name).toBe(slug.length >= 2);
    }
  });
});

describe("availableSlug", () => {
  const takenBy = (taken: string[]) => async (slug: string) => taken.includes(slug);

  it("uses the slug of the name when it is free", async () => {
    expect(await availableSlug("Müller IT GmbH", takenBy([]))).toBe("mueller-it-gmbh");
  });

  it("numbers the slug until one is free", async () => {
    expect(await availableSlug("Acme", takenBy(["acme"]))).toBe("acme-2");
    expect(await availableSlug("Acme", takenBy(["acme", "acme-2", "acme-3"]))).toBe("acme-4");
  });

  it("falls back for a name that has no usable letter, and numbers the fallback too", async () => {
    expect(await availableSlug("日本語", takenBy([]))).toBe(FALLBACK_SLUG);
    expect(await availableSlug("日本語", takenBy([FALLBACK_SLUG]))).toBe(`${FALLBACK_SLUG}-2`);
    expect(await availableSlug("a", takenBy([]))).toBe(FALLBACK_SLUG);
  });

  it("keeps a numbered slug within the length limit", async () => {
    const long = "a".repeat(63);
    const slug = await availableSlug(long, takenBy([long]));
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-2")).toBe(true);
    expect(tenantSlugSchema.safeParse(slug).success).toBe(true);
  });
});
