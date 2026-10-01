import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bearerToken,
  generateApiKey,
  hashApiKey,
  isApiKeyAuthorization,
  isWellFormedApiKey,
  randomBase62,
  tenantKeyTag,
} from "./tokens.js";

/** A deterministic byte source cycling through the given values. */
function bytes(...values: number[]) {
  let index = 0;
  return (size: number) => {
    const out = Buffer.alloc(size);
    for (let i = 0; i < size; i++) {
      out[i] = values[index % values.length] ?? 0;
      index += 1;
    }
    return out;
  };
}

describe("randomBase62", () => {
  it("draws only base62 characters of the requested length", () => {
    const value = randomBase62(500);
    expect(value).toHaveLength(500);
    expect(value).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("rejects bytes that would bias the draw", () => {
    // 248..255 are skipped; 0 -> "0", 61 -> "z", 62 -> "0" again.
    expect(randomBase62(3, bytes(255, 250, 0, 248, 61, 62))).toBe("0z0");
  });

  it("uses every character over many draws", () => {
    expect(new Set(randomBase62(5000)).size).toBe(62);
  });
});

describe("tenantKeyTag", () => {
  it("compacts the slug to lowercase letters and digits", () => {
    expect(tenantKeyTag("contoso")).toBe("contoso");
    expect(tenantKeyTag("acme-gmbh-2")).toBe("acmegmbh2");
  });

  it("caps the tag at 16 characters", () => {
    expect(tenantKeyTag("a-very-long-customer-name-gmbh")).toBe("averylongcustome");
  });

  it("never produces the provider tag for a tenant", () => {
    expect(tenantKeyTag("provider")).toBe("tprovider");
    expect(tenantKeyTag("pro-vider")).toBe("tprovider");
  });

  it("falls back when nothing usable is left", () => {
    expect(tenantKeyTag("---")).toBe("tenant");
  });
});

describe("generateApiKey", () => {
  it("builds rsk_<tag>_<40 base62>, a display prefix and the SHA-256", () => {
    const key = generateApiKey("contoso");
    expect(key.token).toMatch(/^rsk_contoso_[0-9A-Za-z]{40}$/);
    expect(key.prefix).toBe(key.token.slice(0, "rsk_contoso_".length + 8));
    expect(key.hash).toBe(createHash("sha256").update(key.token).digest("hex"));
    expect(isWellFormedApiKey(key.token)).toBe(true);
  });

  it("builds provider keys", () => {
    expect(generateApiKey("provider").token).toMatch(/^rsk_provider_[0-9A-Za-z]{40}$/);
  });

  it("never repeats", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateApiKey("t").token));
    expect(tokens.size).toBe(200);
  });

  it("refuses tags that would break the format", () => {
    expect(() => generateApiKey("Contoso")).toThrow(TypeError);
    expect(() => generateApiKey("a_b")).toThrow(TypeError);
    expect(() => generateApiKey("")).toThrow(TypeError);
  });
});

describe("hashApiKey", () => {
  it("is the hex SHA-256 of the token", () => {
    expect(hashApiKey("rsk_x_abc")).toBe(
      createHash("sha256").update("rsk_x_abc", "utf8").digest("hex"),
    );
    expect(hashApiKey("rsk_x_abc")).toHaveLength(64);
  });
});

describe("isWellFormedApiKey", () => {
  const secret = "A".repeat(40);
  it("accepts the documented shape only", () => {
    expect(isWellFormedApiKey(`rsk_contoso_${secret}`)).toBe(true);
    expect(isWellFormedApiKey(`rsk_contoso_${secret}x`)).toBe(false);
    expect(isWellFormedApiKey(`rsk_Contoso_${secret}`)).toBe(false);
    expect(isWellFormedApiKey(`rsk__${secret}`)).toBe(false);
    expect(isWellFormedApiKey(`rsk_contoso_${"A".repeat(39)}-`)).toBe(false);
    expect(isWellFormedApiKey(`xsk_contoso_${secret}`)).toBe(false);
  });
});

describe("bearerToken / isApiKeyAuthorization", () => {
  it("reads the token of a Bearer header, case-insensitively", () => {
    expect(bearerToken("Bearer rsk_a_b")).toBe("rsk_a_b");
    expect(bearerToken("bearer   rsk_a_b  ")).toBe("rsk_a_b");
    expect(bearerToken("Basic b3NrXw==")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken("Bearer a b")).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });

  it("recognises Restow keys among bearer tokens", () => {
    expect(isApiKeyAuthorization("Bearer rsk_tenant_abc")).toBe(true);
    expect(isApiKeyAuthorization("Bearer eyJhbGciOi")).toBe(false);
    expect(isApiKeyAuthorization(undefined)).toBe(false);
  });
});
