import { describe, expect, it } from "vitest";
import { locksOut, summarisePasskeyImpact } from "./passkey-impact.js";

const facts = (hasPasskey: boolean, hasPassword: boolean, hasAuthenticator: boolean) => ({
  hasPasskey,
  hasPassword,
  hasAuthenticator,
});

describe("passkey impact", () => {
  it("locks out an account whose only way in is a passkey", () => {
    expect(locksOut(facts(true, false, false))).toBe(true);
    // A password without an authenticator app is refused for a passkey account.
    expect(locksOut(facts(true, true, false))).toBe(true);
    // An authenticator app without a password protects nothing to sign in with.
    expect(locksOut(facts(true, false, true))).toBe(true);
    expect(locksOut(facts(true, true, true))).toBe(false);
    expect(locksOut(facts(false, true, false))).toBe(false);
  });

  it("counts accounts with passkeys and the ones that could not sign in", () => {
    const impact = summarisePasskeyImpact(
      [
        { userId: "a", ...facts(true, true, true) },
        { userId: "b", ...facts(true, false, false) },
        { userId: "c", ...facts(false, true, true) },
      ],
      facts(true, true, false),
    );
    expect(impact).toEqual({
      accountsWithPasskeys: 2,
      accountsLockedOut: 1,
      self: { ...facts(true, true, false), lockedOut: true },
    });
  });
});
