// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { Baremetal, LayoutSummary } from "../api.js";
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
vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return { ...actual, fetchBaremetal: (...args: unknown[]) => fetchBaremetal(...args) };
});

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

  async function open(value: Baremetal) {
    fetchBaremetal.mockResolvedValue(value);
    page = mount();
    await page.render(<BaremetalCard endpointId={ID} />);
    await page.settle();
  }

  it("shows the captured layout, its assessment and what is not supported, never as proof", async () => {
    await open(baremetal());
    expect(fetchBaremetal).toHaveBeenCalledWith(ID);
    const text = page.text();
    expect(text).toContain("Bare-metal restore (preview)");
    expect(text).toContain("Layout captured; the restore check follows in a later version");
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
