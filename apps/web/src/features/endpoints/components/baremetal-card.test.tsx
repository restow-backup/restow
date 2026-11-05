// @vitest-environment happy-dom
import type * as React from "react";
import { act } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { Baremetal, BaremetalCheck, LayoutSummary } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { BaremetalCard, showsBaremetalCard } from "./baremetal-card.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({
    status: "authenticated",
    user: { id: "u1" },
    activeTenant: { id: "t-1", name: "Contoso" },
    refresh: async () => undefined,
    signOut: async () => undefined,
  }),
}));

const fetchBaremetal = vi.fn();
const fetchRecoveryIso = vi.fn();
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    fetchBaremetal: (...args: unknown[]) => fetchBaremetal(...args),
    fetchRecoveryIso: (...args: unknown[]) => fetchRecoveryIso(...args),
  };
});
// No router in this harness: a link is a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

const ID = "11111111-1111-4111-8111-111111111111";

const SUMMARY: LayoutSummary = {
  platform: "linux",
  os: {
    prettyName: "Debian GNU/Linux 12 (bookworm)",
    id: "debian",
    versionId: "12",
    arch: "amd64",
    kernel: "6.1.0-27-amd64",
  },
  firmware: { mode: "uefi", secureBoot: true },
  bootloader: { kind: "grub", platform: "x86_64-efi", shim: true },
  initramfs: { generator: "initramfs-tools", keymap: "de:nodeadkeys" },
  disks: [
    {
      id: "d0",
      kname: "nvme0n1",
      model: "Disk Model 512",
      sizeBytes: 512_110_190_592,
      transport: "nvme",
      logicalSectorSize: 512,
      tableType: "gpt",
      partitions: [
        { number: 1, startBytes: 1_048_576, sizeBytes: 536_870_912, content: "esp", label: "EFI" },
        {
          number: 2,
          startBytes: 537_919_488,
          sizeBytes: 1_023_410_176,
          content: "filesystem",
          label: null,
        },
        {
          number: 3,
          startBytes: 1_561_329_664,
          sizeBytes: 510_547_755_008,
          content: "luks",
          label: null,
        },
      ],
    },
  ],
  stack: [
    {
      kind: "disk",
      id: "disk:d0",
      label: "nvme0n1",
      sizeBytes: 512_110_190_592,
      children: [
        {
          kind: "partition",
          id: "partition:d0:3",
          label: "nvme0n1p3",
          sizeBytes: 510_547_755_008,
          children: [
            {
              kind: "luks",
              id: "luks:c0",
              label: "nvme0n1p3_crypt",
              sizeBytes: null,
              children: [],
            },
          ],
        },
      ],
    },
  ],
  mounts: [{ target: "/", type: "ext4" }],
  encryption: { luks: 1, plainCrypt: 0, tokenTypes: [] },
  vgs: [{ name: "vg0", sizeBytes: 510_526_783_488, freeBytes: 0 }],
  counts: { subvolumes: 0, lvs: 3 },
};

function baremetal(over: Partial<Baremetal> = {}): Baremetal {
  return {
    preview: true,
    enabled: true,
    state: "unverified",
    stateDetail: null,
    notPossible: null,
    latest: {
      layoutId: "22222222-2222-4222-8222-222222222222",
      runId: "33333333-3333-4333-8333-333333333333",
      snapshotId: "abcdef0123456789",
      capturedAt: "2026-11-04T21:00:03Z",
      sha256: "a".repeat(64),
      fingerprint: "b".repeat(64),
      verdict: "supported_with_warnings",
      unsupported: [
        { code: "bios_needs_csm", ref: null, message: "BIOS", severity: "warning" },
        { code: "fs_type_unsupported", ref: "f4", message: "zfs", severity: "unsupported" },
      ],
      summary: SUMMARY,
    },
    snapshotHint: null,
    check: null,
    ...over,
  };
}

const ALL_OK = (["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"] as const).map((id) => ({
  id,
  status: "ok" as const,
  findings: [],
  evidence: {},
}));

function check(over: Partial<BaremetalCheck> = {}): BaremetalCheck {
  return {
    reportId: "44444444-4444-4444-8444-444444444444",
    checkedAt: "2026-11-04T22:00:00Z",
    snapshotId: "abcdef0123456789",
    readiness: "green",
    incomplete: null,
    checks: ALL_OK,
    restoreSizes: { "/": { bytes: 9_123_456_789, files: 312_000, inodes: 340_112 } },
    minimumSizes: {
      disks: [
        { disk: "d0", kname: "nvme0n1", sizeBytes: 512_110_190_592, minBytes: 115_964_116_992 },
      ],
      filesystems: [
        {
          fs: "f2",
          mount: "/",
          type: "ext4",
          restoreBytes: 9_123_456_789,
          minBytes: 10_871_128_064,
        },
      ],
    },
    planner: {
      same: { ok: true, problems: [], warnings: [] },
      minimal: { ok: true, problems: [], warnings: [] },
      otherController: {
        ok: true,
        problems: [],
        warnings: [
          {
            code: "other_controller_driver_missing",
            ref: "t0",
            params: { kernel: "6.1.0-27-amd64", module: "ahci", modalias: "pci:x" },
          },
        ],
      },
    },
    bootChainFingerprint: "c".repeat(64),
    ...over,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("BaremetalCard", () => {
  let page: Mounted;
  beforeEach(() => fetchBaremetal.mockReset());
  afterEach(() => page?.unmount());

  async function open(value: Baremetal, os?: string) {
    fetchBaremetal.mockResolvedValue(value);
    page = mount();
    await page.render(<BaremetalCard endpointId={ID} os={os} />);
    await page.settle();
  }

  const iso = (verified: boolean) => ({
    version: verified ? "0.5.0" : null,
    fileName: null,
    url: null,
    sha256: null,
    releaseKeyFingerprint: null,
    verified,
    commands: { linux: [], macos: [], windows: [] },
  });
  const restoreButton = () => document.querySelector('[data-action="baremetal-restore"]');

  it("offers the restore wizard only with a verified recovery ISO (docs/BAREMETAL.md 22)", async () => {
    fetchRecoveryIso.mockResolvedValue(iso(false));
    await open(baremetal(), "linux");
    expect(fetchRecoveryIso).toHaveBeenCalled();
    expect(restoreButton()).toBeNull();
    page.unmount();
    fetchRecoveryIso.mockResolvedValue(iso(true));
    await open(baremetal(), "linux");
    expect(restoreButton()?.getAttribute("href")).toBe(`/inventory/${ID}/bare-metal`);
    expect(restoreButton()?.textContent).toContain("Restore…");
    page.unmount();
    // Preview off, another system, or not possible: no button, and no ISO asked for.
    fetchRecoveryIso.mockClear();
    await open(baremetal({ preview: false }), "linux");
    expect(restoreButton()).toBeNull();
    expect(fetchRecoveryIso).not.toHaveBeenCalled();
    page.unmount();
    await open(baremetal(), "darwin");
    expect(restoreButton()).toBeNull();
    page.unmount();
    await open(baremetal({ state: "not_possible", notPossible: "unsupported" }), "linux");
    expect(restoreButton()).toBeNull();
  });

  it("shows the captured layout, its assessment and what is not supported, never as proof", async () => {
    await open(baremetal());
    expect(fetchBaremetal).toHaveBeenCalledWith(ID);
    const text = page.text();
    expect(text).toContain("Bare-metal restore (preview)");
    expect(text).toContain("Layout captured; restore check pending");
    expect(text).toContain("has not run yet");
    expect(text).toContain("Supported, with notes");
    expect(text).toContain("abcdef01");
    // Unsupported first (red), then the warnings (yellow), each in its words.
    const findings = [...document.querySelectorAll('[data-slot="baremetal-findings"] li')];
    expect(findings.map((item) => item.getAttribute("data-severity"))).toEqual([
      "unsupported",
      "warning",
    ]);
    expect(findings[1]?.textContent).toContain("needs CSM or legacy boot");
    // Nothing on the card is green: a captured layout proves nothing yet.
    expect(page.html()).not.toContain('data-tone="success"');
    // The summary: system, firmware, boot loader, keyboard layout, the disk with its partitions.
    expect(text).toContain("Debian GNU/Linux 12 (bookworm)");
    expect(text).toContain("UEFI");
    expect(text).toContain("x86_64-efi");
    expect(text).toContain("de:nodeadkeys");
    expect(text).toContain("EFI system partition");
    expect(text).toContain("Encrypted (LUKS)");
    expect(text).toContain("nvme0n1p3_crypt");
    expect(document.querySelectorAll('[data-slot="layout-disk"]')).toHaveLength(1);
  });

  it("says how much to leave free when the volume group has no room for snapshots", async () => {
    await open(
      baremetal({
        snapshotHint: {
          vg: "vg0",
          sizeBytes: 510_526_783_488,
          freeBytes: 0,
          suggestedFreeBytes: 51_052_678_349,
          mounts: ["/", "/home"],
        },
      }),
    );
    const hint = document.querySelector('[data-slot="snapshot-hint"]')?.textContent ?? "";
    expect(hint).toContain("vg0 has no free space for snapshots");
    expect(hint).toContain("10 % of the volume group");
    expect(hint).toContain("/, /home");
  });

  it("says why a machine cannot be backed up as a whole", async () => {
    await open(baremetal({ state: "not_possible", notPossible: "agent_too_old", latest: null }));
    expect(page.text()).toContain("0.5.0 or later needed");
  });

  it("stays away while the preview is off and no layout exists", async () => {
    await open(baremetal({ preview: false, enabled: false, state: "not_enabled", latest: null }));
    expect(document.querySelector('[data-slot="baremetal-card"]')).toBeNull();
  });

  it("shows a passed layout check with its report and the minimum sizes, not as boot proof", async () => {
    await open(baremetal({ state: "layout_checked", check: check() }));
    const text = page.text();
    expect(text).toContain("Layout checked");
    expect(text).toContain("this is not yet proof that the restored machine starts");
    expect(document.querySelector('[data-slot="baremetal-check-result"]')?.textContent).toBe(
      "Passed",
    );
    // Green is kept for proof (the boot probe): neither the state nor the result is green.
    expect(document.querySelector('[data-slot="baremetal-state"]')?.getAttribute("data-tone")).toBe(
      "neutral",
    );
    expect(
      document.querySelector('[data-slot="baremetal-check-result"]')?.getAttribute("data-tone"),
    ).toBe("neutral");
    expect(page.html()).not.toContain('data-tone="success"');
    expect(document.querySelectorAll('[data-slot="baremetal-check"]')).toHaveLength(8);
    expect(text).toContain("Boot chain in the restore point");
    // The planner, per target, in its words.
    expect(text).toContain("Same hardware: Plans without problems");
    expect(text).toContain(
      "On another disk controller the backed-up kernel 6.1.0-27-amd64 would have no driver (ahci).",
    );
    // Minimum sizes per disk and per mount point, formatted.
    const minimum =
      document.querySelector('[data-slot="baremetal-minimum-sizes"]')?.textContent ?? "";
    expect(minimum).toContain("Minimum sizes");
    // Sizes in binary units, as everywhere on the page.
    expect(document.querySelector('[data-slot="minimum-disk"]')?.textContent).toBe(
      "nvme0n1 (now 477 GB): at least 108 GB",
    );
    expect(document.querySelector('[data-slot="minimum-filesystem"]')?.textContent).toBe(
      "/: 8.5 GB to restore, at least 10.1 GB",
    );
    expect(text).not.toContain("has not run yet");
  });

  it("shows a failed check with its proof, and the evidence on request", async () => {
    const checks = ALL_OK.map((item) =>
      item.id === "L6"
        ? {
            id: "L6" as const,
            status: "failed" as const,
            findings: [
              {
                code: "kernel_missing",
                severity: "failed" as const,
                ref: "6.1.0-27-amd64",
                params: {
                  version: "6.1.0-27-amd64",
                  path: "/boot/vmlinuz-6.1.0-27-amd64",
                  default: true,
                },
              },
            ],
            evidence: {
              kernels: [{ version: "6.1.0-27-amd64", found: false }],
              fstab: { entries: 5 },
            },
          }
        : item,
    );
    await open(baremetal({ state: "red", check: check({ readiness: "red", checks }) }));
    const text = page.text();
    expect(text).toContain("Restore check failed");
    expect(text).toContain("Fix it on the machine");
    expect(document.querySelector('[data-slot="baremetal-state"]')?.getAttribute("data-tone")).toBe(
      "destructive",
    );
    expect(document.querySelector('[data-check="L6"]')?.getAttribute("data-status")).toBe("failed");
    expect(text).toContain(
      "The kernel 6.1.0-27-amd64 (/boot/vmlinuz-6.1.0-27-amd64) is not in the restore point.",
    );
    const details = document.querySelector<HTMLDetailsElement>(
      '[data-check="L6"] [data-slot="baremetal-evidence"]',
    );
    expect(details?.querySelector("summary")?.textContent).toBe("Show evidence");
    await act(async () => {
      if (details) {
        details.open = true;
        details.dispatchEvent(new Event("toggle"));
      }
    });
    expect(details?.querySelector("summary")?.textContent).toBe("Hide evidence");
    // Evidence is text, never markup.
    expect(details?.querySelector("pre")?.textContent).toContain(
      'kernels: {"version":"6.1.0-27-amd64","found":false}',
    );
  });

  it("words the planner's codes with their parameters, sizes formatted", async () => {
    const checks = ALL_OK.map((item) =>
      item.id === "L3"
        ? {
            id: "L3" as const,
            status: "failed" as const,
            findings: [
              {
                code: "target_too_small",
                severity: "failed" as const,
                ref: "t0",
                params: {
                  target: "minimal",
                  disk: "d0",
                  haveBytes: 1_073_741_824,
                  needBytes: 2_147_483_648,
                },
              },
            ],
            evidence: {},
          }
        : item,
    );
    await open(baremetal({ state: "red", check: check({ readiness: "red", checks }) }));
    expect(page.text()).toContain("Target disk minimal has 1 GB, d0 needs at least 2 GB.");
  });

  it("says when the check could not finish (yellow), without rating", async () => {
    await open(
      baremetal({
        state: "unverified",
        stateDetail: "incomplete",
        check: check({
          readiness: "yellow",
          incomplete: "planner_timeout",
          minimumSizes: null,
          planner: {
            same: { ok: null, incomplete: "planner_timeout" },
            minimal: { ok: null, incomplete: "planner_timeout" },
            otherController: { ok: null, incomplete: "planner_timeout" },
          },
        }),
      }),
    );
    const text = page.text();
    expect(text).toContain("Layout captured; restore check pending");
    expect(text).toContain("could not finish");
    expect(document.querySelector('[data-slot="baremetal-check-result"]')?.textContent).toBe(
      "Incomplete",
    );
    expect(text).toContain("The restore planner took too long.");
    expect(document.querySelector('[data-slot="baremetal-minimum-sizes"]')).toBeNull();
  });

  it.each([
    ["unsupported", "The layout uses parts the restore cannot create"],
    ["arm64_later", "arm64 machines follow in a later version"],
  ] as const)("says why bare metal is not possible: %s", async (reason, words) => {
    await open(baremetal({ state: "not_possible", notPossible: reason }));
    expect(page.text()).toContain(words);
  });

  it("decides when the card has something to say", () => {
    expect(showsBaremetalCard(undefined)).toBe(false);
    expect(showsBaremetalCard(baremetal({ preview: false }))).toBe(true);
    expect(
      showsBaremetalCard(
        baremetal({ latest: null, state: "not_possible", notPossible: "windows", enabled: false }),
      ),
    ).toBe(false);
    expect(
      showsBaremetalCard(baremetal({ latest: null, state: "not_enabled", enabled: false })),
    ).toBe(true);
  });
});
