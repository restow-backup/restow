import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import "./i18n";
import type { PveBootTest } from "./api";
import { BootTestBadge, BootTestFacts, bootTestDetailKey, bootTestVariant } from "./boot-test";
import { guestResultKey } from "./readiness-row";

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
