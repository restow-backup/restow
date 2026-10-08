import { afterEach, describe, expect, it, vi } from "vitest";

import { clearPasswordHandoff, peekPasswordForEnrolment } from "@/lib/password-handoff";

import { signInWithNewPassword } from "./set-password-page";

/**
 * After choosing the password on the set-password page the person is signed
 * in with it straight away, and the authenticator enrolment that follows
 * starts with it (lib/password-handoff.ts): one password prompt instead of
 * three. Anything unusual falls back to the "Password set" card.
 */

const signInEmail = vi.fn();
vi.mock("@/lib/auth-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth-client")>();
  return {
    ...actual,
    authClient: {
      ...actual.authClient,
      signIn: { ...actual.authClient.signIn, email: (input: unknown) => signInEmail(input) },
    },
  };
});

afterEach(() => {
  signInEmail.mockReset();
  clearPasswordHandoff();
});

describe("signInWithNewPassword", () => {
  it("signs in and holds the password for the enrolment", async () => {
    signInEmail.mockResolvedValue({ data: { token: "t" }, error: null });
    expect(await signInWithNewPassword("ada@example.com", "a-new-password-1")).toBe(true);
    expect(signInEmail).toHaveBeenCalledWith({
      email: "ada@example.com",
      password: "a-new-password-1",
    });
    expect(peekPasswordForEnrolment()).toBe("a-new-password-1");
  });

  it("falls back when the account asks for its second factor or the sign-in is refused", async () => {
    signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    expect(await signInWithNewPassword("ada@example.com", "a-new-password-1")).toBe(false);
    signInEmail.mockResolvedValue({ data: null, error: { status: 403 } });
    expect(await signInWithNewPassword("ada@example.com", "a-new-password-1")).toBe(false);
    signInEmail.mockRejectedValue(new Error("offline"));
    expect(await signInWithNewPassword("ada@example.com", "a-new-password-1")).toBe(false);
    expect(await signInWithNewPassword("", "a-new-password-1")).toBe(false);
    expect(peekPasswordForEnrolment()).toBeNull();
  });
});
