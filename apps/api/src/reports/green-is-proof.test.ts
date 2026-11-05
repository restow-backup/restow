/**
 * Green means proof (brand guide, section 4; the same rule as
 * apps/web/src/green-is-proof.test.ts): a restore that completed, a rating of
 * Ready, a restore check that passed. In the statistics report that is the
 * "completed" series of the restores chart, the "green" series of the
 * readiness chart and a state cell that says Ready. A backup run that merely
 * completed is Lapis, and a figure that moved the right way is plain text:
 * neither is green.
 *
 * The test reads the colours back from the rendered PDF: it inflates the
 * content streams and collects the colour operators (`r g b scn`), so it
 * checks what is drawn, not how the code spells it.
 */
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { StatsDto } from "../features/stats/dto.js";
import { deltaTone, type GoodDirection, renderStatsReport } from "./stats-report.js";
import { sampleStats } from "./testing/sample-stats.js";
import { colors, toneColor } from "./theme.js";

/** Every `r g b` triple a PDF paints with, from its (Flate-compressed) content streams. */
function paintedColours(pdf: Buffer): Set<string> {
  return new Set(paintCounts(pdf).keys());
}

/** How often a PDF sets each `r g b` triple, from its (Flate-compressed) content streams. */
function paintCounts(pdf: Buffer): Map<string, number> {
  const text = pdf.toString("latin1");
  const found = new Map<string, number>();
  let from = 0;
  for (;;) {
    const start = text.indexOf("stream", from);
    if (start < 0) {
      break;
    }
    const end = text.indexOf("endstream", start);
    let begin = start + "stream".length;
    if (text[begin] === "\r") {
      begin++;
    }
    if (text[begin] === "\n") {
      begin++;
    }
    from = end + "endstream".length;
    let content: string;
    try {
      content = inflateSync(pdf.subarray(begin, end)).toString("latin1");
    } catch {
      continue;
    }
    for (const [, r, g, b] of content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:scn|SCN|rg|RG)\b/g)) {
      const key = rgbKey([Number(r), Number(g), Number(b)]);
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

function rgbKey(channels: readonly number[]): string {
  return channels.map((channel) => Math.round(channel * 255)).join(",");
}

function hexKey(hex: string): string {
  return rgbKey([1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255));
}

const GREENS = [colors.success, colors.successText, toneColor.success].map(hexKey);

/** The tenant statistics with every source of proof taken out: no restores, no readiness, no Ready state. */
function withoutProof(stats: StatsDto): StatsDto {
  const objects = Array.isArray(stats.tables.largestObjects) ? stats.tables.largestObjects : [];
  return {
    ...stats,
    series: {
      ...stats.series,
      restores: { unavailable: "no_backups_yet" },
      readiness: { unavailable: "no_backups_yet" },
    },
    tables: {
      ...stats.tables,
      largestObjects: objects.filter((object) => object.state !== "green"),
    },
  };
}

const subject = { kind: "tenant", name: "Fabrikam AG" } as const;

describe("green is proof in the statistics report", () => {
  it("draws green where a restore completed or a rating is Ready (the check is not blind)", async () => {
    const pdf = await renderStatsReport({ stats: sampleStats(), subject, language: "en" });
    const painted = paintedColours(pdf);
    expect(painted.has(hexKey(colors.success))).toBe(true);
  });

  it("draws no green when nothing is proof: completed backups are Lapis, good news is plain text", async () => {
    const stats = withoutProof(sampleStats());
    // The backup chart and the key figures are still there, with runs that completed and rates that rose.
    expect(Array.isArray(stats.series.backups)).toBe(true);
    expect(stats.kpis.backupSuccessRate.value).toBeGreaterThan(
      stats.kpis.backupSuccessRate.previous ?? 1,
    );
    const painted = paintedColours(await renderStatsReport({ stats, subject, language: "en" }));
    for (const green of GREENS) {
      expect(painted.has(green), `green ${green} is drawn without proof`).toBe(false);
    }
    // The completed backups are drawn in Lapis.
    expect(painted.has(hexKey(colors.accent))).toBe(true);
  });

  it("draws no green in the German provider report either, once proof is taken out", async () => {
    const stats = withoutProof(sampleStats("provider"));
    // The tenant table rates tenants: Ready is proof, so take the ratings out of the way.
    const tenants = stats.tables.tenants;
    const rated = Array.isArray(tenants)
      ? tenants.map((row) => ({
          ...row,
          readiness: row.readiness === "green" ? null : row.readiness,
        }))
      : tenants;
    const painted = paintedColours(
      await renderStatsReport({
        stats: { ...stats, tables: { ...stats.tables, tenants: rated } },
        subject: { kind: "provider", tenantCount: 3 },
        language: "de",
      }),
    );
    for (const green of GREENS) {
      expect(painted.has(green), `green ${green} is drawn without proof`).toBe(false);
    }
  });

  describe("the readiness categories (UI rework, Phase 1)", () => {
    it("paints Needs attention orange and No backup yet in its own dark red, apart from the amber Unverified", async () => {
      const stats = sampleStats();
      const points = Array.isArray(stats.series.readiness) ? stats.series.readiness : [];
      expect(points.some((point) => point.noBackup > 0)).toBe(true);
      const painted = paintedColours(await renderStatsReport({ stats, subject, language: "en" }));
      expect(painted.has(hexKey(colors.attention))).toBe(true);
      expect(painted.has(hexKey(colors.noBackup))).toBe(true);
      expect(painted.has(hexKey(colors.warning))).toBe(true);
      expect(hexKey(colors.attention)).not.toBe(hexKey(colors.warning));
      expect(hexKey(colors.noBackup)).not.toBe(hexKey(colors.destructive));
    });

    it("writes an object without a backup in the danger tone, not in grey", async () => {
      const base = withoutProof(sampleStats());
      const objects = Array.isArray(base.tables.largestObjects) ? base.tables.largestObjects : [];
      const one = objects[0];
      expect(one).toBeDefined();
      const render = (state: "no_backup" | "empty") =>
        renderStatsReport({
          stats: {
            ...base,
            tables: {
              ...base.tables,
              largestObjects: [{ ...(one as (typeof objects)[0]), state }],
            },
          },
          subject,
          language: "en",
        });
      // The two reports differ in that one cell only: it is set in the danger colour once more,
      // and in the neutral grey once less.
      const noBackup = paintCounts(await render("no_backup"));
      const empty = paintCounts(await render("empty"));
      const count = (counts: Map<string, number>, hex: string) => counts.get(hexKey(hex)) ?? 0;
      expect(count(noBackup, toneColor.destructive)).toBe(count(empty, toneColor.destructive) + 1);
      expect(count(noBackup, toneColor.neutral)).toBe(count(empty, toneColor.neutral) - 1);
    });
  });

  describe("the tone of a change", () => {
    const directions: GoodDirection[] = ["up", "down", "neutral"];

    it("is never green, whichever way the figure moved", () => {
      for (const good of directions) {
        for (const change of [-5, -0.001, 0.001, 5]) {
          expect(deltaTone(good, change), `${good} ${change}`).not.toBe("success");
        }
      }
    });

    it("is plain text for good news, red for bad news and grey without a judgement", () => {
      expect(deltaTone("up", 2)).toBe("positive");
      expect(deltaTone("down", -2)).toBe("positive");
      expect(deltaTone("up", -2)).toBe("destructive");
      expect(deltaTone("down", 2)).toBe("destructive");
      expect(deltaTone("neutral", 2)).toBe("neutral");
      expect(toneColor.positive).toBe(colors.text);
    });
  });
});
