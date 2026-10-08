// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { json, routedFetch } from "@/features/updates/testing";
import { i18n } from "@/i18n";
import { ApiError } from "@/lib/api";

import type { EndpointDetail, EndpointHooks } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { SettingsTab } from "./settings-tab.js";

// The "Confirm it is you" step-up (components/confirm-identity-dialog.tsx) with a passkey.
const auth = vi.hoisted(() => ({
  passkey: vi.fn(),
  getSession: vi.fn(),
  listUserPasskeys: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    signIn: { passkey: auth.passkey },
    getSession: auth.getSession,
    passkey: { listUserPasskeys: auth.listUserPasskeys },
  },
  browserSupportsPasskeys: () => true,
}));
vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    user: { id: "u1" },
    activeTenant: { id: "t-1", name: "Contoso" },
    refresh: auth.refresh,
    signOut: async () => undefined,
  }),
}));
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return {
    ...actual,
    Dialog: { ...actual.Dialog, Portal: InPlacePortal },
    AlertDialog: { ...actual.AlertDialog, Portal: InPlacePortal },
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
      <a href={String(to)} {...props}>
        {children}
      </a>
    ),
  };
});

const updateEndpoint = vi.fn();
const revokeEndpoint = vi.fn();
const uninstallEndpoint = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    updateEndpoint: (...args: unknown[]) => updateEndpoint(...args),
    revokeEndpoint: (...args: unknown[]) => revokeEndpoint(...args),
    uninstallEndpoint: (...args: unknown[]) => uninstallEndpoint(...args),
  };
});

const ID = "11111111-1111-4111-8111-111111111111";

function hooks(policy: EndpointHooks["policy"], over: Partial<EndpointHooks> = {}): EndpointHooks {
  return {
    policy,
    scripts: [],
    visible: true,
    pre: { set: false, fingerprint: null },
    post: { set: false, fingerprint: null },
    ...over,
  };
}

function detail(over: Partial<EndpointDetail> = {}): EndpointDetail {
  return {
    id: ID,
    hostname: "web-01",
    displayName: "Web front",
    os: "linux",
    arch: "amd64",
    profile: "server",
    status: "active",
    tasks: [],
    config: {
      profile: "server",
      schedule: { kind: "daily", timeOfDay: "22:00", timeZone: "Europe/Berlin" },
      paths: ["/etc", "/home"],
      excludes: ["*.tmp"],
      hooks: {},
      bandwidthKbps: null,
      onlyOnAcPower: false,
      useVss: false,
    },
    configVersion: 3,
    agentConfigVersion: 3,
    settings: {
      retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
      staleAfterHours: 2,
      staleAfterDays: 7,
      quotaGib: null,
    },
    storage: {
      usedBytes: 5_000_000,
      measuredAt: "2026-09-30T03:00:00.000Z",
      budgetBytes: 2 * 1024 ** 4,
      ownBudget: false,
      defaultBudgetBytes: 2 * 1024 ** 4,
      tenantUsedBytes: 9_000_000,
      tenantBudgetBytes: 20 * 1024 ** 4,
      level: "ok" as const,
      refusedAt: null,
    },
    hooks: hooks("any"),
    autoUpdatePaused: false,
    autoUpdateOwnPause: false,
    ...over,
  } as EndpointDetail;
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("SettingsTab", () => {
  let page: Mounted;

  beforeEach(() => {
    updateEndpoint.mockReset();
    updateEndpoint.mockResolvedValue({ configVersion: 4, changed: ["config.excludes"] });
    revokeEndpoint.mockReset();
    revokeEndpoint.mockResolvedValue(undefined);
    uninstallEndpoint.mockReset();
    uninstallEndpoint.mockResolvedValue({ alreadyQueued: false, task: {} });
  });
  afterEach(() => page?.unmount());

  async function open(over: Partial<EndpointDetail> = {}) {
    page = mount();
    await page.render(<SettingsTab detail={detail(over)} />);
    await page.settle();
  }

  const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const save = () => page.byText("button", "Save changes") as HTMLButtonElement;

  it("shows what the server holds and keeps Save off while nothing changed", async () => {
    await open();
    expect(field<HTMLInputElement>("settings-name").value).toBe("Web front");
    expect(field<HTMLTextAreaElement>("settings-excludes").value).toBe("*.tmp");
    expect(field<HTMLInputElement>("settings-time").value).toBe("22:00");
    expect(field<HTMLInputElement>("settings-keepDaily").value).toBe("30");
    expect(document.querySelectorAll('input[aria-label^="Folder "]')).toHaveLength(2);
    expect(save().disabled).toBe(true);
    expect(page.text()).toContain("No changes");
    expect(page.text()).toContain("daily at 22:00");
  });

  it("warns that hooks run as root and that a failing pre hook fails the backup", async () => {
    await open();
    const warning = document.querySelector('[data-slot="hooks-warning"]');
    expect(warning?.textContent).toContain("as root (administrator)");
    expect(warning?.textContent).toContain("backup fails too");
    expect(warning?.textContent).toContain("fingerprint");
  });

  it("saves only the part that changed", async () => {
    await open();
    await page.type(field<HTMLTextAreaElement>("settings-excludes"), "*.tmp\nnode_modules");
    expect(save().disabled).toBe(false);
    expect(page.text()).toContain("Unsaved changes");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledTimes(1);
    expect(updateEndpoint).toHaveBeenCalledWith(ID, {
      config: { excludes: ["*.tmp", "node_modules"] },
    });
  });

  it("builds one patch across name, limit, switch, retention and alert", async () => {
    await open();
    await page.type(field<HTMLInputElement>("settings-name"), "Front");
    await page.type(field<HTMLInputElement>("settings-bandwidth"), "2048");
    await page.click(field<HTMLButtonElement>("settings-ac"));
    await page.type(field<HTMLInputElement>("settings-keepDaily"), "14");
    await page.type(field<HTMLInputElement>("settings-stale-hours"), "6");
    await page.click(save());
    await page.settle();
    // Keeping fewer restore points removes some for good: it asks first and says how many.
    expect(updateEndpoint).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("16 daily restore points");
    const confirm = [...(dialog?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent?.trim() === "Shorten and save",
    );
    await page.click(confirm as HTMLButtonElement);
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, {
      displayName: "Front",
      config: { bandwidthKbps: 2048, onlyOnAcPower: true },
      settings: {
        retention: { keepDaily: 14, keepWeekly: 12, keepMonthly: 12 },
        staleAfterHours: 6,
      },
    });
  });

  it("gives the machine a storage budget of its own and returns it to the default", async () => {
    await open();
    expect(page.text()).toContain("Leave empty for the installation's default of 2 TB");
    expect(page.text()).toContain("share a budget of 20 TB");
    await page.type(field<HTMLInputElement>("settings-quota"), "3000");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenLastCalledWith(ID, { settings: { quotaGib: 3000 } });

    page.unmount();
    await open({
      settings: {
        retention: { keepDaily: 30, keepWeekly: 12, keepMonthly: 12 },
        staleAfterHours: 2,
        staleAfterDays: 7,
        quotaGib: 3000,
      },
    });
    expect(field<HTMLInputElement>("settings-quota").value).toBe("3000");
    await page.type(field<HTMLInputElement>("settings-quota"), "");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenLastCalledWith(ID, { settings: { quotaGib: null } });
  });

  it("sends both hooks when one is set", async () => {
    await open();
    await page.type(
      field<HTMLTextAreaElement>("settings-pre-hook"),
      "pg_dumpall > /var/backups/db.sql",
    );
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, {
      config: { hooks: { pre: "pg_dumpall > /var/backups/db.sql" } },
    });
  });

  it("asks an older session to confirm it is them before a hook is saved, then saves it", async () => {
    auth.passkey.mockResolvedValue({ data: {}, error: null });
    auth.getSession.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    auth.listUserPasskeys.mockResolvedValue({ data: [{ id: "p1" }], error: null });
    auth.refresh.mockResolvedValue(undefined);
    vi.stubGlobal(
      "fetch",
      routedFetch({
        "GET /setup/state": () =>
          json({
            passkeyReady: { ready: true, reasons: [], rpId: null, origin: null },
            demo: { enabled: false, email: null, password: null },
          }),
      }).mock,
    );
    try {
      updateEndpoint.mockRejectedValueOnce(
        new ApiError(
          403,
          {
            type: "urn:restow:problem:recent-sign-in-required",
            title: "Confirm it is you",
            status: 403,
          },
          "Confirm it is you",
        ),
      );
      updateEndpoint.mockResolvedValueOnce({ configVersion: 4, changed: ["config.hooks"] });
      await open();
      expect(document.querySelector('[data-slot="hooks-step-up"]')?.textContent).toContain(
        "confirm it is you",
      );
      await page.type(field<HTMLTextAreaElement>("settings-pre-hook"), "pg_dumpall > /srv/db.sql");
      await page.click(save());
      await page.settle();
      expect(updateEndpoint).toHaveBeenCalledTimes(1);
      expect(page.text()).toContain("Confirm it is you first");
      expect(document.querySelector('[data-slot="confirm-identity"]')).not.toBeNull();
      await page.settle();
      await page.click(page.byText("button", "Confirm with passkey"));
      await page.settle();
      await page.settle();
      expect(auth.passkey).toHaveBeenCalledTimes(1);
      // The same change is sent again with the fresh session.
      expect(updateEndpoint).toHaveBeenCalledTimes(2);
      expect(updateEndpoint).toHaveBeenLastCalledWith(ID, {
        config: { hooks: { pre: "pg_dumpall > /srv/db.sql" } },
      });
      expect(document.querySelector('[data-slot="confirm-identity"]')).toBeNull();
      expect(page.text()).not.toContain("Confirm it is you first");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("locks the hook fields while the machine does not allow hooks, and says how to allow them", async () => {
    await open({ hooks: hooks("off") });
    expect(field<HTMLTextAreaElement>("settings-pre-hook").disabled).toBe(true);
    expect(field<HTMLTextAreaElement>("settings-post-hook").disabled).toBe(true);
    const policy = document.querySelector('[data-slot="hooks-policy"]');
    expect(policy?.textContent).toContain("Hooks are switched off on this machine");
    expect(policy?.textContent).toContain("sudo restow-agent hooks scripts");
    expect(document.querySelector('[data-slot="hooks-warning"]')).toBeNull();
  });

  it("names the agent at its installed location when the commands are known", async () => {
    await open({
      hooks: hooks("off"),
      commands: {
        uninstallScript:
          "curl -fsSL 'https://restow.example/install/macos.sh' | sudo sh -s -- --uninstall",
        uninstallAgent: "sudo '/Library/Application Support/Restow/bin/restow-agent' uninstall",
        hooksScripts: "sudo '/Library/Application Support/Restow/bin/restow-agent' hooks scripts",
        hooksAny: "sudo '/Library/Application Support/Restow/bin/restow-agent' hooks any",
      },
    });
    const policy = document.querySelector('[data-slot="hooks-policy"]');
    expect(policy?.textContent).toContain(
      "sudo '/Library/Application Support/Restow/bin/restow-agent' hooks scripts",
    );
    expect(policy?.textContent).toContain(
      "sudo '/Library/Application Support/Restow/bin/restow-agent' hooks any",
    );
  });

  it("offers to remove hooks the machine skips", async () => {
    updateEndpoint.mockResolvedValue({ configVersion: 4, changed: ["config.hooks"] });
    const config = detail().config;
    await open({
      hooks: hooks(null, { pre: { set: true, fingerprint: "0123456789abcdef" } }),
      config: { ...config, hooks: { pre: "pg_dumpall > /srv/db.sql" } },
    });
    expect(page.text()).toContain("has not said whether it allows hooks");
    expect(page.text()).toContain("The commands below are not run");
    await page.click(page.byText("button", "Remove the commands"));
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, { config: { hooks: {} } });
  });

  it("takes script names, not commands, from a machine that only runs its own scripts", async () => {
    await open({ hooks: hooks("scripts", { scripts: ["db-dump", "fsfreeze"] }) });
    expect(page.text()).toContain("Scripts on the machine: db-dump, fsfreeze");
    const pre = field<HTMLInputElement>("settings-pre-hook");
    expect(pre.tagName).toBe("INPUT");
    await page.type(pre, "pg_dumpall > /srv/db.sql");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).not.toHaveBeenCalled();
    expect(page.text()).toContain("Enter the name of a script");
    await page.type(pre, "db-dump");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, { config: { hooks: { pre: "db-dump" } } });
  });

  it("shows a set hook only by its fingerprint to who may not change it", async () => {
    await open({
      hooks: hooks("any", { visible: false, pre: { set: true, fingerprint: "0123456789abcdef" } }),
    });
    expect(field("settings-pre-hook")).toBeNull();
    expect(page.text()).toContain("A command is set (fingerprint 0123456789abcdef)");
  });

  it("does not send a form the API would refuse, and marks the field", async () => {
    await open();
    await page.type(
      document.querySelector('input[aria-label="Folder 1"]') as HTMLInputElement,
      "etc",
    );
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).not.toHaveBeenCalled();
    expect(page.text()).toContain("Not an absolute path: etc");
    expect(page.text()).toContain("Fix the marked fields before saving.");
  });

  it("adds and removes folders", async () => {
    await open();
    await page.click(page.byText("button", "Add a folder"));
    expect(document.querySelectorAll('input[aria-label^="Folder "]')).toHaveLength(3);
    await page.type(
      document.querySelector('input[aria-label="Folder 3"]') as HTMLInputElement,
      "/srv",
    );
    await page.click(document.querySelector('button[aria-label="Remove /etc"]') as HTMLElement);
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, { config: { paths: ["/home", "/srv"] } });
  });

  it("discards unsaved edits", async () => {
    await open();
    await page.type(field<HTMLTextAreaElement>("settings-excludes"), "changed");
    await page.click(page.byText("button", "Discard changes"));
    expect(field<HTMLTextAreaElement>("settings-excludes").value).toBe("*.tmp");
    expect(save().disabled).toBe(true);
  });

  it("shows the alert threshold of a client in days, and its on-connect schedule", async () => {
    await open({
      profile: "client",
      config: {
        profile: "client",
        schedule: { kind: "on_connect", intervalMinutes: 240, timeZone: "Europe/Berlin" },
        paths: ["/Users"],
        excludes: [],
        hooks: {},
        bandwidthKbps: null,
        onlyOnAcPower: true,
        useVss: false,
      },
    });
    expect(field("settings-stale-days")).not.toBeNull();
    expect(field("settings-stale-hours")).toBeNull();
    expect(field<HTMLInputElement>("settings-interval").value).toBe("240");
    expect(field("settings-time")).toBeNull();
    expect(page.text()).toContain("At most once every … minutes");
  });

  it("offers time windows of the limit, reads them in the time zone of the schedule and saves them", async () => {
    await open();
    const windows = document.querySelector('[data-slot="bandwidth-windows"]') as HTMLElement;
    expect(windows).not.toBeNull();
    expect(windows.textContent).toContain(
      "Times are read in Europe/Berlin, the time zone of the schedule.",
    );
    expect(windows.textContent).toContain("The limit that applies when a run starts");
    expect(windows.textContent).toContain("No time windows: the limit above applies at all times.");
    await page.click(page.byText("button", "Add time window"));
    const row = document.querySelector('[data-slot="bandwidth-window"]') as HTMLElement;
    expect(row).not.toBeNull();
    // The limit is required before the window can be saved, 0 being unlimited.
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).not.toHaveBeenCalled();
    expect(page.text()).toContain("Enter a limit; 0 means unlimited.");
    const limit = row.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
    await page.type(limit as HTMLInputElement, "0");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledTimes(1);
    expect(updateEndpoint).toHaveBeenCalledWith(ID, {
      config: {
        bandwidthWindows: [{ days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", kbps: 0 }],
      },
    });
  });

  it("shows the windows a machine has, and takes them away with null", async () => {
    await open({
      config: {
        ...detail().config,
        bandwidthKbps: 500,
        bandwidthWindows: [{ days: [6, 7], from: "00:00", to: "00:00", kbps: 8000 }],
      },
    });
    const rows = document.querySelectorAll('[data-slot="bandwidth-window"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('[data-slot="window-summary"]')?.textContent).toBe(
      "Sat, Sun, 24 hours from 00:00: 8000 kbit/s",
    );
    expect(save().disabled).toBe(true);
    await page.click(document.querySelector('[aria-label="Remove window 1"]') as HTMLElement);
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, { config: { bandwidthWindows: null } });
  });

  it("shows what a backup job owns as read only, with the way to the job, and leaves the rest open", async () => {
    await open({ job: { id: "job-1", name: "Linux servers, daily" } });
    const note = document.querySelector('[data-slot="managed-by-job"]');
    expect(note?.textContent).toContain("This machine is managed by the job Linux servers, daily");
    expect(note?.textContent).toContain("come from the job and are shown here read-only");
    expect(note?.querySelector("a")?.getAttribute("href")).toBe("/jobs/definitions/job-1");
    const closed = (id: string) => field(id).closest("fieldset[disabled]") !== null;
    // The folders, exclusions, schedule, hooks and bandwidth belong to the job.
    for (const id of [
      "settings-excludes",
      "settings-schedule-kind",
      "settings-time",
      "settings-zone",
      "settings-bandwidth",
      "settings-ac",
      "settings-pre-hook",
      "settings-post-hook",
    ]) {
      expect(closed(id), id).toBe(true);
    }
    expect(
      document.querySelector('input[aria-label^="Folder "]')?.closest("fieldset[disabled]"),
    ).not.toBeNull();
    // So do the time windows of the limit: they come from the job as well.
    expect(
      document
        .querySelector('[data-slot="bandwidth-windows"] button')
        ?.closest("fieldset[disabled]"),
    ).not.toBeNull();
    // The name, the retention, the alerts and the quota stay the machine's own.
    for (const id of [
      "settings-name",
      "settings-keepDaily",
      "settings-stale-hours",
      "settings-quota",
    ]) {
      expect(closed(id), id).toBe(false);
    }
  });

  it("sends no configuration when a machine in a job changes its name", async () => {
    await open({ job: { id: "job-1", name: "Linux servers, daily" } });
    await page.type(field<HTMLInputElement>("settings-name"), "Front");
    await page.click(save());
    await page.settle();
    expect(updateEndpoint).toHaveBeenCalledWith(ID, { displayName: "Front" });
  });

  it("says nothing about a job for a machine that is in none", async () => {
    await open({ job: null });
    expect(document.querySelector('[data-slot="managed-by-job"]')).toBeNull();
    expect(document.querySelector("fieldset[disabled]")).toBeNull();
  });

  it("shows a machine in no job as without backup instead of a schedule it cannot have", async () => {
    await open({ job: null });
    const notice = document.querySelector('[data-slot="without-backup-notice"]');
    expect(notice?.textContent).toContain("This machine is not backed up");
    // The schedule comes from a job only; its fields are not offered.
    expect(document.getElementById("settings-schedule-kind")).toBeNull();
    expect(document.getElementById("settings-time")).toBeNull();
    // The folders stay the machine's own (a job may start from them).
    expect(page.text()).toContain("Folders to back up");
  });

  it("locks the form for a revoked machine", async () => {
    await open({ status: "revoked" });
    expect(page.text()).toContain("This machine is revoked");
    expect(field<HTMLInputElement>("settings-name").disabled).toBe(true);
    expect(save().disabled).toBe(true);
    expect((page.byText("button", "Revoke machine") as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks for the host name before it revokes", async () => {
    await open();
    await page.click(page.byText("button", "Revoke machine"));
    expect(page.text()).toContain("This cannot be undone");
    const confirm = page.byText(
      '[role="alertdialog"] button[type="submit"]',
      "Revoke machine",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await page.type(
      document.querySelector('[role="alertdialog"] input') as HTMLInputElement,
      "web-01",
    );
    expect(confirm.disabled).toBe(false);
    await page.click(confirm);
    await page.settle();
    expect(revokeEndpoint).toHaveBeenCalledWith(ID);
  });

  it("explains the uninstall before it queues it", async () => {
    await open();
    await page.click(page.byText("button", "Uninstall agent"));
    expect(page.text()).toContain("removes itself from the machine with its next contact");
    expect(page.text()).toContain("Backups that exist stay restorable");
    await page.click(page.byText('[role="alertdialog"] button[type="submit"]', "Uninstall agent"));
    await page.settle();
    expect(uninstallEndpoint).toHaveBeenCalledWith(ID);
  });

  it("does not offer a second uninstall while one waits for the machine", async () => {
    await open({
      tasks: [
        {
          id: "t",
          kind: "uninstall",
          status: "pending",
          params: {},
          createdAt: "2026-09-30T10:00:00.000Z",
          deliveredAt: null,
          finishedAt: null,
          errorMessage: null,
          checkIncomplete: false,
        },
      ],
    });
    expect(page.text()).toContain("The uninstall is waiting for the machine.");
    expect((page.byText("button", "Uninstall agent") as HTMLButtonElement).disabled).toBe(true);
  });
});
