// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { RecoveryDetail } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { RecoveryLiveView } from "./recovery-live.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));

function recovery(over: Partial<RecoveryDetail> = {}): RecoveryDetail {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    kind: "code",
    status: "pending_approval",
    issuedAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-05T14:00:00.000Z",
    createdBy: { id: "u1", name: "Admin" },
    requireApproval: true,
    snapshotId: "a".repeat(64),
    instanceOrigin: "https://restow.firma.de",
    spkiCheck: "T6DN-BAMI-JR6W-LGRP",
    usedAt: "2026-11-05T10:05:00.000Z",
    usedIp: "198.51.100.7",
    matchCode: "483914",
    recoveryVersion: "0.5.0",
    approvedAt: null,
    approvedBy: null,
    credentialsIssuedAt: null,
    releasedAt: null,
    finishedAt: null,
    cancelRequestedAt: null,
    phase: "waiting_approval",
    hardwareSummary: null,
    hardware: {
      firmware: "uefi",
      secureBoot: true,
      ramBytes: 17_179_869_184,
      disks: [
        {
          sizeBytes: 1_000_204_886_016,
          logicalSectorSize: 512,
          model: "Samsung SSD 980",
          serial: "S64",
          wwn: "",
          transport: "nvme",
        },
      ],
      nics: [{ mac: "52:54:00:12:34:56", driver: "virtio_net", link: true }],
    },
    progress: null,
    sshKeys: [],
    sshHostKeys: [],
    verification: null,
    warnings: [],
    log: {
      items: [{ id: "l-1", at: "2026-11-05T10:06:00.000Z", lines: ["<b>not html</b>"] }],
      next: null,
    },
    ...over,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the live view of a recovery (docs/BAREMETAL.md 9.4, 9.8)", () => {
  let page: Mounted;
  afterEach(() => page?.unmount());

  it("asks for the release with the match code, the address and the hardware the ISO found", async () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    page = mount();
    await page.render(
      <RecoveryLiveView
        recovery={recovery()}
        endpointId="11111111-1111-4111-8111-111111111111"
        pending={false}
        onApprove={onApprove}
        onCancel={onCancel}
        onRevoke={() => undefined}
        onExtend={() => undefined}
      />,
    );
    expect(document.querySelector('[data-slot="match-code"]')?.textContent).toBe("483 914");
    const text = page.text();
    expect(text).toContain("restow.firma.de");
    expect(text).toContain("Samsung SSD 980");
    expect(text).toContain("52:54:00:12:34:56");
    expect(text).toContain("Reported by the recovery ISO.");
    await page.click(document.querySelector('[data-action="approve-recovery"]') as Element);
    await page.click(document.querySelector('[data-action="reject-recovery"]') as Element);
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
    // The log is text, never markup.
    const log = document.querySelector('[data-slot="recovery-log"] pre');
    expect(log?.textContent).toBe("<b>not html</b>");
    expect(log?.querySelector("b")).toBeNull();
  });

  it("follows the phases and is green only when it succeeded", async () => {
    page = mount();
    await page.render(
      <RecoveryLiveView
        recovery={recovery({
          status: "succeeded",
          phase: "done",
          progress: {
            phase: "done",
            step: 40,
            stepsTotal: 40,
            bytesDone: 10,
            totalBytes: 10,
            filesDone: 2,
            totalFiles: 2,
            message: "",
            updatedAt: "2026-11-05T11:00:00.000Z",
          },
        })}
        endpointId="11111111-1111-4111-8111-111111111111"
        pending={false}
        onApprove={() => undefined}
        onCancel={() => undefined}
        onRevoke={() => undefined}
        onExtend={() => undefined}
      />,
    );
    expect(document.querySelector('[data-slot="recovery-status"]')?.getAttribute("data-tone")).toBe(
      "success",
    );
    expect(document.querySelector('[data-slot="recovery-approval"]')).toBeNull();
    expect(document.querySelector('[data-action="cancel-recovery"]')).toBeNull();
    expect(page.text()).toContain("Step 40 of 40");
  });

  it("shows the ISO's verification with each check, findings as text and the warnings by code", async () => {
    for (const language of ["en", "de"] as const) {
      await i18n.changeLanguage(language);
      page = mount();
      await page.render(
        <RecoveryLiveView
          recovery={recovery({
            status: "succeeded",
            phase: "done",
            verification: {
              format: "restow-verify-v1",
              result: "warning",
              snapshotId: "4f2a9c1d",
              planSha256: "9".repeat(64),
              startedAt: "2026-11-05T09:12:00Z",
              finishedAt: "2026-11-05T10:40:13Z",
              restoreErrors: 2,
              checks: [
                {
                  id: "initramfs",
                  result: "warning",
                  findings: [
                    {
                      code: "initramfs_not_rebuilt",
                      ref: "6.1.0-25-amd64",
                      message: "<i>not enough space on /boot</i>",
                      params: {},
                    },
                  ],
                  evidence: { kernel: "6.1.0-27-amd64", readable: true, bootFreePercent: 23 },
                },
                {
                  id: "restic_verify",
                  result: "ok",
                  findings: [],
                  evidence: { files: 412233, errors: 0 },
                },
                { id: "future_check", result: "failed", findings: [], evidence: {} },
              ],
              hints: [],
              fixups: [{ path: "/etc/fstab", rule: "device_names", backup: "/etc/fstab.restow-1" }],
              notAdaptedKernels: ["6.1.0-25-amd64"],
            },
            warnings: [{ code: "mok_enroll_pending", message: "MOK import queued" }],
          })}
          endpointId="11111111-1111-4111-8111-111111111111"
          pending={false}
          onApprove={() => undefined}
          onCancel={() => undefined}
          onRevoke={() => undefined}
          onExtend={() => undefined}
        />,
      );
      const block = document.querySelector('[data-slot="recovery-verification"]');
      // In the order of 10.17, an unknown check last by its id.
      expect(
        [...(block?.querySelectorAll("[data-check]") ?? [])].map((node) =>
          node.getAttribute("data-check"),
        ),
      ).toEqual(["restic_verify", "initramfs", "future_check"]);
      expect(block?.querySelector("i")).toBeNull();
      const text = page.text();
      expect(text).toContain("<i>not enough space on /boot</i>");
      expect(text).toContain("6.1.0-27-amd64");
      expect(text).toContain("future_check");
      expect(text).toContain("/etc/fstab.restow-1");
      expect(text).toContain("MOK import queued");
      if (language === "en") {
        expect(text).toContain("Initramfs");
        expect(text).toContain("Reported by the recovery ISO");
        expect(document.querySelector('[data-code="mok_enroll_pending"]')?.textContent).toContain(
          "Secure Boot",
        );
      } else {
        expect(text).toContain("Vom Recovery-ISO gemeldet");
        expect(document.querySelector('[data-slot="verification-result"]')?.textContent).toBe(
          "Mit Warnungen",
        );
      }
      if (language === "en") page.unmount();
    }
    await i18n.changeLanguage("en");
  });
});
