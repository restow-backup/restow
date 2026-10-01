import { describe, expect, it } from "vitest";
import { microsoftSignInConfigured } from "./config.js";

const configured = {
  ssoClientId: "sso-app-id",
  ssoClientSecret: "sso-app-credential",
  ssoExperimental: true,
};
const publicInstall = { operatingMode: "public" as const, publicUrl: "https://restow.example.com" };

describe("microsoftSignInConfigured", () => {
  it("offers Microsoft sign-in with the SSO app configured in public mode", () => {
    expect(microsoftSignInConfigured(configured, publicInstall)).toBe(true);
  });

  it("hides it unless the experimental switch is on, however the app is configured", () => {
    expect(
      microsoftSignInConfigured({ ...configured, ssoExperimental: false }, publicInstall),
    ).toBe(false);
  });

  it("needs both halves of the SSO app registration", () => {
    expect(
      microsoftSignInConfigured({ ...configured, ssoClientSecret: undefined }, publicInstall),
    ).toBe(false);
    expect(microsoftSignInConfigured({ ...configured, ssoClientId: "" }, publicInstall)).toBe(
      false,
    );
  });

  it("is off in local mode, without a public URL and before setup", () => {
    expect(microsoftSignInConfigured(configured, { operatingMode: "local", publicUrl: null })).toBe(
      false,
    );
    expect(
      microsoftSignInConfigured(configured, { operatingMode: "public", publicUrl: null }),
    ).toBe(false);
    expect(microsoftSignInConfigured(configured, null)).toBe(false);
  });
});
