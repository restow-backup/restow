import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import type { EndpointReadinessRow } from "@/features/verify/api";
import { i18n } from "@/i18n";

import "../i18n.js";
import { EndpointReadinessRowView, endpointResultKey } from "./readiness-row.js";

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({
      to,
      className,
      children,
      ...props
    }: { to: string; className?: string; children: React.ReactNode }) => (
      <a href={String(to)} className={className} {...props}>
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

function row(over: Partial<EndpointReadinessRow> = {}): EndpointReadinessRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    hostname: "web-01",
    displayName: null,
    profile: "server",
    os: "linux",
    state: "green",
    readiness: "green",
    checkedAt: "2026-09-29T09:00:00.000Z",
    overdue: false,
    latestBackupAt: "2026-09-29T08:00:00.000Z",
    latestSnapshotId: "s1",
    ...over,
  };
}

/** A table row cannot stand alone in static markup; wrap it the way the readiness table does. */
function html(over: Partial<EndpointReadinessRow> = {}): string {
  return render(
    <table>
      <tbody>
        <EndpointReadinessRowView row={row(over)} />
      </tbody>
    </table>,
  );
}

describe("endpointResultKey", () => {
  it("says what the restore test of the newest backup found", () => {
    expect(endpointResultKey({ state: "green", overdue: false })).toBe(
      "readinessSection.result.green",
    );
    expect(endpointResultKey({ state: "yellow", overdue: false })).toBe(
      "readinessSection.result.yellow",
    );
    expect(endpointResultKey({ state: "red", overdue: false })).toBe("readinessSection.result.red");
    expect(endpointResultKey({ state: "unverified", overdue: false })).toBe(
      "readinessSection.result.unverified",
    );
  });

  it("tells a machine that is still new from one that is overdue for its first backup", () => {
    expect(endpointResultKey({ state: "no_backup", overdue: false })).toBe(
      "readinessSection.result.noBackup",
    );
    expect(endpointResultKey({ state: "no_backup", overdue: true })).toBe(
      "readinessSection.result.noBackupOverdue",
    );
  });

  it("has a text for every key in both languages", async () => {
    for (const language of ["en", "de"]) {
      await i18n.changeLanguage(language);
      for (const state of ["green", "yellow", "red", "unverified", "no_backup"] as const) {
        for (const overdue of [false, true]) {
          const key = endpointResultKey({ state, overdue });
          const text = i18n.t(`endpoints:${key}`);
          expect(text, `${language} ${key}`).not.toBe(key);
          expect(text.trim(), `${language} ${key}`).not.toBe("");
        }
      }
    }
  });
});

describe("EndpointReadinessRowView", () => {
  it("shows the machine with its type, system, rating and a link to its page", () => {
    const out = html({ displayName: "Web front" });
    expect(out).toContain("Web front");
    expect(out).toContain("Server · Linux");
    expect(out).toContain("Ready");
    expect(out).toContain("The restore check of the newest backup matched every checked file.");
    expect(out).toContain('href="/inventory/11111111-1111-4111-8111-111111111111"');
    expect(out).toContain('aria-label="Open Web front"');
    expect(out).toContain("<time");
  });

  it("opens a client's page in the inventory, like a server's", () => {
    const out = html({ profile: "client", os: "darwin", hostname: "laptop-7" });
    expect(out).toContain("Client · macOS");
    expect(out).toContain('href="/inventory/11111111-1111-4111-8111-111111111111"');
  });

  it("keeps the host name as a tooltip when a label replaced it", () => {
    expect(html({ displayName: "Web front" })).toContain('title="web-01"');
  });

  it("shows a machine that was never checked as such", () => {
    const out = html({ state: "unverified", readiness: null, checkedAt: null });
    expect(out).toContain("Unverified");
    expect(out).toContain("Not checked");
    expect(out).toContain("A backup exists but was never checked.");
  });

  it("rates a machine without backup as waiting or as a problem, like the other objects", () => {
    const waiting = html({
      state: "no_backup",
      readiness: null,
      overdue: false,
      checkedAt: null,
      latestBackupAt: null,
    });
    expect(waiting).toContain("Waiting for first backup");
    expect(waiting).toContain("No backup yet");
    const overdue = html({
      state: "no_backup",
      readiness: null,
      overdue: true,
      checkedAt: null,
      latestBackupAt: null,
    });
    expect(overdue).toContain('data-tone="destructive"');
    expect(overdue).toContain("No backup within 24 hours of protection starting.");
    // The state badge already says so; no second badge.
    expect(overdue).not.toContain(">Overdue<");
  });

  it("flags a stale check on a rated machine with its own badge", () => {
    expect(html({ overdue: true })).toContain(">Overdue<");
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const out = html({ state: "red", readiness: "red" });
    expect(out).toContain("Nicht wiederherstellbar");
    expect(out).toContain("Öffnen");
  });
});
