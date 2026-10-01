import { describe, expect, it } from "vitest";

import { createI18n } from "./index.js";

/**
 * ICU formatting must work under Node too (the API's notifications, every
 * vitest suite), not only in the bundled browser app.
 */
describe("ICU formatting", () => {
  it("formats plurals in both languages", () => {
    const en = createI18n({ lng: "en" });
    expect(en.t("dashboard:readiness.unverified.title", { count: 1 })).toBe(
      "1 backup not verified yet",
    );
    expect(en.t("dashboard:readiness.unverified.title", { count: 3 })).toBe(
      "3 backups not verified yet",
    );
    expect(en.t("dashboard:readiness.noBackup.title", { count: 2 })).toBe(
      "2 objects without a backup",
    );
    expect(en.t("dashboard:protectedObjects.withItemFailures", { count: 1 })).toBe(
      "1 with failed items",
    );

    const de = createI18n({ lng: "de" });
    expect(de.t("dashboard:readiness.unverified.title", { count: 3 })).not.toContain("{count");
  });

  it("interpolates plain arguments and leaves tag placeholders for <Trans>", () => {
    const en = createI18n({ lng: "en" });
    expect(en.t("dashboard:tenantScope", { tenant: "Acme" })).toBe("Showing Acme");
    expect(en.t("dashboard:storage.logical", { bytes: "1.4 TB" })).toBe("1.4 TB backed up");
  });

  it("re-reads messages after the cache is cleared on a resource change", () => {
    const en = createI18n({ lng: "en" });
    expect(en.t("dashboard:storage.logical", { bytes: "1" })).toBe("1 backed up");
    en.addResource("en", "dashboard", "storage.logical", "Build {bytes}");
    const format = en.services.i18nFormat as { clearCache(): void };
    format.clearCache();
    expect(en.t("dashboard:storage.logical", { bytes: "1" })).toBe("Build 1");
  });
});
