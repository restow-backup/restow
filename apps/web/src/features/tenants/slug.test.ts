import { describe, expect, it } from "vitest";

import { SLUG_MAX_LENGTH, slugProblem, slugify } from "./slug";

describe("slugify", () => {
  it("lowercases and joins words with single hyphens", () => {
    expect(slugify("Example Ltd")).toBe("example-ltd");
    expect(slugify("  ACME   Corp  ")).toBe("acme-corp");
  });

  it("spells German letters the conventional way", () => {
    expect(slugify("Müller & Söhne GmbH")).toBe("mueller-soehne-gmbh");
    expect(slugify("Straßenbau Ärzte Öl")).toBe("strassenbau-aerzte-oel");
  });

  it("drops accents from other letters", () => {
    expect(slugify("Café Crème")).toBe("cafe-creme");
    expect(slugify("Crème brûlée à la carte")).toBe("creme-brulee-a-la-carte");
  });

  it("collapses punctuation and trims hyphens at both ends", () => {
    expect(slugify("--IT Systeme Flores UG (haftungsbeschränkt)--")).toBe(
      "it-systeme-flores-ug-haftungsbeschraenkt",
    );
    expect(slugify("a.b_c/d")).toBe("a-b-c-d");
  });

  it("returns an empty slug for names without usable letters", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });

  it("stays within the length limit without a trailing hyphen", () => {
    const name = `${"a".repeat(SLUG_MAX_LENGTH - 1)} b`;
    const slug = slugify(name);
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug.endsWith("-")).toBe(false);
    expect(slugProblem(slug)).toBeNull();
  });

  it("always produces a valid slug when it produces a long enough one", () => {
    for (const name of ["Kanzlei Dr. Weiß", "Zahnarztpraxis am Markt 12", "Ω Omega"]) {
      const slug = slugify(name);
      if (slug.length >= 2) {
        expect(slugProblem(slug), name).toBeNull();
      }
    }
  });
});

describe("slugProblem", () => {
  it("accepts lowercase words joined by single hyphens", () => {
    expect(slugProblem("example-ltd")).toBeNull();
    expect(slugProblem("a1")).toBeNull();
  });

  it("names the rule a slug breaks", () => {
    expect(slugProblem("a")).toBe("slugTooShort");
    expect(slugProblem("")).toBe("slugTooShort");
    expect(slugProblem("a".repeat(SLUG_MAX_LENGTH + 1))).toBe("slugTooLong");
    expect(slugProblem("Example")).toBe("slugFormat");
    expect(slugProblem("double--hyphen")).toBe("slugFormat");
    expect(slugProblem("-leading")).toBe("slugFormat");
    expect(slugProblem("trailing-")).toBe("slugFormat");
    expect(slugProblem("with space")).toBe("slugFormat");
  });
});
