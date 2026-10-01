import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { count, render } from "@/components/kit/test-utils";
import type { Failure } from "@/features/failures/api";
import type { Reason } from "@/features/verify/api";
import { i18n } from "@/i18n";

import "../i18n";
import { ItemCause, ReasonFindings } from "./reason-findings";

/**
 * The findings of a report explained: red before yellow, each with why and
 * what to do; findings the server could not explain keep their translated line.
 */

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className}>
        {children}
      </a>
    ),
  };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const DOCS = "https://docs.example.test/troubleshooting";

function failure(code: string, overrides: Partial<Failure> = {}): Failure {
  return {
    code,
    category: "verify",
    transient: false,
    retryable: true,
    params: {},
    technical: {},
    occurredAt: "2026-09-20T03:00:00.000Z",
    step: null,
    retry: null,
    steps: [],
    docsUrl: DOCS,
    ...overrides,
  };
}

const hashMismatch = failure("verify.hash_mismatch", {
  params: { count: 3 },
  steps: [
    { id: "run_backup_again", target: "jobs" },
    { id: "restore_from_copy", target: "storage" },
  ],
});

const snapshotStale = failure("verify.snapshot_stale", {
  params: { ageHours: 60 },
  steps: [{ id: "run_backup_again", target: "jobs" }],
});

const mismatched: Reason = {
  code: "items_mismatched",
  severity: "red",
  count: 3,
  ageHours: null,
  failure: hashMismatch,
};

const stale: Reason = {
  code: "snapshot_stale",
  severity: "yellow",
  count: null,
  ageHours: 60,
  failure: snapshotStale,
};

describe("ReasonFindings", () => {
  it("explains a finding: headline, why, steps with their places, docs link", () => {
    const html = render(<ReasonFindings reasons={[mismatched]} objectName="Ada Example" />);
    // The headline of the cause and the reason it is not green.
    expect(html).toContain("Restored data does not match the backup");
    expect(html).toContain("3 checked items came back");
    // What to do, with the places in the app.
    expect(html).toContain("What to do");
    expect(html).toContain("Run a new backup.");
    expect(html).toContain('href="/backup"');
    expect(html).toContain("If you have a copy target, restore the affected data files");
    expect(html).toContain('href="/repositories"');
    expect(html).toContain(`href="${DOCS}"`);
    expect(html).toContain("Troubleshooting guide");
  });

  it("skips 'what happened': the report page already names the object", () => {
    const html = render(<ReasonFindings reasons={[mismatched]} objectName="Ada Example" />);
    expect(html).not.toContain("What happened");
    expect(html).not.toContain("Ada Example");
  });

  it("shows red findings before yellow ones", () => {
    const html = render(<ReasonFindings reasons={[stale, mismatched]} objectName="Ada Example" />);
    const red = html.indexOf("Restored data does not match the backup");
    const yellow = html.indexOf("The latest backup is getting old");
    expect(red).toBeGreaterThan(-1);
    expect(yellow).toBeGreaterThan(red);
  });

  it("gives a yellow finding the warning tone and a red one the failure tone", () => {
    const html = render(<ReasonFindings reasons={[stale, mismatched]} objectName="Ada Example" />);
    expect(count(html, 'data-slot="alert"')).toBe(2);
    expect(count(html, "bg-warning/10")).toBe(1);
    expect(count(html, "bg-destructive/10")).toBe(1);
  });

  it("keeps the translated line for findings the server could not explain", () => {
    const plain: Reason = {
      code: "items_mismatched",
      severity: "red",
      count: 3,
      ageHours: null,
      failure: null,
    };
    const html = render(<ReasonFindings reasons={[plain]} objectName="Ada Example" />);
    expect(html).toContain("3 items came back different from what was backed up.");
    // The old list, and no empty box.
    expect(html).toContain("<ul");
    expect(html).not.toContain('data-slot="alert"');
    expect(html).not.toContain("What to do");
  });

  it("shows the generic line for a finding code of a newer worker", () => {
    const html = render(
      <ReasonFindings
        reasons={[
          { code: "quantum_drift", severity: "yellow", count: null, ageHours: null, failure: null },
        ]}
        objectName="Ada Example"
      />,
    );
    expect(html).toContain("Finding &quot;quantum_drift&quot; was reported by a newer version");
  });

  it("mixes explained and plain findings, red first, each in the order it arrived", () => {
    const plain: Reason = {
      code: "no_snapshot",
      severity: "red",
      count: null,
      ageHours: null,
      failure: null,
    };
    const html = render(<ReasonFindings reasons={[stale, plain, mismatched]} objectName="Ada" />);
    const plainLine = html.indexOf("No completed backup exists.");
    const red = html.indexOf("Restored data does not match the backup");
    const yellow = html.indexOf("The latest backup is getting old");
    expect(plainLine).toBeGreaterThan(-1);
    expect(red).toBeGreaterThan(plainLine);
    expect(yellow).toBeGreaterThan(red);
  });

  it("renders nothing for no findings", () => {
    expect(render(<ReasonFindings reasons={[]} objectName="Ada" />)).toBe(
      '<div class="space-y-3"></div>',
    );
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(<ReasonFindings reasons={[stale, mismatched]} objectName="Ada Example" />);
    expect(html).toContain("Wiederhergestellte Daten stimmen nicht mit dem Backup überein");
    expect(html).toContain("3 geprüfte Elemente kamen");
    expect(html).toContain("Das letzte Backup wird alt");
    expect(html).toContain("Was zu tun ist");
    expect(html).toContain("Starten Sie ein neues Backup.");
    expect(html).toContain("Anleitung zur Fehlersuche");
    expect(html).not.toContain("What to do");
  });

  it("speaks German for a finding without an explanation", async () => {
    await i18n.changeLanguage("de");
    const html = render(
      <ReasonFindings
        reasons={[
          { code: "no_snapshot", severity: "red", count: null, ageHours: null, failure: null },
        ]}
        objectName="Ada"
      />,
    );
    expect(html).not.toContain("No completed backup exists.");
    expect(html).not.toContain('data-slot="alert"');
  });
});

describe("ItemCause", () => {
  const pack = failure("verify.pack_unreadable", {
    technical: { errorName: "StorageReadError", path: "packs/ab/cd.pack" },
    steps: [{ id: "check_storage_health", target: "storage" }],
  });

  it("names the cause under the item and opens to the full explanation", () => {
    const html = render(<ItemCause failure={pack} item="Inbox/2026/mail-1.eml" />);
    expect(html).toContain("<details");
    expect(html).toContain('data-cause="verify.pack_unreadable"');
    expect(html).toContain("<summary");
    expect(html).toContain("Backup data in the storage is damaged");
    expect(html).toContain("What to do");
    expect(html).toContain('href="/repositories"');
    expect(html).toContain(`href="${DOCS}"`);
    // Technical details of this very item.
    expect(html).toContain("packs/ab/cd.pack");
    // The row names the item already.
    expect(html).not.toContain("What happened");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = render(<ItemCause failure={pack} item="Inbox/2026/mail-1.eml" />);
    expect(html).toContain("Backup-Daten im Speicher sind beschädigt");
    expect(html).toContain("Was zu tun ist");
  });
});
