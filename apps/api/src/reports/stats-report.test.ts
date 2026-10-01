/**
 * The statistics report rendered to PDF in both languages and read back with
 * unpdf: the page count, the running footer on every page, the figures in
 * the report's language, datasets without a source said plainly, and no
 * translation key left untranslated.
 */
import { extractText, getDocumentProxy } from "unpdf";
import { describe, expect, it } from "vitest";
import { buildStats } from "../features/stats/build.js";
import { resolvePeriod } from "../features/stats/period.js";
import { type StatsReportProps, renderStatsReport } from "./stats-report.js";
import { sampleStats } from "./testing/sample-stats.js";

async function read(props: StatsReportProps) {
  const buffer = await renderStatsReport(props);
  expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const firstPage = await pdf.getPage(1);
  const { width, height } = firstPage.getViewport({ scale: 1 });
  return { totalPages, pages: text, all: text.join("\n"), width, height };
}

/** Text that only an untranslated key or an unfilled placeholder would produce. */
const LEAKS = [/\bstats\.[a-zA-Z]/, /\bdocument\.[a-zA-Z]/, /\bunavailable\.[a-z]/, /\{[a-z]+\}/];

describe("statistics report", () => {
  it("renders the German report with its figures and a footer on every page", async () => {
    const stats = sampleStats();
    // An IMAP-only tenant: no throttling series and no throttling figure.
    expect(stats.series.throttling).toEqual({ unavailable: "no_microsoft_365_source" });
    expect(stats.kpis.throttlingWaitSeconds).toEqual({ value: null, previous: null });
    const report = await read({
      stats,
      subject: { kind: "tenant", name: "Fabrikam AG" },
      language: "de",
    });
    expect(Math.round(report.width)).toBe(595);
    expect(Math.round(report.height)).toBe(842);
    expect(report.totalPages).toBe(4);
    report.pages.forEach((page, index) => {
      expect(page).toContain(`Seite ${index + 1} von 4`);
      expect(page).toContain("Erstellt am 23.09.2026, 10:00 (UTC)");
    });
    for (const fragment of [
      "Backup-Statistik",
      "Mandant: Fabrikam AG",
      "Zeitraum: 25.08.2026 bis 23.09.2026, pro Tag",
      "Erfolgsquote der Sicherungen",
      "98,3 %",
      "+3,3 Pp. ggü. Vorzeitraum",
      "Drosselung durch Microsoft 365\nNicht verfügbar",
      "Ergebnisse der Sicherungen",
      "Nicht verfügbar: Es ist keine Microsoft-365-Quelle verbunden.",
      "Wiederherstellbarkeit",
      "Sicherung 5.900 5 Min. 6,8 Min.",
      "IMAP FETCH failed: Connection reset by peer",
      "Buchhaltung Müller & Söhne",
      "Lukasz Kowalski",
      "So werden diese Zahlen ermittelt",
    ]) {
      expect(report.all).toContain(fragment);
    }
    // The provider-only table is not part of a tenant report.
    expect(report.all).not.toContain("Alle verwalteten Mandanten");
    for (const leak of LEAKS) {
      expect(report.all).not.toMatch(leak);
    }
  });

  it("renders the English provider report with the tenant table", async () => {
    const report = await read({
      stats: sampleStats("provider"),
      subject: { kind: "provider", tenantCount: 3 },
      language: "en",
    });
    expect(report.totalPages).toBe(4);
    report.pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} of 4`);
    });
    for (const fragment of [
      "Backup statistics",
      "All tenants (3 tenants)",
      "Period: Aug 25, 2026 to Sep 23, 2026, per day",
      "98.6%",
      "+4.3 pp vs. previous period",
      "+36 vs. previous period",
      // One tenant has Microsoft 365, so the provider has throttling figures.
      "Microsoft 365 throttling\n1.5 hr\n-30 min vs. previous period",
      "Every managed tenant at the end of the period.",
      "Adatum KG 3 No value",
      "Contoso GmbH 150 99%",
      "Fabrikam AG 212 98.3%",
      "Not proven",
      "Geschäftsführung Mailbox Contoso GmbH",
      "How these figures are measured",
    ]) {
      expect(report.all).toContain(fragment);
    }
    expect(report.all).not.toContain("No Microsoft 365 source is connected");
    for (const leak of LEAKS) {
      expect(report.all).not.toMatch(leak);
    }
  });

  it("renders a report without any data as plain statements, not zeros", async () => {
    const now = new Date("2026-09-23T10:00:00.000Z");
    const stats = buildStats({
      period: resolvePeriod({ from: "2026-09-01", to: "2026-09-23" }, now),
      scope: "provider",
      tenants: [],
      generatedAt: now,
    });
    const report = await read({
      stats,
      subject: { kind: "provider", tenantCount: 0 },
      language: "en",
    });
    expect(report.totalPages).toBeGreaterThanOrEqual(1);
    expect(report.pages.at(-1)).toContain(`Page ${report.totalPages} of ${report.totalPages}`);
    expect(report.all).toContain("All tenants (0 tenants)");
    expect(report.all).toContain("Not available: No tenant is managed yet.");
    // Every key figure says it is not available instead of showing 0.
    expect(report.all.match(/Not available\n/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
    for (const leak of LEAKS) {
      expect(report.all).not.toMatch(leak);
    }
  });
});
