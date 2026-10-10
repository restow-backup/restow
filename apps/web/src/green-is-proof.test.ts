import { describe, expect, it } from "vitest";

/**
 * Green means proof (brand guide, section 4): "Green only after a passed
 * restore test, never after a merely completed backup, never as decoration".
 * In this app green is the `success` tone, the `--success` tokens and the
 * `--chart-success` series colour. A state that merely is fine (protected,
 * active, online, a backup that completed, an export that was written) is the
 * neutral outline; running work and plain information are Lapis (`info`).
 *
 * This guard lists every source file that names the success tone and says why
 * it may: each is a restore check that passed, a restore that completed, an
 * integrity check that came back intact, or the definition of the tone itself.
 * A new file that reaches for green fails here until someone decides it is
 * proof and adds it below; a file that stops using green must leave the list,
 * so the list stays the honest inventory of where green appears.
 */

const sources = import.meta.glob<string>(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.*", "!./vite-env.d.ts"],
  { query: "?raw", import: "default", eager: true },
);

/** The success tone as a class, a variant or tone name, or the green chart series. */
const GREEN =
  /\b(?:bg|text|border|fill|stroke|ring|from|via|to|outline|divide|shadow|accent)-success\b|["']success["']|STATUS_CHART_COLOR\.success|--chart-success/;

const ALLOWED: Readonly<Record<string, string>> = {
  // -- the definition of the tone
  "./components/ui/alert.tsx": "the success variant of the alert",
  "./components/ui/badge.tsx": "the success variant of the badge",
  "./components/kit/status-badge.tsx": "the success tone and its variant",
  "./components/kit/chart-colors.ts": "the success series colour",
  "./features/updates/components/version-card.tsx":
    "a key the icon tone record needs for the type; no state maps to it",
  // -- the result of a restore check: Ready, Verified, a rating of green
  "./features/verify/presenters.ts": "Ready / Verified / storage check intact",
  "./features/verify/components/summary.tsx": "the Ready banner and tile",
  "./features/verify/report-page.tsx": "items that came back byte-exact",
  "./features/dashboard/presenters.ts": "the green readiness segment; a completed restore",
  "./features/dashboard/components/readiness-legend.tsx":
    "the fill of the green segment: the objects a restore check proved",
  "./features/dashboard/widgets/trend-widgets.tsx": "restore checks that passed, over time",
  "./features/stats/presenters.ts": "a rating of green",
  "./features/stats/components/outcome-charts.tsx": "restores that completed; Ready over time",
  "./features/tenants/presenters.ts": "the readiness of a tenant",
  "./features/directory/presenters.ts": "the readiness of a protected object",
  "./features/backup-jobs/presenters.ts":
    "the restore checks of a job: green only when every object or machine passed",
  "./features/jobs/presenters.ts": "the readiness badge; a restore that completed",
  "./features/history/presenters.ts":
    "a restore check that passed, and a restore that completed (the data is back)",
  "./features/endpoints/presenters.ts":
    "restore and restore test runs; a green restore test report; a restore request that went through",
  "./features/file-shares/presenters.ts":
    "a file share whose restore check passed; a restore into a share that completed",
  "./features/pve/guest-page.tsx":
    "a restore point whose restore check passed; a restore or restore check of a guest that completed",
  "./features/archive/chain-check.tsx":
    "an archive check that passed: links, daily anchors and the content sample it read",
  // -- a restore that completed: the data is back
  "./features/restore/lib/jobs.ts": "a restore that completed",
  "./features/restore/jobs/job-page.tsx": "items that were restored",
  // -- not a tone: the status of a data fetch
  "./features/tenants/hooks.ts": "the status of a query",
  "./features/tenants/components/installation-panel.tsx": "the status of a query",
};

const files = Object.entries(sources);
const using = files.filter(([, source]) => GREEN.test(source)).map(([path]) => path);

describe("green is proof", () => {
  it("scans the app's sources", () => {
    expect(files.length, "the glob no longer reaches the sources").toBeGreaterThan(300);
  });

  it("is named only by files that show a restore check, a restore or an integrity check", () => {
    const unexpected = using.filter((path) => !(path in ALLOWED));
    expect(
      unexpected,
      "These files use the success tone (green). Green is for proof only; use `neutral`, `outline` or `info`, or add the file to ALLOWED with the reason it is proof.",
    ).toEqual([]);
  });

  it("keeps the list honest: every file on it still uses green", () => {
    const stale = Object.keys(ALLOWED).filter((path) => !using.includes(path));
    expect(stale, "These files no longer use green; remove them from ALLOWED.").toEqual([]);
  });

  it("draws a backup run that merely completed in Lapis (info) in every chart, never green", () => {
    // The two charts that plot backup outcomes. They may name green for the series next to it
    // (restores, readiness), so the file-level list above cannot tell; this reads the series.
    const BACKUP_CHARTS = [
      "./features/stats/components/outcome-charts.tsx",
      "./features/dashboard/widgets/trend-widgets.tsx",
    ];
    for (const path of BACKUP_CHARTS) {
      const source = sources[path] ?? "";
      const tones = [
        ...source.matchAll(/\bsucceeded:\s*\{[^}]*color:\s*STATUS_CHART_COLOR\.(\w+)/g),
      ].map(([, tone]) => tone);
      expect(tones.length, `${path}: no "succeeded" series found`).toBeGreaterThan(0);
      for (const tone of tones) {
        expect(tone, `${path}: completed backups are stowed, not proven`).toBe("info");
      }
    }
  });

  it("never reaches for a raw green", () => {
    const raw = files
      .filter(([, source]) =>
        /\b(?:bg|text|border|fill|stroke)-(?:green|emerald|lime|teal)-\d{2,3}\b/.test(source),
      )
      .map(([path]) => path);
    expect(raw).toEqual([]);
  });
});
