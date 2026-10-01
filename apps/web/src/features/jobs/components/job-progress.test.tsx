import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Job, JobProgress } from "@/features/jobs/api";
import { i18n } from "@/i18n";

import "@/features/jobs/i18n";
import { ProgressBar, ProgressSummary } from "./job-progress";

const NOW = Date.parse("2026-09-29T09:05:00.000Z");

function progress(overrides: Partial<JobProgress> = {}): JobProgress {
  return { total: 0, done: 0, failed: 0, bytes: 0, etaSeconds: null, updatedAt: "", ...overrides };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    queue: "backup",
    status: "failed",
    protectedObjectId: "o-1",
    object: null,
    scheduleId: null,
    full: false,
    createdAt: "2026-09-29T09:00:00.000Z",
    updatedAt: "2026-09-29T09:05:00.000Z",
    startedAt: "2026-09-29T09:00:10.000Z",
    completedAt: "2026-09-29T09:05:00.000Z",
    errorMessage: null,
    progress: progress(),
    phase: null,
    throttle: null,
    cancellable: false,
    retryable: true,
    ...overrides,
  };
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

const summary = (value: Job) => render(<ProgressSummary job={value} now={NOW} />);

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the progress bar of a completed job", () => {
  it("is full but not green: green means a passed restore check", () => {
    const html = render(
      <ProgressBar job={job({ status: "completed", progress: progress({ total: 4, done: 4 }) })} />,
    );
    expect(html).toContain("bg-muted-foreground");
    expect(html).not.toContain("bg-success");
  });
});

describe("the progress card of a finished job", () => {
  describe("in English", () => {
    beforeAll(async () => {
      await i18n.changeLanguage("en");
    });

    it("says plainly that a failed job processed nothing, not '0 items so far'", () => {
      const html = summary(job({ status: "failed" }));
      expect(html).toContain("No items processed");
      expect(html).not.toContain("so far");
    });

    it("says the same for a cancelled job and for a failed restore check", () => {
      expect(summary(job({ status: "cancelled" }))).toContain("No items processed");
      expect(summary(job({ status: "failed", queue: "verify" }))).toContain("No items processed");
    });

    it("counts what a failed job got through, without 'so far'", () => {
      const html = summary(job({ status: "failed", progress: progress({ done: 12, failed: 2 }) }));
      expect(html).toContain("12 items processed");
      expect(html).toContain("2 items failed");
      expect(html).not.toContain("so far");
    });

    it("keeps 'N of M items' when the total was known", () => {
      const html = summary(job({ status: "failed", progress: progress({ total: 40, done: 12 }) }));
      expect(html).toContain("12 of 40 items");
    });

    it("keeps 'so far' for a job that is still running", () => {
      const html = summary(job({ status: "active", progress: progress({ done: 12 }) }));
      expect(html).toContain("12 items so far");
    });

    it("does not call the data of a failed backup 'new data'", () => {
      const html = summary(
        job({ status: "failed", progress: progress({ done: 5, bytes: 2_000_000 }) }),
      );
      expect(html).toContain("stored before it stopped");
      expect(html).not.toContain("new data");
    });

    it("calls the bytes of a restore check 'read', failed or not", () => {
      for (const status of ["active", "completed", "failed"] as const) {
        const html = summary(
          job({ status, queue: "verify", progress: progress({ done: 5, bytes: 2_000_000 }) }),
        );
        expect(html, status).toContain("read");
        expect(html, status).not.toContain("new data");
      }
    });

    it("keeps 'new data' for a backup that ran, and 'No changes' for one that had nothing to do", () => {
      expect(
        summary(job({ status: "completed", progress: progress({ done: 5, bytes: 2_000_000 }) })),
      ).toContain("new data");
      expect(summary(job({ status: "completed" }))).toContain("No changes");
    });

    it("gives the bar of a finished job a value for screen readers", () => {
      const html = render(<ProgressBar job={job({ status: "failed" })} />);
      expect(html).toContain('aria-valuetext="No items processed"');
    });
  });

  describe("in German", () => {
    beforeAll(async () => {
      await i18n.changeLanguage("de");
    });

    it("says that a failed job processed nothing, not '0 Elemente bisher'", () => {
      const html = summary(job({ status: "failed" }));
      expect(html).toContain("Keine Elemente verarbeitet");
      expect(html).not.toContain("bisher");
    });

    it("counts what a failed job got through", () => {
      const html = summary(job({ status: "failed", progress: progress({ done: 12, failed: 2 }) }));
      expect(html).toContain("12 Elemente verarbeitet");
      expect(html).not.toContain("bisher");
    });

    it("words the bytes of a failed backup and of a restore check", () => {
      expect(
        summary(job({ status: "failed", progress: progress({ done: 5, bytes: 2_000_000 }) })),
      ).toContain("vor dem Stopp gespeichert");
      const check = summary(
        job({
          status: "completed",
          queue: "verify",
          progress: progress({ done: 5, bytes: 2_000_000 }),
        }),
      );
      expect(check).toContain("gelesen");
      expect(check).not.toContain("neue Daten");
    });

    it("keeps 'bisher' for a job that is still running", () => {
      expect(summary(job({ status: "active", progress: progress({ done: 12 }) }))).toContain(
        "12 Elemente bisher",
      );
    });
  });
});
