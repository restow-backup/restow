import { describe, expect, it } from "vitest";
import {
  AGENT_SECRET_PREFIX,
  ENROLLMENT_TOKEN_PREFIX,
  ENROLLMENT_TOKEN_TTL_MS,
  enrollmentTokenExpiry,
  enrollmentTokenState,
  generateAgentSecret,
  generateEnrollmentToken,
  hashSecret,
  isAgentSecret,
  isEnrollmentToken,
  parseBasicAuthorization,
  secretMatchesHash,
} from "./tokens.js";

describe("enrollment tokens and agent secrets", () => {
  it("makes 32 random bytes as base64url behind the documented prefixes", () => {
    const token = generateEnrollmentToken();
    const secret = generateAgentSecret();
    expect(token.value.startsWith(ENROLLMENT_TOKEN_PREFIX)).toBe(true);
    expect(secret.value.startsWith(AGENT_SECRET_PREFIX)).toBe(true);
    expect(token.value).toHaveLength(ENROLLMENT_TOKEN_PREFIX.length + 43);
    expect(isEnrollmentToken(token.value)).toBe(true);
    expect(isAgentSecret(secret.value)).toBe(true);
    expect(isEnrollmentToken(secret.value)).toBe(false);
    expect(isAgentSecret(token.value)).toBe(false);
    expect(token.value).not.toBe(generateEnrollmentToken().value);
  });

  it("stores only the SHA-256 and never the value", () => {
    const token = generateEnrollmentToken();
    expect(token.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.hash).toBe(hashSecret(token.value));
    expect(token.hash).not.toContain(token.value.slice(ENROLLMENT_TOKEN_PREFIX.length));
  });

  it("draws from the random source it is given", () => {
    const fixed = generateEnrollmentToken(() => Buffer.alloc(32, 1));
    expect(fixed.value).toBe(
      `${ENROLLMENT_TOKEN_PREFIX}${Buffer.alloc(32, 1).toString("base64url")}`,
    );
  });

  it("matches a presented secret against its hash and refuses others", () => {
    const secret = generateAgentSecret();
    expect(secretMatchesHash(secret.value, secret.hash)).toBe(true);
    expect(secretMatchesHash(`${secret.value}x`, secret.hash)).toBe(false);
    expect(secretMatchesHash(secret.value, "0".repeat(64))).toBe(false);
    expect(secretMatchesHash(secret.value, "not-a-hash")).toBe(false);
  });

  describe("expiry and single use", () => {
    const now = new Date("2026-09-30T12:00:00Z");
    const token = { expiresAt: enrollmentTokenExpiry(now), usedAt: null, revokedAt: null };

    it("is valid for 24 hours", () => {
      expect(ENROLLMENT_TOKEN_TTL_MS).toBe(24 * 60 * 60 * 1000);
      expect(token.expiresAt.toISOString()).toBe("2026-10-01T12:00:00.000Z");
      expect(enrollmentTokenState(token, now)).toBe("valid");
      expect(enrollmentTokenState(token, new Date("2026-10-01T11:59:59Z"))).toBe("valid");
    });

    it("expires exactly at the deadline", () => {
      expect(enrollmentTokenState(token, new Date("2026-10-01T12:00:00Z"))).toBe("expired");
      expect(enrollmentTokenState(token, new Date("2026-10-05T00:00:00Z"))).toBe("expired");
    });

    it("is spent once used, and revocation wins", () => {
      expect(enrollmentTokenState({ ...token, usedAt: now }, now)).toBe("used");
      expect(enrollmentTokenState({ ...token, revokedAt: now }, now)).toBe("revoked");
      expect(enrollmentTokenState({ ...token, usedAt: now, revokedAt: now }, now)).toBe("revoked");
      // A used token stays "used" after its deadline.
      expect(
        enrollmentTokenState({ ...token, usedAt: now }, new Date("2026-12-01T00:00:00Z")),
      ).toBe("used");
    });
  });

  describe("HTTP Basic credentials", () => {
    const header = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

    it("reads endpoint id and secret", () => {
      expect(parseBasicAuthorization(header("abc:rsea_secret"))).toEqual({
        username: "abc",
        password: "rsea_secret",
      });
    });

    it("keeps colons inside the password", () => {
      expect(parseBasicAuthorization(header("abc:p:w"))).toEqual({
        username: "abc",
        password: "p:w",
      });
    });

    it("refuses anything else", () => {
      expect(parseBasicAuthorization(undefined)).toBeNull();
      expect(parseBasicAuthorization("Bearer x")).toBeNull();
      expect(parseBasicAuthorization("Basic")).toBeNull();
      expect(parseBasicAuthorization(header("nocolon"))).toBeNull();
      expect(parseBasicAuthorization(header(":nouser"))).toBeNull();
    });
  });
});
