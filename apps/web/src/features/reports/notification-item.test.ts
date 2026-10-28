import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { bellEventKey } from "./notification-item";

/**
 * The bell line of an expiring app credential names its stage (core entra/expiry.ts: 30 days,
 * 7 days, expired) and the date, for the central app and for a source's own app.
 */

const EVENTS = ["installation.app_secret_expiring", "source.app_secret_expiring"] as const;

describe("bellEventKey for an expiring app credential", () => {
  it("adds the stage to the key, and falls back to the plain key without one", () => {
    for (const event of EVENTS) {
      for (const stage of ["soon30", "soon7", "expired"]) {
        expect(bellEventKey({ event, details: { stage } })).toBe(`bellEvents.${event}_${stage}`);
      }
      expect(bellEventKey({ event, details: { stage: "ok" } })).toBe(`bellEvents.${event}`);
      expect(bellEventKey({ event, details: null })).toBe(`bellEvents.${event}`);
    }
  });
});

describe("the words of every stage", () => {
  const previous = i18n.language;
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });
  afterAll(async () => {
    await i18n.changeLanguage(previous);
  });

  it("exists in both languages and names the object, the days and the date", async () => {
    for (const language of ["en", "de"]) {
      await i18n.changeLanguage(language);
      for (const event of EVENTS) {
        for (const suffix of ["", "_soon30", "_soon7", "_expired"]) {
          const key = `reports:bellEvents.${event}${suffix}`;
          expect(i18n.exists(key), `${language} ${key}`).toBe(true);
          const line = i18n.t(key, { object: "Contoso", days: 5, date: "01.11.2026" });
          expect(line, key).toContain("01.11.2026");
          if (event.startsWith("source.")) {
            expect(line, key).toContain("Contoso");
          }
        }
      }
    }
    await i18n.changeLanguage("en");
    expect(
      i18n.t("reports:bellEvents.source.app_secret_expiring_soon7", {
        object: "Contoso",
        days: 1,
        date: "Nov 1, 2026",
      }),
    ).toContain("in 1 day");
  });
});
