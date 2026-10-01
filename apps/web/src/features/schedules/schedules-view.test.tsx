import { beforeAll, describe, expect, it, vi } from "vitest";

import { count, render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type { ScheduleItem, ScheduleList } from "./api.js";
import "./i18n.js";
import { SchedulesView, type SchedulesViewProps } from "./schedules-view.js";

// Server rendering has no router or document to portal into: links render as
// plain anchors and dialogs in place. Everything else is the production path.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const Link = ({ to, children, ...rest }: { to: string; children?: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  );
  return { ...actual, Link };
});
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal } };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

function item(overrides: Partial<ScheduleItem> = {}): ScheduleItem {
  return {
    id: crypto.randomUUID(),
    kind: "backup",
    protectedObject: null,
    intervalMinutes: 480,
    cron: null,
    timezone: "Europe/Berlin",
    enabled: true,
    nextRunAt: "2026-03-01T18:00:00.000Z",
    lastRunAt: "2026-03-01T10:00:00.000Z",
    lastJob: { id: "job-1", status: "completed", finishedAt: "2026-03-01T10:20:00.000Z" },
    createdAt: "2026-02-01T00:00:00.000Z",
    updatedAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

const covered: ScheduleList = {
  items: [
    item(),
    item({ kind: "verify", intervalMinutes: null, cron: "0 3 * * 0", lastJob: null }),
    item({ kind: "retention", intervalMinutes: null, cron: "30 4 * * *", lastJob: null }),
  ],
  missingKinds: [],
};

function view(props: Partial<SchedulesViewProps> = {}): string {
  const noop = () => {};
  return render(
    <SchedulesView
      hasTenant
      list={covered}
      loading={false}
      fetching={false}
      error={null}
      onRetry={noop}
      canManage
      onCreate={noop}
      onEdit={noop}
      onDelete={noop}
      onToggle={noop}
      onApplyRecommended={noop}
      applying={false}
      pendingId={null}
      {...props}
    />,
  );
}

describe("SchedulesView", () => {
  it("shows skeleton rows while the first load runs", () => {
    const html = view({ list: undefined, loading: true });
    expect(html).toContain('data-slot="skeleton"');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("No schedules yet");
  });

  it("offers the recommended set when the tenant has no schedule", () => {
    const html = view({ list: { items: [], missingKinds: ["backup", "verify"] } });
    expect(html).toContain('data-slot="empty-state"');
    expect(html).toContain("No schedules yet");
    expect(html).toContain("Apply recommended schedules");
    expect(html).not.toContain("<table");
  });

  it("shows the cause and a retry when loading failed", () => {
    const html = view({ list: undefined, error: new ApiError(500, null, "boom") });
    expect(html).toContain("The schedules could not be loaded");
    expect(html).toContain("The server reported an internal error.");
    expect(html).toContain("Retry");
  });

  it("lists schedules with their cadence, next run and last job", () => {
    const html = view();
    expect(html).toContain("Every 8 hours");
    expect(html).toContain("Every Sunday at");
    expect(html).toContain("<time");
    expect(html).toContain('href="/history/job-1"');
    expect(html).toContain("Completed");
    // Retention keeps everything until a policy exists: said plainly.
    expect(html).toContain("Until a policy exists, everything is kept.");
    expect(html).not.toContain('data-notice="backup"');
    expect(html).toContain("New schedule");
  });

  it("warns that backups run only by hand and offers the recommended set", () => {
    const html = view({
      list: { items: [covered.items[1] as ScheduleItem], missingKinds: ["backup", "scrub"] },
    });
    expect(html).toContain('data-notice="backup"');
    expect(html).toContain("Backups run only when started by hand");
    expect(count(html, "Apply recommended schedules")).toBe(1);
  });

  it("offers to switch a paused backup or verify schedule back on", () => {
    const html = view({
      list: {
        items: [
          item({ enabled: false }),
          item({ kind: "verify", enabled: false, cron: "0 3 * * 0", intervalMinutes: null }),
        ],
        missingKinds: [],
      },
    });
    expect(html).toContain("The backup schedule for all protected objects is switched off.");
    expect(html).toContain("Backups stay unverified");
    expect(count(html, ">Switch on<")).toBe(2);
    expect(html).toContain("Switched off");
  });

  it("is read-only for tenant users", () => {
    const html = view({ canManage: false });
    expect(html).toContain("Only tenant administrators can change them.");
    expect(html).not.toContain("New schedule");
    expect(html).not.toContain("Actions for");
    // Every switch is shown, none can be flipped.
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
    expect(switches).toHaveLength(3);
    for (const tag of switches) {
      expect(tag).toContain("disabled");
    }
  });

  it("shows tenant users the last outcome without a link to the job", () => {
    const html = view({
      canManage: false,
      list: {
        items: [
          item({
            protectedObject: { id: null, name: null, kind: "mailbox" },
            lastJob: { id: null, status: "failed", finishedAt: "2026-03-01T10:20:00.000Z" },
          }),
        ],
        missingKinds: [],
      },
    });
    expect(html).toContain("Failed");
    expect(html).toContain("One mailbox (not yours)");
    expect(html).not.toContain('href="/history/');
    expect(html).not.toContain("Open the last job");
  });

  it("asks for a tenant first", () => {
    const html = view({ hasTenant: false, list: undefined });
    expect(html).toContain("No tenant selected");
    expect(html).not.toContain("<table");
  });
});
