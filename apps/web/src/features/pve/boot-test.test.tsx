import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveBootTest } from "./api";
import {
  BootTestBadge,
  BootTestFacts,
  bootTestDetailKey,
  bootTestLeftover,
  bootTestVariant,
} from "./boot-test";
import { BootTestLeftoverNotice } from "./guest-page";
import { guestResultKey } from "./readiness-row";
import { runTone } from "./run-status";

/** Boot tests on the guest page and in readiness: green only when the guest agent answered. */

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const test = (over: Partial<PveBootTest> = {}): PveBootTest => ({
  outcome: "green",
  reason: "agent_answered",
  message: "The restored VM booted.",
  checkedAt: new Date(Date.now() - 3600_000).toISOString(),
  durationMs: 90_000,
  bootSeconds: 41.6,
  guestAgent: true,
  tempVmid: 9001,
  storage: "local-lvm",
  cleanedUp: true,
  ...over,
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("the tone of a boot test", () => {
  it("is green only for an answer, amber for a start without one, red for a failure", () => {
    expect(bootTestVariant("green")).toBe("success");
    expect(bootTestVariant("yellow")).toBe("warning");
    expect(bootTestVariant("red")).toBe("destructive");
    expect(bootTestVariant("skipped")).toBe("muted");
    expect(bootTestVariant("error")).toBe("muted");
  });

  it("explains what proved it, or why there is no proof", () => {
    expect(bootTestDetailKey(test(), "vm")).toBe("guest.bootTestDetail.green");
    expect(bootTestDetailKey(test({ guestAgent: false }), "ct")).toBe(
      "guest.bootTestDetail.greenContainer",
    );
    expect(bootTestDetailKey(test({ outcome: "yellow", guestAgent: false }), "vm")).toBe(
      "guest.bootTestDetail.yellow",
    );
    expect(bootTestDetailKey(test({ outcome: "skipped" }), "vm")).toBeNull();
  });
});

describe("BootTestBadge", () => {
  it("names the outcome; the proof opens on hover, copyable", () => {
    const html = render(<BootTestBadge test={test()} kind="vm" />);
    expect(html).toContain("Booted");
    expect(html).toContain('data-variant="success"');
    expect(html).toContain('data-slot="hover-card-trigger"');
    // No browser tooltip: it can be neither styled nor copied.
    expect(html).not.toContain("title=");
  });

  it("shows the node's message under a red badge", () => {
    const html = render(
      <BootTestBadge
        test={test({
          outcome: "red",
          reason: "restore_failed",
          message: "TASK ERROR: unable to restore CT 122",
        })}
        kind="ct"
      />,
    );
    expect(html).toContain("Did not boot");
    expect(html).toContain('data-slot="pve-boot-test-message"');
    expect(html).toContain("TASK ERROR: unable to restore CT 122");
  });

  it("tells a VM without a guest agent apart, and an untested restore point", () => {
    const yellow = render(
      <BootTestBadge test={test({ outcome: "yellow", guestAgent: false })} kind="vm" />,
    );
    expect(yellow).toContain("Started, no answer");
    expect(yellow).toContain('data-variant="warning"');
    expect(render(<BootTestBadge test={null} kind="vm" />)).toContain("Not tested");
  });
});

describe("the reasons restow-pve 0.5.0 reports", () => {
  const cases: [string, "green" | "yellow" | "red" | "skipped" | "error", string, string][] = [
    ["custom_qemu_args", "green", "muted", "Skipped"],
    ["host_disk", "green", "muted", "Skipped"],
    ["bridge_not_isolated", "green", "muted", "Skipped"],
    ["node_resources", "red", "muted", "Skipped"],
    ["storage_space", "red", "muted", "Skipped"],
    ["setup_failed", "red", "muted", "Not carried out"],
    ["io_error", "red", "muted", "Not carried out"],
    ["guest_agent_silent", "green", "warning", "Started, no answer"],
    ["init_running_unverified", "green", "warning", "Started, no answer"],
    ["systemd_degraded", "green", "warning", "Started, no answer"],
    ["systemd_emergency", "yellow", "destructive", "Did not boot"],
    ["guest_panicked", "yellow", "destructive", "Did not boot"],
  ];

  it.each(cases)("%s is never green and has a text of its own", (reason, sent, variant, label) => {
    expect(bootTestVariant(sent, reason)).toBe(variant);
    const html = render(
      <BootTestBadge test={test({ outcome: sent, reason, message: "node said" })} kind="vm" />,
    );
    expect(html).toContain(`data-variant="${variant}"`);
    expect(html).not.toContain('data-variant="success"');
    expect(html).toContain(label);
    expect(html).toContain('data-slot="pve-boot-test-reason"');
    const key = `guest.bootTestReason.${reason}`;
    for (const language of ["en", "de"]) {
      expect(i18n.exists(key, { ns: "pve", lng: language })).toBe(true);
    }
    expect(html).toContain(i18n.t(key, { ns: "pve" }).slice(0, 12));
  });

  it("a yellow reason never makes a red any better, and an unknown reason shows the node's message", () => {
    expect(bootTestVariant("red", "init_running_unverified")).toBe("destructive");
    expect(bootTestVariant("green", "agent_answered")).toBe("success");
    const html = render(
      <BootTestBadge
        test={test({ outcome: "yellow", reason: "a_newer_reason", message: "What the node saw" })}
        kind="vm"
      />,
    );
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain('data-slot="pve-boot-test-node-message"');
    expect(html).toContain("What the node saw");
    expect(html).not.toContain('data-slot="pve-boot-test-reason"');
  });
});

describe("a temporary guest the boot test could not remove", () => {
  it("is a leftover for any outcome while no inventory said it is gone", () => {
    expect(bootTestLeftover(test())).toBeNull();
    expect(bootTestLeftover(test({ cleanedUp: false }))).toEqual({
      vmid: 9001,
      storage: "local-lvm",
    });
    expect(bootTestLeftover(test({ outcome: "error", cleanedUp: false, tempVmid: 9007 }))).toEqual({
      vmid: 9007,
      storage: "local-lvm",
    });
    // No temporary guest was made (a skipped test): nothing is left.
    expect(
      bootTestLeftover(test({ outcome: "skipped", tempVmid: null, cleanedUp: false })),
    ).toBeNull();
    expect(
      bootTestLeftover(test({ cleanedUp: false, leftoverGoneAt: new Date().toISOString() })),
    ).toBeNull();
  });

  it("is amber on the restore point's badge, beside a green outcome", () => {
    const html = render(<BootTestBadge test={test({ cleanedUp: false })} kind="vm" />);
    expect(html).toContain("Booted");
    expect(html).toContain('data-slot="pve-boot-test-leftover"');
    expect(html).toContain("The temporary guest 9001 on local-lvm could not be removed.");
    expect(render(<BootTestBadge test={test()} kind="vm" />)).not.toContain(
      "pve-boot-test-leftover",
    );
  });

  it("keeps the run from green, and from grey when the test did not run to an end", () => {
    const boot = (over: Partial<PveBootTest>, status: "succeeded" | "failed" = "succeeded") => ({
      kind: "boot_test" as const,
      status,
      stats: { bootTest: test(over) },
    });
    expect(runTone(boot({}))).toBe("success");
    expect(runTone(boot({ cleanedUp: false }))).toBe("warning");
    expect(runTone(boot({ outcome: "error", cleanedUp: false }, "failed"))).toBe("warning");
    expect(runTone(boot({ outcome: "red", cleanedUp: false }))).toBe("destructive");
    expect(runTone(boot({ cleanedUp: false, leftoverGoneAt: new Date().toISOString() }))).toBe(
      "success",
    );
  });

  it("is a notice on the guest's page with its node", () => {
    const html = render(
      <BootTestLeftoverNotice
        leftover={{
          vmid: 9007,
          storage: "local-zfs",
          node: "pve1",
          runId: "r1",
          at: new Date().toISOString(),
        }}
      />,
    );
    expect(html).toContain('data-slot="pve-boot-test-leftover-notice"');
    expect(html).toContain("The temporary guest 9007 on local-zfs could not be removed.");
    expect(html).toContain("node pve1");
  });
});

describe("BootTestFacts", () => {
  it("says the job's schedule, or why the guest's node cannot boot-test", () => {
    expect(
      render(<BootTestFacts facts={{ blocker: null, schedule: "weekly", lastBootTestAt: null }} />),
    ).toContain("Boot tests: weekly");
    expect(
      render(
        <BootTestFacts
          facts={{ blocker: "node_unsupported", schedule: "weekly", lastBootTestAt: null }}
        />,
      ),
    ).toContain("restow-pve on the guest&#x27;s node does not run boot tests");
  });
});

describe("the readiness line of a guest", () => {
  it("names the boot test when it decided", () => {
    expect(guestResultKey({ state: "green", overdue: false, basis: "boot_test" })).toBe(
      "readiness.result.bootGreen",
    );
    expect(guestResultKey({ state: "yellow", overdue: false, basis: "boot_test" })).toBe(
      "readiness.result.bootYellow",
    );
    expect(guestResultKey({ state: "red", overdue: false, basis: "boot_test" })).toBe(
      "readiness.result.bootRed",
    );
    expect(guestResultKey({ state: "green", overdue: false, basis: "verify" })).toBe(
      "readiness.result.green",
    );
    // An older server says nothing about the basis.
    expect(guestResultKey({ state: "red", overdue: false })).toBe("readiness.result.red");
  });
});
