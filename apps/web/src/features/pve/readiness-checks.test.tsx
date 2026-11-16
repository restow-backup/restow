import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GuestReadinessRow } from "@/features/verify/api";
import { i18n } from "@/i18n";

import "./i18n";
import {
  GuestChecksCallout,
  PveChecksFooter,
  pveChecksLine,
  uncheckedGuests,
} from "./readiness-checks";
import {
  checkOverdueText,
  checkWaitsForText,
  GuestReadinessRowView,
  guestResultKey,
} from "./readiness-row";

vi.mock("@/features/endpoints/hooks", () => ({
  useTenantScope: () => ({ tenantId: "t-1", enabled: true }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <a href="/x">{children}</a>,
  };
});

/** Proxmox VE in Recovery readiness: "Check now", "Check all unverified", the guests' schedule. */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const row = (over: Partial<GuestReadinessRow> = {}): GuestReadinessRow => ({
  id: "g-1",
  vmid: 101,
  kind: "vm",
  name: "web",
  node: "pve1",
  state: "unverified",
  readiness: null,
  checkedAt: null,
  overdue: false,
  latestBackupAt: "2026-10-20T22:00:00Z",
  latestSnapshotId: "s-1",
  inJob: true,
  ...over,
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <table>
          <tbody>{node}</tbody>
        </table>
      </I18nextProvider>
    </QueryClientProvider>,
  );

describe("a guest in Recovery readiness", () => {
  it("offers Check now, and says when its check is already queued (D2)", () => {
    expect(render(<GuestReadinessRowView row={row()} />)).toContain("Check now");
    const waiting = render(<GuestReadinessRowView row={row({ checkRequested: true })} />);
    expect(waiting).toContain("Check queued");
    expect(waiting).toContain("disabled");
    expect(render(<GuestReadinessRowView row={row({ latestSnapshotId: null })} />)).not.toContain(
      "Check now",
    );
  });

  it("names the real error of a red check, not only the rule (B2)", () => {
    const html = render(
      <GuestReadinessRowView
        row={row({ state: "red", readiness: "red", verifyErrors: ["repository does not exist"] })}
      />,
    );
    expect(html).toContain('data-slot="guest-readiness-error"');
    expect(html).toContain("repository does not exist");
  });

  it("says a check that could not run is no finding, with who held the lock (0.4.3)", () => {
    const html = render(
      <GuestReadinessRowView
        row={row({
          kind: "ct",
          state: "yellow",
          readiness: "yellow",
          basis: "verify",
          verifyNotChecked: {
            reason: "locked",
            detail: "repository is already locked by PID 4711 on host pve1",
          },
        })}
      />,
    );
    expect(html).toContain("could not run for two hours");
    expect(html).toContain('data-slot="guest-readiness-not-checked"');
    expect(html).toContain("PID 4711 on host pve1");
    expect(html).not.toContain('data-slot="guest-readiness-error"');
    expect(html).not.toContain("failed");
    expect(
      guestResultKey({
        state: "yellow",
        overdue: false,
        basis: "verify",
        verifyNotChecked: { reason: "interrupted", detail: "" },
      }),
    ).toBe("readiness.result.notCheckedInterrupted");
  });

  it("says when a queued check waits far longer than expected, and why when it is known (0.5.0)", () => {
    const stalled = render(
      <GuestReadinessRowView
        row={row({ checkRequested: true, checkOverdue: true, checkBlockedBy: null })}
      />,
    );
    expect(stalled).toContain('data-slot="guest-readiness-overdue"');
    expect(stalled).toContain("Check overdue");
    expect(stalled).not.toContain('data-slot="guest-readiness-waiting"');
    const t = i18n.getFixedT("en", "pve") as unknown as TFunction;
    expect(checkOverdueText(t, { checkBlockedBy: null }, "en")).toContain("has not got to it");
    const blocked = checkOverdueText(
      t,
      { checkBlockedBy: { kind: "restore", since: "2026-11-03T02:35:00Z" } },
      "en",
    );
    expect(blocked).toContain("Restore since");
    expect(blocked).toContain("2026");
    expect(blocked).toContain("no sign of life");
    // Behind a run that is going: a neutral note on the plain "queued", no warning.
    expect(
      checkWaitsForText(
        t,
        { checkWaitsFor: { kind: "backup", since: "2026-11-04T14:00:00Z" } },
        "en",
      ),
    ).toContain("Backup since");
    expect(checkWaitsForText(t, { checkWaitsFor: null }, "en")).toBeNull();
    const behindBackup = render(
      <GuestReadinessRowView
        row={row({
          checkRequested: true,
          checkOverdue: false,
          checkWaitsFor: { kind: "backup", since: "2026-11-04T14:00:00Z" },
        })}
      />,
    );
    expect(behindBackup).toContain('data-slot="guest-readiness-waiting"');
    expect(behindBackup).not.toContain('data-slot="guest-readiness-overdue"');
    // Not overdue yet: the plain "queued".
    expect(render(<GuestReadinessRowView row={row({ checkRequested: true })} />)).toContain(
      'data-slot="guest-readiness-waiting"',
    );
    // The summary no longer promises the next pass for checks that are overdue.
    const callout = render(
      <GuestChecksCallout
        guests={[
          row({ checkRequested: true, checkOverdue: true }),
          row({ id: "g-2", checkRequested: true }),
        ]}
      />,
    );
    expect(callout).toContain('data-slot="pve-readiness-overdue"');
    expect(callout).not.toContain("for the next pass");
    expect(render(<GuestChecksCallout guests={[row({ checkRequested: true })]} />)).toContain(
      "for the next pass",
    );
  });

  it("names a check that could not start (0.5.0)", () => {
    expect(
      guestResultKey({
        state: "yellow",
        overdue: false,
        basis: "verify",
        verifyNotChecked: { reason: "error", detail: "" },
      }),
    ).toBe("readiness.result.notCheckedError");
    expect(i18n.getFixedT("en", "pve")("readiness.result.notCheckedError")).toContain(
      "could not start",
    );
    expect(i18n.getFixedT("de", "pve")("readiness.result.notCheckedError")).toContain(
      "nicht starten",
    );
  });

  it("counts the guests that wait for no check", () => {
    expect(
      uncheckedGuests([
        row(),
        row({ id: "g-2", checkRequested: true }),
        row({ id: "g-3", state: "green" }),
        // Its check could not run: unverified as well, "Check all unverified" takes it.
        row({
          id: "g-4",
          state: "yellow",
          basis: "verify",
          verifyNotChecked: { reason: "locked", detail: "" },
        }),
        // Yellow from a boot test is a finding, not an unchecked guest.
        row({ id: "g-5", state: "yellow", basis: "boot_test" }),
      ]).map((r) => r.id),
    ).toEqual(["g-1", "g-4"]);
  });
});

describe("the guests' line under the table (D3)", () => {
  it("says how VMs and containers are checked, apart from the Microsoft 365 schedule", () => {
    const t = i18n.getFixedT("en", "pve") as unknown as TFunction;
    expect(pveChecksLine(t, { afterBackup: true, periodicDays: 7, waiting: 0 })).toContain(
      "within minutes of its backup",
    );
    expect(pveChecksLine(t, { afterBackup: false, periodicDays: 7, waiting: 0 })).toContain(
      "every 7 days",
    );
    expect(render(<PveChecksFooter checks={null} />)).not.toContain("VMs and containers");
  });
});
