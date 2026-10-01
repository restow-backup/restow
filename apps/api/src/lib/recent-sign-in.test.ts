import { describe, expect, it } from "vitest";
import { ProblemError } from "../problem.js";
import {
  RECENT_SIGN_IN_MAX_AGE_SECONDS,
  RECENT_SIGN_IN_PROBLEM,
  assertRecentSignIn,
  isRecentSignIn,
} from "./recent-sign-in.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

describe("isRecentSignIn", () => {
  it("accepts a strong sign-in within ten minutes, as a Date or a string", () => {
    expect(RECENT_SIGN_IN_MAX_AGE_SECONDS).toBe(600);
    for (const authMethod of ["passkey", "password_totp", "oidc"]) {
      expect(isRecentSignIn({ authMethod, createdAt: ago(0) }, NOW)).toBe(true);
      expect(isRecentSignIn({ authMethod, createdAt: ago(600) }, NOW)).toBe(true);
      expect(isRecentSignIn({ authMethod, createdAt: ago(300).toISOString() }, NOW)).toBe(true);
    }
  });

  it("refuses an older session, an unknown or weak method and an unknown age", () => {
    expect(isRecentSignIn({ authMethod: "passkey", createdAt: ago(601) }, NOW)).toBe(false);
    for (const authMethod of ["password", "impersonation", null, undefined, 5]) {
      expect(isRecentSignIn({ authMethod, createdAt: ago(10) }, NOW)).toBe(false);
    }
    expect(isRecentSignIn({ authMethod: "passkey", createdAt: null }, NOW)).toBe(false);
    expect(isRecentSignIn({ authMethod: "passkey", createdAt: "yesterday" }, NOW)).toBe(false);
    // A clock a few seconds ahead is tolerated; a session "from tomorrow" is not.
    expect(isRecentSignIn({ authMethod: "passkey", createdAt: ago(-30) }, NOW)).toBe(true);
    expect(isRecentSignIn({ authMethod: "passkey", createdAt: ago(-86_400) }, NOW)).toBe(false);
  });
});

describe("assertRecentSignIn", () => {
  it("answers 403 with the problem type the web app reacts to", () => {
    let caught: unknown = null;
    try {
      assertRecentSignIn({ authMethod: "passkey", createdAt: ago(3600) }, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProblemError);
    expect(caught).toMatchObject({
      status: 403,
      type: RECENT_SIGN_IN_PROBLEM,
      extensions: { maxAgeSeconds: 600 },
    });
    expect(() =>
      assertRecentSignIn({ authMethod: "passkey", createdAt: ago(60) }, NOW),
    ).not.toThrow();
  });
});
