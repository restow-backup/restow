import { describe, expect, it } from "vitest";
import { AUTH_RATE_LIMIT } from "./auth-surface.js";
import {
  RESET_MAIL_INTERVAL_MS,
  ResetMailThrottle,
  changedPasswordUser,
  mayResetByMail,
  passwordResetAvailable,
  passwordResetUrl,
} from "./password-reset.js";

describe("the reset by mail", () => {
  it("is offered only once set up, with mail and a public URL, outside the demo", () => {
    const base = {
      configured: true,
      demo: false,
      mailConfigured: true,
      publicUrl: "https://backup.example.com",
    };
    expect(passwordResetAvailable(base)).toBe(true);
    expect(passwordResetAvailable({ ...base, configured: false })).toBe(false);
    expect(passwordResetAvailable({ ...base, demo: true })).toBe(false);
    expect(passwordResetAvailable({ ...base, mailConfigured: false })).toBe(false);
    expect(passwordResetAvailable({ ...base, publicUrl: null })).toBe(false);
  });

  it("never replaces the second factor: only accounts with password and authenticator app", () => {
    expect(mayResetByMail({ hasPassword: true, twoFactorEnabled: true, banned: false })).toBe(true);
    expect(mayResetByMail({ hasPassword: true, twoFactorEnabled: false, banned: false })).toBe(
      false,
    );
    expect(mayResetByMail({ hasPassword: true, twoFactorEnabled: null, banned: null })).toBe(false);
    expect(mayResetByMail({ hasPassword: false, twoFactorEnabled: true, banned: false })).toBe(
      false,
    );
    expect(mayResetByMail({ hasPassword: true, twoFactorEnabled: true, banned: true })).toBe(false);
  });

  it("links to the web page on the public URL, token encoded", () => {
    expect(passwordResetUrl("https://backup.example.com/", "a b+c")).toBe(
      "https://backup.example.com/reset-password?token=a%20b%2Bc",
    );
  });

  it("mails each account at most once per interval", () => {
    const throttle = new ResetMailThrottle();
    expect(throttle.allow("u1", 0)).toBe(true);
    expect(throttle.allow("u1", RESET_MAIL_INTERVAL_MS - 1)).toBe(false);
    expect(throttle.allow("u2", 1)).toBe(true);
    expect(throttle.allow("u1", RESET_MAIL_INTERVAL_MS + 1)).toBe(true);
  });

  it("is rate-limited per IP, as are the reset and the change of the own password", () => {
    const rules = AUTH_RATE_LIMIT.customRules;
    expect(rules["/request-password-reset"].max).toBeLessThanOrEqual(5);
    expect(rules["/request-password-reset"].window).toBeGreaterThanOrEqual(600);
    expect(rules["/reset-password"]).toBeDefined();
    expect(rules["/change-password"].max).toBeLessThanOrEqual(5);
  });
});

describe("changedPasswordUser", () => {
  it("reads the account from what /change-password returned, nothing from a failure", () => {
    expect(changedPasswordUser({ token: "t", user: { id: "u1", email: "a@b.co" } })).toEqual({
      id: "u1",
      email: "a@b.co",
    });
    expect(changedPasswordUser(null)).toBeNull();
    expect(changedPasswordUser({ status: 400 })).toBeNull();
    expect(changedPasswordUser({ user: { id: 1 } })).toBeNull();
  });
});
