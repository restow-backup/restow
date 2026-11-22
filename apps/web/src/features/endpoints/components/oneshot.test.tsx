// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import {
  type IssuedRecoveryCode,
  type OneshotReported,
  RECOVERY_PHASES,
  type RecoveryDetail,
} from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import {
  directCommand,
  IssuedOneshotView,
  minutesLeft,
  ONESHOT_CHECKLIST,
  ONESHOT_STEPS,
  OneshotApproval,
  OneshotDialog,
  oneshotNotReady,
  oneshotStepOf,
  parseOldAddresses,
  validMatchCode,
} from "./oneshot.js";
import { RecoveryLiveView } from "./recovery-live.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
// Dialogs render in place, so no portal target is needed.
vi.mock("radix-ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("radix-ui")>();
  const InPlacePortal = ({ children }: { children?: unknown }) => children;
  return { ...actual, Dialog: { ...actual.Dialog, Portal: InPlacePortal } };
});

const issueRecoveryCode = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, issueRecoveryCode: (...args: unknown[]) => issueRecoveryCode(...args) };
});

const ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY_ID = "22222222-2222-4222-8222-222222222222";
const COMMAND =
  "curl -fsSL 'https://restow.firma.de/install/oneshot.sh' | RESTOW_ONESHOT_CODE='OS-7K3QX-M9P2D-H4TNV-8WRBC' sh";

function issued(over: Partial<IssuedRecoveryCode> = {}): IssuedRecoveryCode {
  return {
    id: RECOVERY_ID,
    kind: "oneshot",
    code: "OS-7K3QX-M9P2D-H4TNV-8WRBC",
    command: COMMAND,
    sessionValidityHours: 12,
    expiresAt: "2026-11-05T10:30:00.000Z",
    instanceOrigin: "https://restow.firma.de",
    instanceOriginConfigured: true,
    spkiCheck: "T6DN-BAMI-JR6W-LGRP",
    snapshotId: "a".repeat(64),
    requireApproval: true,
    iso: { version: "0.5.1", url: null, sha256: null, verified: true },
    ...over,
  };
}

function reported(over: Partial<OneshotReported["checks"]> = {}): OneshotReported {
  return {
    target: {
      hostname: "fresh-01",
      interfaces: [
        {
          name: "eth0",
          mac: "96:00:01:02:03:04",
          driver: "virtio_net",
          mtu: 1500,
          dhcp4: true,
          slaac: false,
          addresses: [{ address: "203.0.113.25", prefix: 32, dynamic: true }],
        },
      ],
      routes: [{ family: "inet", gateway: "172.31.1.1", dev: "eth0", onlink: true }],
      dns: ["192.0.2.53"],
      searchDomains: [],
      cloud: null,
      vendor: "QEMU",
      product: "Standard PC",
      consoles: ["tty0"],
      uptimeSeconds: 120,
      rescue: false,
    },
    checks: {
      mode: "kexec",
      kexec: "ok",
      kexecError: "",
      kexecLoadDisabled: false,
      lockdown: "none",
      secureBoot: false,
      memTotalBytes: 4_294_967_296,
      memAvailableBytes: 3_000_000_000,
      inUse: [],
      warnings: [],
      ...over,
    },
    sshKeys: [{ type: "ED25519", fingerprint: "SHA256:abcDEF123", comment: "admin@laptop" }],
    agentVersion: "0.5.1",
  };
}

function recovery(over: Partial<RecoveryDetail> = {}): RecoveryDetail {
  return {
    id: RECOVERY_ID,
    kind: "oneshot",
    status: "pending_approval",
    issuedAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-05T22:00:00.000Z",
    createdBy: { id: "u1", name: "Admin" },
    requireApproval: true,
    snapshotId: "a".repeat(64),
    instanceOrigin: "https://restow.firma.de",
    spkiCheck: "T6DN-BAMI-JR6W-LGRP",
    usedAt: "2026-11-05T10:05:00.000Z",
    usedIp: "203.0.113.25",
    matchCode: null,
    recoveryVersion: "0.5.1",
    approvedAt: null,
    approvedBy: null,
    credentialsIssuedAt: null,
    releasedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    phase: "waiting_approval",
    hardwareSummary: null,
    bootedAt: null,
    hardware: {
      firmware: "uefi",
      secureBoot: false,
      ramBytes: 4_294_967_296,
      disks: [
        {
          sizeBytes: 40_000_000_000,
          logicalSectorSize: 512,
          model: "QEMU HARDDISK",
          serial: "drive-scsi0",
          wwn: "",
          transport: "scsi",
        },
      ],
      nics: [{ mac: "96:00:01:02:03:04", driver: "virtio_net", link: true }],
    },
    progress: null,
    sshKeys: [],
    sshHostKeys: [],
    verification: null,
    warnings: [],
    log: { items: [], next: null },
    oneshot: {
      validityHours: 12,
      reported: reported(),
      decided: null,
      booted: null,
      isoDownloads: 0,
    },
    ...over,
  };
}

const progress = (phase: RecoveryDetail["phase"] & string): RecoveryDetail["progress"] => ({
  phase: phase as NonNullable<RecoveryDetail["progress"]>["phase"],
  step: 3,
  stepsTotal: 40,
  bytesDone: 0,
  totalBytes: 0,
  filesDone: 0,
  totalFiles: 0,
  message: "",
  updatedAt: "2026-11-05T10:20:00.000Z",
});

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the command for a fresh machine (docs/BAREMETAL-ONESHOT.md 18)", () => {
  let page: Mounted;
  beforeEach(() => issueRecoveryCode.mockReset());
  afterEach(() => page?.unmount());

  it("issues a oneshot session with the release on and 12 hours, then shows the command once", async () => {
    issueRecoveryCode.mockResolvedValue(issued());
    const onIssued = vi.fn();
    page = mount();
    await page.render(
      <OneshotDialog
        endpointId={ID}
        machineName="web01"
        snapshotId={"a".repeat(64)}
        open
        onOpenChange={() => undefined}
        onIssued={onIssued}
      />,
    );
    expect(page.text()).toContain("Onto a fresh machine: web01");
    expect(page.text()).toContain("lower the TTL of your DNS records");
    await page.click(document.querySelector('[data-action="issue-oneshot"]') as Element);
    await page.settle();
    expect(issueRecoveryCode).toHaveBeenCalledWith(ID, {
      kind: "oneshot",
      validityHours: 12,
      requireApproval: true,
      snapshotId: "a".repeat(64),
    });
    expect(onIssued).toHaveBeenCalled();
    const issuedView = document.querySelector('[data-slot="oneshot-issued"]');
    expect(issuedView?.textContent).toContain(COMMAND);
    expect(issuedView?.querySelector("button")).not.toBeNull();
    expect(document.querySelector('[data-slot="oneshot-root-hint"]')?.textContent).toContain(
      "sudo -i",
    );
    expect(document.querySelector('[data-slot="oneshot-same-provider"]')?.textContent).toContain(
      "Keep the existing configuration",
    );
    expect(document.querySelector('[data-slot="oneshot-direct-hint"]')).toBeNull();
  });

  it("gives the command for the provider's rescue system in direct mode", async () => {
    issueRecoveryCode.mockResolvedValue(issued());
    page = mount();
    await page.render(
      <OneshotDialog endpointId={ID} machineName="web01" open onOpenChange={() => undefined} />,
    );
    await page.click(document.querySelector("#oneshot-mode-direct") as Element);
    await page.click(document.querySelector('[data-action="issue-oneshot"]') as Element);
    await page.settle();
    const text = document.querySelector('[data-slot="oneshot-issued"]')?.textContent ?? "";
    expect(text).toContain(`${COMMAND} -s -- --direct`);
    expect(text).toContain("Command for the rescue system");
    expect(document.querySelector('[data-slot="oneshot-direct-hint"]')).not.toBeNull();
    expect(directCommand(COMMAND)).toBe(`${COMMAND} -s -- --direct`);
  });

  it("counts down the redeem window and says when it has passed", async () => {
    const issuedAt = Date.parse("2026-11-05T10:00:00.000Z");
    expect(minutesLeft("2026-11-05T10:30:00.000Z", issuedAt)).toBe(30);
    expect(minutesLeft("2026-11-05T10:30:00.000Z", issuedAt + 29 * 60_000 + 1)).toBe(1);
    expect(minutesLeft("2026-11-05T10:30:00.000Z", issuedAt + 31 * 60_000)).toBe(0);
    page = mount();
    await page.render(<IssuedOneshotView issued={issued()} direct={false} now={issuedAt} />);
    const countdown = document.querySelector('[data-slot="oneshot-countdown"]');
    expect(countdown?.textContent).toContain("Can be redeemed for 30 more minutes.");
    expect(countdown?.textContent).toContain("stays valid for 12 hours");
    page.unmount();
    page = mount();
    await page.render(
      <IssuedOneshotView issued={issued()} direct={false} now={issuedAt + 31 * 60_000} />,
    );
    expect(document.querySelector('[data-slot="oneshot-countdown"]')?.textContent).toContain(
      "The redeem window has passed",
    );
  });
});

describe("the release of a fresh machine (docs/BAREMETAL-ONESHOT.md 6.3, 10.3)", () => {
  let page: Mounted;
  afterEach(() => page?.unmount());

  it("validates the match code and the old addresses", () => {
    expect(validMatchCode("483914")).toBe(true);
    expect(validMatchCode("483 914")).toBe(true);
    expect(validMatchCode("48391")).toBe(false);
    expect(validMatchCode("48391a")).toBe(false);
    expect(validMatchCode("")).toBe(false);
    expect(parseOldAddresses("")).toEqual([]);
    expect(parseOldAddresses("203.0.113.10, 2001:db8::10")).toEqual([
      "203.0.113.10",
      "2001:db8::10",
    ]);
    expect(parseOldAddresses("203.0.113.300")).toBeNull();
    expect(parseOldAddresses("example.com")).toBeNull();
    expect(parseOldAddresses("1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4 5.5.5.5")).toBeNull();
  });

  it("shows what the machine reported and what the server saw", async () => {
    page = mount();
    await page.render(
      <OneshotApproval
        recovery={recovery({
          oneshot: {
            validityHours: 12,
            reported: reported({ warnings: ["ram_low"], lockdown: "integrity" }),
            decided: null,
            booted: null,
            isoDownloads: 0,
          },
        })}
        pending={false}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );
    const text = page.text();
    expect(text).toContain("fresh-01");
    expect(text).toContain("96:00:01:02:03:04");
    expect(text).toContain("203.0.113.25/32 (dynamic)");
    expect(text).toContain("Gateway 172.31.1.1 (on-link)");
    expect(text).toContain("QEMU HARDDISK");
    expect(text).toContain("drive-scsi0");
    expect(text).toContain("SHA256:abcDEF123");
    expect(text).toContain("Test load succeeded");
    expect(text).toContain("Little memory");
    expect(text).toContain("Kernel lockdown active (integrity).");
    expect(text).toContain("Reported by the machine.");
    expect(document.querySelector('[data-slot="oneshot-used-ip"]')?.textContent).toBe(
      "203.0.113.25",
    );
  });

  it("requires the six digits before it releases, and sends the decisions", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    page = mount();
    await page.render(
      <OneshotApproval
        recovery={recovery()}
        pending={false}
        onApprove={onApprove}
        onReject={onReject}
      />,
    );
    const approve = document.querySelector('[data-action="approve-oneshot"]') as Element;
    await page.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    expect(document.querySelector('[data-error="match-code"]')).not.toBeNull();
    const code = document.querySelector("#oneshot-match-code") as HTMLInputElement;
    await page.type(code, "48391");
    await page.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    await page.type(code, "483 914");
    const old = document.querySelector("#oneshot-old-addresses") as HTMLInputElement;
    await page.type(old, "not-an-address");
    expect(document.querySelector('[data-error="old-addresses"]')).not.toBeNull();
    await page.click(approve);
    expect(onApprove).not.toHaveBeenCalled();
    await page.type(old, "198.51.100.20");
    await page.click(document.querySelector("#oneshot-net-keep") as Element);
    await page.click(approve);
    expect(onApprove).toHaveBeenCalledWith({
      matchCode: "483914",
      networkMode: "keep",
      confirmShrink: false,
      secureBootWarningsOnly: false,
      remoteAccess: false,
      oldAddresses: ["198.51.100.20"],
    });
    await page.click(document.querySelector('[data-action="reject-recovery"]') as Element);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("takes over the network by default and allows remote access only when asked", async () => {
    const onApprove = vi.fn();
    page = mount();
    await page.render(
      <OneshotApproval
        recovery={recovery()}
        pending={false}
        onApprove={onApprove}
        onReject={() => undefined}
      />,
    );
    await page.click(document.querySelector("#oneshot-remoteAccess") as Element);
    await page.click(document.querySelector("#oneshot-confirmShrink") as Element);
    await page.type(document.querySelector("#oneshot-match-code") as HTMLInputElement, "483914");
    await page.click(document.querySelector('[data-action="approve-oneshot"]') as Element);
    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        networkMode: "takeover",
        remoteAccess: true,
        confirmShrink: true,
        oldAddresses: [],
      }),
    );
  });

  it("offers no remote access without keys of the machine", async () => {
    const withoutKeys = reported();
    withoutKeys.sshKeys = [];
    page = mount();
    await page.render(
      <OneshotApproval
        recovery={recovery({
          oneshot: {
            validityHours: 12,
            reported: withoutKeys,
            decided: null,
            booted: null,
            isoDownloads: 0,
          },
        })}
        pending={false}
        onApprove={() => undefined}
        onReject={() => undefined}
      />,
    );
    expect((document.querySelector("#oneshot-remoteAccess") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(page.text()).toContain("The machine reported no SSH keys.");
  });

  it("refuses a machine with an enrolled agent or a failed switch-over, like the server", async () => {
    const enrolled = recovery({
      oneshot: {
        validityHours: 12,
        reported: reported({ inUse: ["agent_enrolled"] }),
        decided: null,
        booted: null,
        isoDownloads: 0,
      },
    });
    expect(oneshotNotReady(enrolled)).toBe("agent_enrolled");
    expect(
      oneshotNotReady(
        recovery({
          oneshot: {
            validityHours: 12,
            reported: reported({ kexec: "failed" }),
            decided: null,
            booted: null,
            isoDownloads: 0,
          },
        }),
      ),
    ).toBe("kexec_failed");
    expect(
      oneshotNotReady(
        recovery({
          oneshot: {
            validityHours: 12,
            reported: reported({ mode: "direct", kexec: "not_tried" }),
            decided: null,
            booted: null,
            isoDownloads: 0,
          },
        }),
      ),
    ).toBeNull();
    expect(oneshotNotReady(recovery({ oneshot: null }))).toBe("kexec_not_tried");
    const onApprove = vi.fn();
    page = mount();
    await page.render(
      <OneshotApproval
        recovery={enrolled}
        pending={false}
        onApprove={onApprove}
        onReject={() => undefined}
      />,
    );
    expect(document.querySelector('[data-not-ready="agent_enrolled"]')).not.toBeNull();
    expect(document.querySelector('[data-sign="agent_enrolled"]')).not.toBeNull();
    const approve = document.querySelector('[data-action="approve-oneshot"]') as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
  });
});

describe("following a oneshot session (docs/BAREMETAL-ONESHOT.md 6.5, 13)", () => {
  let page: Mounted;
  afterEach(() => page?.unmount());

  const view = (detail: RecoveryDetail, onApproveOneshot = vi.fn()) => (
    <RecoveryLiveView
      recovery={detail}
      endpointId={ID}
      pending={false}
      onApprove={() => undefined}
      onApproveOneshot={onApproveOneshot}
      onCancel={() => undefined}
      onRevoke={() => undefined}
      onExtend={() => undefined}
    />
  );

  it("counts as booted only once the recovery environment reported back", () => {
    const step = (detail: RecoveryDetail) => ONESHOT_STEPS[oneshotStepOf(detail)];
    expect(step(recovery({ status: "issued", phase: null }))).toBe("registered");
    expect(step(recovery())).toBe("waiting_approval");
    expect(step(recovery({ status: "active", phase: "downloading" }))).toBe("downloading");
    expect(step(recovery({ status: "active", phase: "kexec" }))).toBe("kexec");
    // A phase the machine claims is not the report of the recovery environment.
    expect(step(recovery({ status: "active", phase: "booted" }))).toBe("kexec");
    expect(
      step(recovery({ status: "active", phase: "planning", progress: progress("planning") })),
    ).toBe("kexec");
    expect(
      step(recovery({ status: "active", phase: "booted", bootedAt: "2026-11-05T10:15:00.000Z" })),
    ).toBe("booted");
    expect(
      step(
        recovery({
          status: "active",
          phase: "restoring",
          progress: progress("restoring"),
          oneshot: {
            validityHours: 12,
            reported: reported(),
            decided: null,
            booted: { at: "2026-11-05T10:15:00.000Z" },
            isoDownloads: 1,
          },
        }),
      ),
    ).toBe("restoring");
    expect(step(recovery({ status: "succeeded", phase: "done" }))).toBe("done");
  });

  it("shows the release for a pending session and no ISO block", async () => {
    page = mount();
    await page.render(view(recovery()));
    expect(document.querySelector('[data-slot="oneshot-approval"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="recovery-approval"]')).toBeNull();
    const steps = document.querySelector('[data-slot="oneshot-steps"]');
    expect(steps?.getAttribute("data-current")).toBe("waiting_approval");
    expect(
      document.querySelector('[data-step="waiting_approval"]')?.getAttribute("class"),
    ).toContain("text-info-text");
    expect(document.querySelector('[data-slot="oneshot-checklist"]')).toBeNull();
  });

  it("is neutral while it runs and green only when it succeeded, then lists what remains", async () => {
    page = mount();
    await page.render(
      view(recovery({ status: "active", phase: "kexec", progress: progress("kexec") })),
    );
    expect(
      document.querySelector('[data-slot="recovery-status"]')?.getAttribute("data-tone"),
    ).not.toBe("success");
    expect(document.querySelector('[data-step="booted"]')?.getAttribute("data-state")).toBe("next");
    expect(page.text()).toContain("Switching over (the SSH connection drops)");
    page.unmount();
    page = mount();
    await page.render(
      view(
        recovery({
          status: "succeeded",
          phase: "done",
          bootedAt: "2026-11-05T10:15:00.000Z",
          finishedAt: "2026-11-05T11:00:00.000Z",
        }),
      ),
    );
    expect(document.querySelector('[data-slot="recovery-status"]')?.getAttribute("data-tone")).toBe(
      "success",
    );
    expect(
      document.querySelector('[data-slot="oneshot-steps"]')?.getAttribute("data-current"),
    ).toBe("done");
    expect(document.querySelector('[data-slot="oneshot-restart"]')?.textContent).toContain(
      "only be stopped with a key on the machine's console",
    );
    const checklist = document.querySelector('[data-slot="oneshot-checklist"]');
    expect(checklist?.querySelectorAll("li")).toHaveLength(ONESHOT_CHECKLIST.length);
    expect(checklist?.textContent).toContain(`/etc/restow/network-before-restore/${RECOVERY_ID}/`);
    expect(checklist?.textContent).toContain("/etc/cloud/cloud.cfg.d/99-restow-restored.cfg");
    expect(checklist?.textContent).toContain("PTR");
  });

  it("marks where a failed session stopped", async () => {
    page = mount();
    await page.render(
      view(recovery({ status: "failed", phase: "kexec", finishedAt: "2026-11-05T10:20:00.000Z" })),
    );
    expect(document.querySelector('[data-step="kexec"]')?.getAttribute("data-state")).toBe(
      "stopped",
    );
    expect(document.querySelector('[data-slot="oneshot-checklist"]')).toBeNull();
  });
});

describe("the texts of a oneshot session", () => {
  const languages = ["en", "de"] as const;
  // The suite runs in apps/web; the Go agent lies two levels up.
  const goConstants = (path: string, pattern: RegExp) =>
    [...readFileSync(resolve(process.cwd(), "../..", path), "utf8").matchAll(pattern)].map(
      (match) => match[1] as string,
    );

  it("words every phase, step, check result and checklist item in both languages", () => {
    const keys = [
      ...RECOVERY_PHASES.map((phase) => `recovery.phases.${phase}`),
      ...ONESHOT_STEPS.map((step) => `recovery.oneshot.steps.${step}`),
      ...ONESHOT_CHECKLIST.map((item) => `recovery.oneshot.checklist.${item}`),
      ...["ok", "failed", "not_tried", "direct"].map((r) => `recovery.oneshot.kexec.${r}`),
      ...["agent_enrolled", "kexec_failed", "kexec_not_tried"].map(
        (reason) => `recovery.oneshot.notReady.${reason}`,
      ),
      ...["takeover", "takeoverHint", "keep", "keepHint"].map(
        (key) => `recovery.oneshot.net.${key}`,
      ),
      ...["confirmShrink", "secureBootWarningsOnly", "remoteAccess"].flatMap((name) => [
        `recovery.oneshot.permission.${name}`,
        `recovery.oneshot.permission.${name}Hint`,
      ]),
    ];
    for (const lng of languages) {
      for (const key of keys) {
        expect(i18n.exists(key, { ns: "endpoints", lng }), `${lng} ${key}`).toBe(true);
      }
    }
  });

  it("words every sign of use and every warning the command reports", () => {
    const signs = goConstants(
      "agent/internal/api/oneshot.go",
      /OneshotInUse\w+\s*=\s*"([a-z_]+)"/g,
    );
    const warnings = goConstants(
      "agent/internal/oneshot/flow.go",
      /checks\.Warnings[^"]*"([a-z_]+)"/g,
    );
    expect(signs).toContain("agent_enrolled");
    expect(warnings).toContain("ram_low");
    for (const lng of languages) {
      for (const sign of signs) {
        expect(i18n.exists(`recovery.oneshot.inUse.${sign}`, { ns: "endpoints", lng }), sign).toBe(
          true,
        );
      }
      for (const warning of warnings) {
        expect(
          i18n.exists(`recovery.oneshot.warning.${warning}`, { ns: "endpoints", lng }),
          warning,
        ).toBe(true);
      }
    }
  });
});
