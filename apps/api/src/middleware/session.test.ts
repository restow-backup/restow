import { describe, expect, it } from "vitest";
import { isImpersonationSession } from "./session.js";

describe("isImpersonationSession", () => {
  it("recognizes a session better-auth opened to act as another account", () => {
    expect(isImpersonationSession({ session: { impersonatedBy: "provider-admin-id" } })).toBe(true);
  });

  it("accepts an ordinary sign-in", () => {
    expect(isImpersonationSession({ session: { impersonatedBy: null } })).toBe(false);
    expect(isImpersonationSession({ session: {} })).toBe(false);
  });
});
