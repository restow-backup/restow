import { describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { UPDATE_MESSAGE_CODES } from "./api";
import "./i18n";
import { isKnownMessageCode, messageParams } from "./messages";

const translate = (key: string) => i18n.getFixedT("en", "updates")(key);

describe("the updater's messages", () => {
  it("know exactly the vocabulary of the protocol", () => {
    for (const code of UPDATE_MESSAGE_CODES) {
      expect(isKnownMessageCode(code), code).toBe(true);
    }
    expect(isKnownMessageCode("step.fetch.invented")).toBe(false);
    expect(isKnownMessageCode("maintenance.messages.step.fetch.pulling")).toBe(false);
    expect(isKnownMessageCode("")).toBe(false);
  });

  it("have a text in both languages for every code, with the parameters the updater sends", () => {
    const params: Record<string, string | number> = {
      version: "0.2.0",
      startsAt: "2026-09-30T12:00:00.000Z",
      image: "ghcr.io/example/app:0.2.0",
      file: "backup.dump",
      services: "api, worker",
      code: "health.timeout",
    };
    for (const language of ["en", "de"] as const) {
      const t = i18n.getFixedT(language, "updates");
      for (const code of UPDATE_MESSAGE_CODES) {
        const text = t(
          `maintenance.messages.${code}`,
          messageParams({ code, params }, { translate, language }),
        );
        expect(text, `${language} ${code}`).not.toContain("maintenance.messages");
        expect(text, `${language} ${code}`).not.toMatch(/\{\w+\}/);
        expect(text.trim().length, `${language} ${code}`).toBeGreaterThan(5);
      }
    }
  });

  it("turn the failure code of a finished run into its reason", () => {
    for (const code of ["run.unchanged", "run.rolled_back", "run.needs_attention"]) {
      const result = messageParams(
        { code, params: { code: "fetch.pull_failed" } },
        { translate, language: "en" },
      );
      expect(result.reason).toBe("The new image could not be downloaded.");
    }
    // A code from a newer updater reads as the general fallback, never as a raw code.
    const unknown = messageParams(
      { code: "run.rolled_back", params: { code: "brand.new" } },
      { translate, language: "en" },
    );
    expect(unknown.reason).toBe("The update failed for a reason this version does not know.");
    const missing = messageParams(
      { code: "run.needs_attention", params: {} },
      { translate, language: "en" },
    );
    expect(missing.reason).toBe("The update failed for a reason this version does not know.");
  });

  it("show a start time as a local date and time", () => {
    const result = messageParams(
      { code: "run.scheduled", params: { version: "0.2.0", startsAt: "2026-09-30T12:00:00.000Z" } },
      { translate, language: "en" },
    );
    expect(result.startsAt).toMatch(/Sep 30, 2026/);
    expect(
      messageParams(
        { code: "run.scheduled", params: { startsAt: "garbage" } },
        { translate, language: "en" },
      ).startsAt,
    ).toBe("garbage");
  });

  it("say 'unknown' when the previous version was not known", () => {
    expect(
      messageParams(
        { code: "rollback.restarting", params: { version: "unknown" } },
        { translate, language: "en" },
      ).version,
    ).toBe("unknown");
    const german = i18n.getFixedT("de", "updates");
    expect(
      messageParams(
        { code: "rollback.restarting", params: { version: "unknown" } },
        { translate: (key) => german(key), language: "de" },
      ).version,
    ).toBe("unbekannt");
    expect(
      messageParams(
        { code: "rollback.restarting", params: { version: "0.1.0" } },
        { translate, language: "en" },
      ).version,
    ).toBe("0.1.0");
  });
});
