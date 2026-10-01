import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api";

import {
  RECENT_SIGN_IN_PROBLEM,
  isRecentSignInRequired,
  offersPasskeyConfirmation,
} from "./recent-sign-in";

describe("isRecentSignInRequired", () => {
  it("recognises the API's step-up refusal and nothing else", () => {
    const problem = (type: string, status = 403) =>
      new ApiError(status, { type, title: "x", status }, "x");
    expect(isRecentSignInRequired(problem(RECENT_SIGN_IN_PROBLEM))).toBe(true);
    expect(isRecentSignInRequired(problem(RECENT_SIGN_IN_PROBLEM, 401))).toBe(false);
    expect(isRecentSignInRequired(problem("urn:restow:problem:provider-role-required"))).toBe(
      false,
    );
    expect(isRecentSignInRequired(new Error(RECENT_SIGN_IN_PROBLEM))).toBe(false);
    expect(isRecentSignInRequired(null)).toBe(false);
  });
});

describe("offersPasskeyConfirmation", () => {
  it("offers the passkey only where a passkey sign-in can succeed", () => {
    const ready = { passkeyReady: true, browserSupportsPasskeys: true, passkeys: 1 };
    expect(offersPasskeyConfirmation(ready)).toBe(true);
    expect(offersPasskeyConfirmation({ ...ready, passkeyReady: false })).toBe(false);
    expect(offersPasskeyConfirmation({ ...ready, browserSupportsPasskeys: false })).toBe(false);
    expect(offersPasskeyConfirmation({ ...ready, passkeys: 0 })).toBe(false);
    expect(offersPasskeyConfirmation({ ...ready, passkeys: null })).toBe(false);
  });
});
