import backupDe from "@restow/i18n/resources/de/backup.json" with { type: "json" };
import backupEn from "@restow/i18n/resources/en/backup.json" with { type: "json" };
import { describe, expect, it } from "vitest";

import { KNOWN_PHASES, phaseLabel } from "./presenters";

/**
 * Every phase an engine reports and the UI claims to know has a label in both
 * languages; otherwise the job page would show the raw code ("probe").
 */
describe("engine phases", () => {
  const phases: Record<string, Record<string, string>> = {
    de: backupDe.phase,
    en: backupEn.phase,
  };

  it("are labelled in German and English", () => {
    for (const [language, labels] of Object.entries(phases)) {
      const missing = KNOWN_PHASES.filter((phase) => typeof labels[phase] !== "string");
      expect(missing, language).toEqual([]);
    }
  });

  it("include the directory sync phases", () => {
    for (const phase of ["load", "enumerate", "complete", "probe", "plan", "persist"]) {
      expect(phaseLabel(phase).key).toBe(`phase.${phase}`);
    }
  });
});
