import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PRODUCT_NAME,
  MAX_PRODUCT_NAME_LENGTH,
  applyProductNameToInstance,
  configureProductName,
  createI18n,
  normalizeProductName,
  productName,
} from "./index.js";

afterEach(() => {
  configureProductName(null);
});

describe("normalizeProductName", () => {
  it("falls back to the default for nothing usable", () => {
    expect(normalizeProductName(undefined)).toBe(DEFAULT_PRODUCT_NAME);
    expect(normalizeProductName(null)).toBe(DEFAULT_PRODUCT_NAME);
    expect(normalizeProductName("")).toBe(DEFAULT_PRODUCT_NAME);
    expect(normalizeProductName(" \n\t ")).toBe(DEFAULT_PRODUCT_NAME);
    expect(normalizeProductName("‮​")).toBe(DEFAULT_PRODUCT_NAME);
  });

  it("trims, collapses whitespace and drops control and invisible formatting characters", () => {
    expect(normalizeProductName("  Acme   Backup ")).toBe("Acme Backup");
    expect(normalizeProductName("Acme\nBackup")).toBe("Acme Backup");
    expect(normalizeProductName("Acme‮Backup")).toBe("AcmeBackup");
  });

  it("keeps the characters of any language and cuts an overlong name", () => {
    expect(normalizeProductName("Sicherung Müller & Söhne")).toBe("Sicherung Müller & Söhne");
    expect(normalizeProductName("日本語のバックアップ")).toBe("日本語のバックアップ");
    const long = normalizeProductName("x".repeat(MAX_PRODUCT_NAME_LENGTH + 40));
    expect(Array.from(long)).toHaveLength(MAX_PRODUCT_NAME_LENGTH);
  });
});

describe("the process-wide product name", () => {
  it("is the default until a server process configures one", () => {
    expect(productName()).toBe(DEFAULT_PRODUCT_NAME);
    expect(configureProductName("Acme Backup")).toBe("Acme Backup");
    expect(productName()).toBe("Acme Backup");
    expect(configureProductName(null)).toBe(DEFAULT_PRODUCT_NAME);
  });
});

/**
 * `{appName}` reaches every text through i18next's default variables, which the
 * ICU plugin receives with each call's own values. These tests guard that chain,
 * for plain texts and for arguments nested inside ICU select and plural messages.
 */
describe("{appName} in translations", () => {
  it("resolves without any call site passing it, in both languages", () => {
    const en = createI18n({ lng: "en" });
    expect(en.t("common:app.name")).toBe("Restow");
    expect(en.t("setup:result.success")).toBe("Setup complete. Welcome to Restow.");
    const de = createI18n({ lng: "de" });
    expect(de.t("setup:result.success")).toBe("Einrichtung abgeschlossen. Willkommen bei Restow.");
  });

  it("follows the name the process is configured with", () => {
    configureProductName("Acme Backup");
    const en = createI18n({ lng: "en" });
    expect(en.t("common:app.name")).toBe("Acme Backup");
    expect(en.t("setup:result.success")).toBe("Setup complete. Welcome to Acme Backup.");
    expect(en.t("common:errors.shellTitle")).toBe("Acme Backup could not be loaded");
    const de = createI18n({ lng: "de" });
    expect(de.t("common:errors.network")).toBe(
      "Der Server von Acme Backup ist nicht erreichbar. Prüfen Sie, ob API und Datenbank laufen.",
    );
  });

  it("lets a call, or the instance, say otherwise", () => {
    const en = createI18n({ lng: "en", appName: "Instance Name" });
    expect(en.t("common:app.name")).toBe("Instance Name");
    expect(en.t("common:app.name", { appName: "Call Name" })).toBe("Call Name");
  });

  it("reaches arguments nested in ICU select and plural messages", () => {
    configureProductName("Acme Backup");
    const en = createI18n({ lng: "en" });
    const credentials = en.t("failures:cause.graph.app_credentials_invalid.why", {
      reason: "secret_expired",
    });
    expect(credentials).toContain(
      "The client secret of the Acme Backup app registration has expired.",
    );
    expect(credentials).not.toContain("{");
    const throttled = en.t("failures:cause.graph.throttled.why", {
      has_retryAfterSeconds: "yes",
      retryAfterSeconds: 32,
    });
    expect(throttled).toContain("asked Acme Backup to wait 32 seconds");
  });

  it("does not turn a value with braces or markup into message syntax", () => {
    configureProductName("{count, plural, other {x}} <b>Backup</b>");
    const en = createI18n({ lng: "en" });
    expect(en.t("common:app.name")).toBe("{count, plural, other {x}} <b>Backup</b>");
  });

  it("can be changed on a live instance, as the web app does once the api has named the product", () => {
    const en = createI18n({ lng: "en" });
    expect(en.t("common:errors.shellTitle")).toBe("Restow could not be loaded");
    expect(applyProductNameToInstance(en, "Acme Backup")).toBe(true);
    expect(en.t("common:errors.shellTitle")).toBe("Acme Backup could not be loaded");
    expect(applyProductNameToInstance(en, "Acme Backup")).toBe(false);
    expect(applyProductNameToInstance(en, undefined)).toBe(true);
    expect(en.t("common:errors.shellTitle")).toBe("Restow could not be loaded");
  });
});
