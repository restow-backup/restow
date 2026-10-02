import type * as React from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { count, render } from "@/components/kit/test-utils";
import type { EndpointReadinessRow, ObjectReadiness, VerifyObject } from "@/features/verify/api";
import type { ReadinessState } from "@/features/verify/search";
import { useVerifyFormat } from "@/features/verify/use-verify";
import { i18n } from "@/i18n";

import "../i18n.js";
import { ObjectsTable } from "./objects-table";

// The table's "report"/"view report" links become plain anchors, the same
// way the dashboard widget tests do it, so the table renders outside a
// <RouterProvider> (this is a static-markup contract test, not a routing one).
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

/** Renders with the real `useVerifyFormat`; the hook needs no context but i18n. */
function withFormat(build: (format: ReturnType<typeof useVerifyFormat>) => React.ReactNode) {
  function Wrapper() {
    return build(useVerifyFormat());
  }
  return <Wrapper />;
}

function object(over: Partial<VerifyObject> = {}): VerifyObject {
  return {
    id: "o1",
    kind: "mailbox",
    displayName: null,
    externalId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    email: null,
    upn: null,
    ...over,
  };
}

function readiness(over: Partial<ObjectReadiness> = {}): ObjectReadiness {
  return {
    object: object(),
    state: "green",
    readiness: "green",
    checkedAt: "2026-09-20T03:00:00.000Z",
    overdue: false,
    latestSnapshotAt: "2026-09-20T02:00:00.000Z",
    report: { id: "r1", kind: "verify", origin: "verify", reasons: [], counts: null },
    running: null,
    latestSnapshotId: "s1",
    previousCheck: null,
    ...over,
  };
}

function machine(over: Partial<EndpointReadinessRow> = {}): EndpointReadinessRow {
  return {
    id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
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

function table(
  items: readonly ObjectReadiness[],
  nextBackupAt: string | null = null,
  endpoints: readonly EndpointReadinessRow[] = [],
  state?: ReadinessState,
) {
  return render(
    withFormat((format) => (
      <ObjectsTable
        items={items}
        endpoints={endpoints}
        format={format}
        startingObjectId={null}
        nextBackupAt={nextBackupAt}
        onCheck={() => {}}
        state={state}
        onStateChange={() => {}}
      />
    )),
  );
}

/** What a state chip says: its figure (the count behind it), or null when there is no such chip. */
function chipFigure(html: string, state: string): string | null {
  const chip = new RegExp(`<button[^>]*data-state="${state}"[^>]*>(.*?)</button>`).exec(html);
  return chip?.[1]?.match(/<span class="font-mono[^"]*">([^<]*)<\/span>/)?.[1] ?? null;
}

describe("ObjectsTable", () => {
  it("names a mailbox by its display name and address, never the opaque Entra id", () => {
    const html = table([
      readiness({
        object: object({
          displayName: "Ada Example",
          email: "ada@contoso.test",
          externalId: "11111111-1111-4111-8111-111111111111",
        }),
      }),
    ]);
    expect(html).toContain("Ada Example");
    expect(html).toContain("ada@contoso.test");
    // The id stays available, off the visible label, only as a tooltip.
    expect(html).not.toContain("11111111-1111-4111-8111-111111111111<");
    expect(html).toContain("Technical id: 11111111-1111-4111-8111-111111111111");
  });

  it("falls back to the kind, never a raw id, when nothing human is known", () => {
    const html = table([
      readiness({ object: object({ displayName: null, email: null, upn: null }) }),
    ]);
    expect(html).toContain("Mailbox");
    expect(html).not.toContain("11111111-1111-4111-8111-111111111111<");
  });

  it("shows the IMAP login as the address", () => {
    const html = table([
      readiness({
        object: object({
          kind: "imap",
          displayName: "Backup mailbox",
          externalId: "svc-backup@example.test",
        }),
      }),
    ]);
    expect(html).toContain("Backup mailbox");
    expect(html).toContain("svc-backup@example.test");
  });

  it("never wraps the readiness badge onto a second line", () => {
    // A fresh, waiting object: nothing else in the row renders a badge, so
    // this is the exact one the maintainer reported wrapping onto three lines.
    const html = table([readiness({ state: "no_backup", readiness: null, report: null })]);
    const [stateBadge] = html.match(/<span data-slot="badge"[^>]*>/g) ?? [];
    expect(stateBadge).toBeDefined();
    expect(stateBadge).toContain('data-tone="warning"');
    expect(stateBadge).toContain("whitespace-nowrap");
  });

  it("shows a fresh no_backup object as waiting, in a warning tone, not red", () => {
    const html = table([
      readiness({
        state: "no_backup",
        readiness: null,
        report: null,
        checkedAt: null,
        latestSnapshotAt: null,
        overdue: false,
      }),
    ]);
    expect(html).toContain("Waiting for first backup");
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain("Nothing to verify until the first backup completes.");
    // The state badge itself (not the "Latest backup" column, which
    // coincidentally shares the words "No backup yet" as its own fallback).
    const badges = html.match(/<span data-slot="badge"[^>]*>[\s\S]*?<\/span>/g) ?? [];
    const stateBadge = badges.find((tag) => tag.includes('data-tone="warning"'));
    expect(stateBadge).toContain("Waiting for first backup");
    expect(stateBadge).not.toContain("No backup yet");
  });

  it("hints the next scheduled backup while waiting, when one is known", () => {
    const html = table(
      [
        readiness({
          state: "no_backup",
          readiness: null,
          report: null,
          checkedAt: null,
          latestSnapshotAt: null,
          overdue: false,
        }),
      ],
      "2026-09-24T03:00:00.000Z",
    );
    expect(html).toMatch(/Nothing to verify yet; the next backup is due/);
  });

  it("keeps the red tone and a specific reason once no_backup is overdue", () => {
    const html = table([
      readiness({
        state: "no_backup",
        readiness: null,
        report: null,
        checkedAt: null,
        latestSnapshotAt: null,
        overdue: true,
      }),
    ]);
    expect(html).toContain("No backup yet");
    expect(html).toContain('data-tone="destructive"');
    expect(html).toContain("No backup within 24 hours of protection starting.");
    // The state badge alone says it is overdue; no redundant second badge.
    expect(count(html, ">Overdue<")).toBe(0);
  });

  it("still shows the separate Overdue badge for a stale check on an existing backup", () => {
    const html = table([readiness({ state: "green", overdue: true })]);
    expect(html).toContain(">Overdue<");
  });

  it("counts the chips from the given items, one per state", () => {
    const html = table([
      readiness({ object: object({ id: "a" }), state: "green" }),
      readiness({ object: object({ id: "b" }), state: "red", readiness: "red" }),
      readiness({
        object: object({ id: "c" }),
        state: "no_backup",
        readiness: null,
        report: null,
        overdue: false,
      }),
      readiness({
        object: object({ id: "d" }),
        state: "no_backup",
        readiness: null,
        report: null,
        overdue: true,
      }),
    ]);
    expect(chipFigure(html, "all")).toBe("4");
    expect(chipFigure(html, "green")).toBe("1");
    expect(chipFigure(html, "yellow")).toBe("0");
    expect(chipFigure(html, "red")).toBe("1");
    expect(chipFigure(html, "unverified")).toBe("0");
    // Every object without a backup counts, the one still waiting for its first backup as well.
    expect(chipFigure(html, "no_backup")).toBe("2");
  });

  it("filters the table to the state the address names, and says when nothing is in it", () => {
    const items = [
      readiness({ object: object({ id: "a", displayName: "Ada Example" }), state: "green" }),
      readiness({
        object: object({ id: "b", displayName: "Bob Example" }),
        state: "red",
        readiness: "red",
      }),
    ];
    const red = table(items, null, [], "red");
    expect(count(red, "<tr")).toBe(1 + 1);
    expect(red).toContain("Bob Example");
    expect(red).not.toContain("Ada Example");
    // The chips still count everything, and the chosen one is pressed.
    expect(chipFigure(red, "green")).toBe("1");
    expect(red).toMatch(/aria-pressed="true"[^>]*data-state="red"/);
    expect(red).toMatch(/aria-pressed="false"[^>]*data-state="all"/);

    const unverified = table(items, null, [], "unverified");
    expect(count(unverified, "<tr")).toBe(0);
    expect(unverified).toContain("No object in this state: Not verified.");

    const all = table(items);
    expect(all).toMatch(/aria-pressed="true"[^>]*data-state="all"/);
    expect(count(all, "<tr")).toBe(1 + 2);
  });

  it("truncates the result's main line instead of wrapping, keeping the full text as a tooltip", () => {
    const html = table([
      readiness({
        report: {
          id: "r1",
          kind: "verify",
          origin: "verify",
          reasons: [],
          counts: { checked: 30, verified: 25, failed: 5 },
        },
      }),
    ]);
    expect(html).toMatch(
      /<p class="[^"]*truncate[^"]*" title="25 of 30 items restored byte-exact">/,
    );
  });

  it("gives the finding a tooltip with the full reason text", () => {
    const html = table([
      readiness({
        report: {
          id: "r1",
          kind: "health_check",
          origin: "unknown",
          reasons: [
            { code: "items_missing", severity: "red", count: 5, ageHours: null, failure: null },
          ],
          counts: null,
        },
      }),
    ]);
    expect(html).toMatch(/title="[^"]*data that is missing from the chunk index/);
  });

  it("shows the same finding text whether or not the server explained the reason", () => {
    const explained = table([
      readiness({
        report: {
          id: "r1",
          kind: "health_check",
          origin: "unknown",
          reasons: [
            {
              code: "items_missing",
              severity: "red",
              count: 5,
              ageHours: null,
              failure: {
                code: "verify.chunk_missing",
                category: "verify",
                transient: false,
                retryable: true,
                params: { count: 5 },
                technical: {},
                occurredAt: "2026-09-20T03:00:00.000Z",
                step: null,
                retry: null,
                steps: [{ id: "run_backup_again", target: "jobs" }],
                docsUrl: "https://docs.example.test/troubleshooting",
              },
            },
          ],
          counts: null,
        },
      }),
    ]);
    expect(explained).toMatch(/title="[^"]*data that is missing from the chunk index/);
    expect(explained).toContain(
      "5 items refer to data that is missing from the chunk index or from the storage.",
    );
  });

  describe("with servers and clients", () => {
    const mailboxes = [
      readiness({ object: object({ id: "a", displayName: "Ada Example" }), state: "green" }),
      readiness({
        object: object({ id: "b", displayName: "Bob Example" }),
        state: "red",
        readiness: "red",
      }),
    ];

    it("lists the machines in the same table, so the chips count what the banner counts", () => {
      const html = table(mailboxes, null, [
        machine({ displayName: "Web front" }),
        machine({
          id: "11111111-1111-4111-8111-bbbbbbbbbbbb",
          hostname: "laptop-7",
          profile: "client",
          os: "darwin",
          state: "unverified",
          readiness: null,
          checkedAt: null,
        }),
      ]);
      // Two mailboxes and two machines: four rows, four behind "All".
      expect(chipFigure(html, "all")).toBe("4");
      expect(count(html, "<tr")).toBe(1 + 4);
      expect(html).toContain("Ada Example");
      expect(html).toContain("Web front");
      expect(html).toContain("laptop-7");
    });

    it("names the type of each machine, with its system, where a mailbox shows its address", () => {
      const html = table([], null, [
        machine({ displayName: "Web front" }),
        machine({
          id: "11111111-1111-4111-8111-bbbbbbbbbbbb",
          hostname: "laptop-7",
          profile: "client",
          os: "darwin",
        }),
      ]);
      expect(html).toContain("Server · Linux");
      expect(html).toContain("Client · macOS");
      expect(html).toContain('aria-label="Server"');
      expect(html).toContain('aria-label="Client"');
    });

    it("links each machine to its page and offers no check for it", () => {
      const html = table([], null, [
        machine({ id: "11111111-1111-4111-8111-aaaaaaaaaaaa" }),
        machine({
          id: "11111111-1111-4111-8111-bbbbbbbbbbbb",
          hostname: "laptop-7",
          profile: "client",
        }),
      ]);
      expect(html).toContain('href="/inventory/11111111-1111-4111-8111-aaaaaaaaaaaa"');
      expect(html).toContain('href="/inventory/11111111-1111-4111-8111-bbbbbbbbbbbb"');
      expect(html).not.toContain("Check now");
    });

    it("rates a machine like every other object and counts it in the filters", () => {
      const html = table([readiness({ object: object({ id: "a" }), state: "green" })], null, [
        machine({ id: "m1", state: "red", readiness: "red" }),
        machine({
          id: "m2",
          hostname: "new-box",
          state: "no_backup",
          readiness: null,
          overdue: false,
          checkedAt: null,
          latestBackupAt: null,
        }),
        machine({
          id: "m3",
          hostname: "old-box",
          state: "no_backup",
          readiness: null,
          overdue: true,
          checkedAt: null,
          latestBackupAt: null,
        }),
      ]);
      expect(chipFigure(html, "all")).toBe("4");
      expect(chipFigure(html, "green")).toBe("1");
      expect(chipFigure(html, "red")).toBe("1");
      // Both machines without a backup, the one still waiting for it as well.
      expect(chipFigure(html, "no_backup")).toBe("2");
      expect(html).toContain("Not restorable");
      expect(html).toContain("Waiting for first backup");
      expect(html).toContain("No backup within 24 hours of protection starting.");
    });

    it("puts the worst first across mailboxes and machines", () => {
      const html = table(
        [readiness({ object: object({ id: "a", displayName: "Ada Example" }), state: "green" })],
        null,
        [machine({ hostname: "broken-box", state: "red", readiness: "red" })],
      );
      expect(html.indexOf("broken-box")).toBeGreaterThan(-1);
      expect(html.indexOf("broken-box")).toBeLessThan(html.indexOf("Ada Example"));
    });

    it("lists machines even when the tenant has no mailbox at all", () => {
      const html = table([], null, [machine()]);
      expect(chipFigure(html, "all")).toBe("1");
      expect(html).toContain("web-01");
      expect(html).not.toContain("No protected objects yet.");
    });

    it("keeps the empty text for a tenant with neither", () => {
      expect(table([], null, [])).toContain("No protected objects yet.");
    });
  });

  it("speaks German", async () => {
    await i18n.changeLanguage("de");
    const html = table([
      readiness({
        state: "no_backup",
        readiness: null,
        report: null,
        checkedAt: null,
        latestSnapshotAt: null,
        overdue: false,
      }),
    ]);
    expect(html).toContain("Wartet auf erste Sicherung");
    await i18n.changeLanguage("en");
  });
});
