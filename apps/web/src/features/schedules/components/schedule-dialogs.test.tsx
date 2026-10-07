import { beforeAll, describe, expect, it, vi } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { ScheduleItem } from "../api.js";
import "../i18n.js";
import { DeleteScheduleDialog, DisableScheduleDialog } from "./schedule-dialogs.js";

// Server rendering has no document to portal into; the dialog renders in place.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal } };
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const backup: ScheduleItem = {
  id: "schedule-1",
  kind: "backup",
  protectedObject: null,
  intervalMinutes: 480,
  cron: null,
  timezone: "Europe/Berlin",
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastJob: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
};

const noop = async () => {};

describe("DeleteScheduleDialog", () => {
  it("asks in an alert dialog which schedule goes, with a destructive confirm", () => {
    const html = render(
      <DeleteScheduleDialog schedule={backup} onCancel={() => {}} onConfirm={noop} />,
    );
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Delete this schedule?");
    expect(html).toContain("Backup · Every 8 hours · All protected objects");
    expect(html).toMatch(
      /<button[^>]*data-variant="destructive"[^>]*>(?:(?!<\/button>).)*Delete schedule/,
    );
  });

  it("stays closed without a schedule", () => {
    const html = render(
      <DeleteScheduleDialog schedule={null} onCancel={() => {}} onConfirm={noop} />,
    );
    expect(html).not.toContain("alertdialog");
  });
});

describe("DisableScheduleDialog", () => {
  it("explains what switching off backups or verification means", () => {
    const backupHtml = render(
      <DisableScheduleDialog schedule={backup} onCancel={() => {}} onConfirm={noop} />,
    );
    expect(backupHtml).toContain("Switch off automatic backups?");
    expect(backupHtml).toContain("backed up only when someone starts a backup by hand");

    const verifyHtml = render(
      <DisableScheduleDialog
        schedule={{ ...backup, kind: "verify", intervalMinutes: null, cron: "0 3 * * 0" }}
        onCancel={() => {}}
        onConfirm={noop}
      />,
    );
    expect(verifyHtml).toContain("Switch off the restore check?");
    expect(verifyHtml).toContain("recovery readiness is no longer proven");
  });
});
