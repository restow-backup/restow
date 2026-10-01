import { describe, expect, it } from "vitest";

import { loginRedirectFor, resolveEntryRedirect, safeRedirectTarget } from "./entry";

describe("resolveEntryRedirect", () => {
  it("sends every path to the wizard while unconfigured", () => {
    expect(resolveEntryRedirect(false, "/")).toBe("/setup");
    expect(resolveEntryRedirect(false, "/login")).toBe("/setup");
    expect(resolveEntryRedirect(false, "/backup/sources")).toBe("/setup");
  });

  it("lets the wizard itself render while unconfigured", () => {
    expect(resolveEntryRedirect(false, "/setup")).toBeNull();
    expect(resolveEntryRedirect(false, "/setup/")).toBeNull();
  });

  it("closes the wizard once configured and leaves other paths alone", () => {
    expect(resolveEntryRedirect(true, "/setup")).toBe("/");
    expect(resolveEntryRedirect(true, "/")).toBeNull();
    expect(resolveEntryRedirect(true, "/login")).toBeNull();
    expect(resolveEntryRedirect(true, "/restore")).toBeNull();
  });
});

describe("safeRedirectTarget", () => {
  it("accepts app-internal absolute paths", () => {
    expect(safeRedirectTarget("/restore?snapshot=1")).toBe("/restore?snapshot=1");
    expect(safeRedirectTarget("/backup/sources")).toBe("/backup/sources");
  });

  it("rejects external, protocol-relative and malformed targets", () => {
    expect(safeRedirectTarget("https://evil.example")).toBeNull();
    expect(safeRedirectTarget("//evil.example/x")).toBeNull();
    expect(safeRedirectTarget("/\\evil.example")).toBeNull();
    expect(safeRedirectTarget("restore")).toBeNull();
    expect(safeRedirectTarget("")).toBeNull();
    expect(safeRedirectTarget(undefined)).toBeNull();
  });

  it("never bounces back into the auth pages", () => {
    expect(safeRedirectTarget("/login")).toBeNull();
    expect(safeRedirectTarget("/setup")).toBeNull();
    expect(safeRedirectTarget("/login?redirect=/x")).toBeNull();
    expect(safeRedirectTarget("/authenticator-setup")).toBeNull();
    expect(safeRedirectTarget("/authenticator-setup?redirect=/x")).toBeNull();
  });
});

describe("loginRedirectFor", () => {
  it("remembers a deep link", () => {
    expect(loginRedirectFor("/restore/abc?x=1")).toEqual({
      to: "/login",
      redirect: "/restore/abc?x=1",
    });
  });

  it("drops the home page and unsafe targets", () => {
    expect(loginRedirectFor("/")).toEqual({ to: "/login" });
    expect(loginRedirectFor("https://evil.example")).toEqual({ to: "/login" });
  });
});
