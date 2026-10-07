import restoreDe from "@restow/i18n/resources/de/restore.json" with { type: "json" };
import restoreEn from "@restow/i18n/resources/en/restore.json" with { type: "json" };
import { describe, expect, it } from "vitest";

/**
 * Explorer wording: every visible "snapshot" becomes "restore point"
 * ("Sicherungsstand" in German). The `jobs`/`job`/`items` namespaces belong
 * to the restore jobs pages and keep their own "backup"/"Sicherung" wording,
 * so this only checks the explorer's own namespaces: `explorer`, `details`,
 * `versions`, `dialog`.
 */

const EXPLORER_NAMESPACES = ["explorer", "details", "versions", "dialog"] as const;

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    // Interpolation placeholders ("{snapshot}") name ICU variables, not
    // visible text; a param keeping its old name is not a wording problem.
    out.push(value.replace(/\{[^}]*\}/g, ""));
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      collectStrings(child, out);
    }
  }
  return out;
}

describe("explorer wording: 'restore point' replaces 'snapshot'", () => {
  it("never shows the English word 'snapshot' in the explorer's visible strings", () => {
    for (const namespace of EXPLORER_NAMESPACES) {
      for (const value of collectStrings(restoreEn[namespace])) {
        expect(value, `en:${namespace} → "${value}"`).not.toMatch(/snapshot/i);
      }
    }
  });

  it("never shows the German technical term 'Snapshot' (untranslated)", () => {
    for (const namespace of EXPLORER_NAMESPACES) {
      for (const value of collectStrings(restoreDe[namespace])) {
        expect(value, `de:${namespace} → "${value}"`).not.toMatch(/snapshot/i);
      }
    }
  });

  it("names the restore point explicitly in the picker and the version history", () => {
    expect(restoreEn.explorer.restorePoint.fieldLabel).toBe("Restore point");
    expect(restoreEn.explorer.restorePoint.item).toContain("Restore point");
    expect(restoreEn.versions.sequence).toContain("Restore point");
    expect(restoreDe.explorer.restorePoint.fieldLabel).toBe("Sicherungsstand");
    expect(restoreDe.explorer.restorePoint.item).toContain("Sicherungsstand");
    expect(restoreDe.versions.sequence).toContain("Sicherungsstand");
  });

  it("names the restore point a restore came from the same way on the jobs pages", () => {
    expect(restoreEn.jobs.snapshot).toContain("Restore point #");
    expect(restoreDe.jobs.snapshot).toContain("Sicherungsstand #");
    expect(restoreDe.job.request.snapshot).toBe("Sicherungsstand");
  });
});
