import { configureProductName } from "@restow/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { totpIssuer } from "./sign-in-options.js";

afterEach(() => {
  configureProductName(null);
});

describe("totpIssuer", () => {
  it("names the installation by its public host", () => {
    expect(totpIssuer("https://restow.example.com")).toBe("Restow (restow.example.com)");
    expect(totpIssuer("https://backup.example.com:8443")).toBe("Restow (backup.example.com:8443)");
  });

  it("falls back to the product name", () => {
    expect(totpIssuer(undefined)).toBe("Restow");
    expect(totpIssuer("not a url")).toBe("Restow");
  });

  it("carries the product name the installation is branded with", () => {
    configureProductName("Acme Backup");
    expect(totpIssuer("https://backup.example.com")).toBe("Acme Backup (backup.example.com)");
    expect(totpIssuer(undefined)).toBe("Acme Backup");
  });
});
