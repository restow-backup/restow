// @vitest-environment happy-dom
import type * as React from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { i18n } from "@/i18n";

import type { Baremetal, RecoveryIso, RecoveryIsoLocal, ReplacementHardware } from "../api.js";
import { type Mounted, mount } from "../dom-harness.js";
import "../i18n.js";
import { BaremetalWizardPage, defaultSnapshot } from "./baremetal-wizard.js";

vi.mock("@/lib/session", () => ({
  useSession: () => ({ status: "authenticated", activeTenant: { id: "t-1", name: "Contoso" } }),
}));
vi.mock("@/routes/not-found", () => ({
  NotFoundPage: () => <p data-slot="not-found">not found</p>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("./recovery-live.js", () => ({
  RecoveryLive: ({ recoveryId }: { recoveryId: string }) => (
    <div data-slot="recovery-live-card" data-recovery={recoveryId} />
  ),
}));
// The dialog has its own suite; here it shows which snapshot it was handed.
vi.mock("./recovery-code-dialog.js", () => ({
  RecoveryCodeDialog: ({ snapshotId }: { snapshotId?: string }) => (
    <div data-slot="code-dialog" data-snapshot={snapshotId} />
  ),
  typedAddress: (value: string) => value,
}));

const ID = "11111111-1111-4111-8111-111111111111";
const RECOVERY = "22222222-2222-4222-8222-222222222222";
const NEW = "a".repeat(64);
const OLD = "b".repeat(64);
const OLDER = "c".repeat(64);

const uefi: ReplacementHardware = {
  firmwareMode: "uefi",
  secureBoot: true,
  requiredCAs: ["CN=Microsoft Corporation UEFI CA 2011"],
  disks: [
    {
      id: "d0",
      kname: "nvme0n1",
      sizeBytes: 512_110_190_592,
      minBytes: 115_964_116_992,
      transport: "nvme",
      logicalSectorSize: 512,
      model: "Samsung SSD 980",
    },
  ],
  ramMinBytes: 2 * 1024 ** 3,
  ramRecommendedBytes: 4 * 1024 ** 3,
  keymap: { layout: "de", variant: "nodeadkeys", inInitramfs: true, grubCryptodisk: false },
  luksVolumes: 1,
  tokenTypes: ["systemd-tpm2"],
  tpm: true,
  storageDriversOtherController: [
    { module: "ahci", ok: true },
    { module: "megaraid_sas", ok: false },
  ],
  hardwareRaidHint: [{ disk: "d0", minBytes: 115_964_116_992 }],
  biosNeedsCsm: false,
  nics: 1,
};
const bios: ReplacementHardware = { ...uefi, firmwareMode: "bios", biosNeedsCsm: true };

const state = {
  iso: {} as RecoveryIso,
  recovery: null as Record<string, unknown> | null,
};

const baremetal: Baremetal = {
  preview: true,
  enabled: true,
  state: "layout_checked",
  stateDetail: null,
  notPossible: null,
  latest: {
    layoutId: "l-new",
    runId: "r-1",
    snapshotId: NEW,
    capturedAt: "2026-11-04T02:00:00Z",
    sha256: "1".repeat(64),
    fingerprint: "f",
    verdict: "supported",
    unsupported: [],
    summary: { firmware: { mode: "uefi", secureBoot: true } } as never,
  },
  snapshotHint: null,
  check: null,
  snapshots: [
    {
      snapshotId: NEW,
      time: "2026-11-04T02:00:00Z",
      layoutId: "l-new",
      layoutSha256: "1".repeat(64),
      sameLayoutAsNewest: true,
      check: "failed",
      verdict: "supported",
    },
    {
      snapshotId: OLD,
      time: "2026-11-03T02:00:00Z",
      layoutId: "l-old",
      layoutSha256: "2".repeat(64),
      sameLayoutAsNewest: false,
      check: "passed",
      verdict: "supported",
    },
    {
      snapshotId: OLDER,
      time: "2026-11-02T02:00:00Z",
      layoutId: "l-old",
      layoutSha256: "2".repeat(64),
      sameLayoutAsNewest: false,
      check: "none",
      verdict: "unsupported",
    },
  ],
  hardware: uefi,
  hardwareByLayout: { "l-new": uefi, "l-old": bios },
  activeRecovery: null,
};

vi.mock("../api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api.js")>();
  return {
    ...actual,
    fetchEndpoint: async () => ({ id: ID, hostname: "web01", displayName: null, os: "linux" }),
    fetchBaremetal: async () => baremetal,
    fetchRecoveryIso: async () => state.iso,
    fetchRecoveries: async () =>
      state.recovery ? [{ id: RECOVERY, status: state.recovery.status }] : [],
    fetchRecovery: async () => state.recovery,
  };
});

const GITHUB_ISO =
  "https://github.com/restow-backup/restow/releases/download/v0.5.0/restow-recovery_0.5.0_amd64.iso";

function local(over: Partial<RecoveryIsoLocal> = {}): RecoveryIsoLocal {
  return {
    status: "not_fetched",
    problem: null,
    detail: null,
    bytesDone: null,
    bytesTotal: null,
    origin: null,
    importDir: "/data/recovery-iso/import",
    updatedAt: null,
    ...over,
  };
}

function iso(over: Partial<RecoveryIso> = {}): RecoveryIso {
  return {
    version: "0.5.0",
    fileName: "restow-recovery_0.5.0_amd64.iso",
    url: GITHUB_ISO,
    githubUrl: GITHUB_ISO,
    source: "github",
    sha256: "c".repeat(64),
    sizeBytes: null,
    releaseKeyFingerprint: "SHA256:abc",
    verified: true,
    releaseUrl: "https://github.com/restow-backup/restow/releases/tag/v0.5.0",
    sourcesUrl: "https://github.com/restow-backup/restow/releases/tag/v0.5.0",
    firmwareLicensesUrl:
      "https://github.com/restow-backup/restow/releases/download/v0.5.0/restow-recovery_0.5.0_FIRMWARE-LICENSES.txt",
    commands: { linux: ["./verify"], macos: [], windows: [] },
    ...over,
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("the bare metal wizard (docs/BAREMETAL.md 14.6)", () => {
  let page: Mounted;
  afterEach(() => page?.unmount());

  it("picks the newest snapshot that passed, else the newest, never an unsupported one", () => {
    expect(defaultSnapshot(baremetal.snapshots ?? [])?.snapshotId).toBe(OLD);
    expect(
      defaultSnapshot((baremetal.snapshots ?? []).map((s) => ({ ...s, check: "none" as const })))
        ?.snapshotId,
    ).toBe(NEW);
    expect(defaultSnapshot([(baremetal.snapshots ?? [])[2] as never])).toBeNull();
  });

  it("lists the snapshots, guides the hardware of the chosen layout and hands its id to the code", async () => {
    state.iso = iso();
    state.recovery = null;
    page = mount();
    await page.render(<BaremetalWizardPage endpointId={ID} />);
    await page.settle();
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>('input[name="wizard-snapshot"]'),
    ];
    expect(radios.map((radio) => radio.value)).toEqual([NEW, OLD, OLDER]);
    expect(radios.find((radio) => radio.checked)?.value).toBe(OLD);
    expect(radios[2]?.disabled).toBe(true);
    expect(page.text()).toContain("Other layout than the newest");
    // The older layout is BIOS: the guide says CSM.
    expect(document.querySelector('[data-slot="hardware-firmware"]')?.textContent).toContain("CSM");
    expect(document.querySelector('[data-slot="code-dialog"]')?.getAttribute("data-snapshot")).toBe(
      OLD,
    );

    await page.click(radios[0] as Element);
    const hardware = page.text();
    expect(document.querySelector('[data-slot="hardware-firmware"]')?.textContent).not.toContain(
      "CSM",
    );
    expect(hardware).toContain("Microsoft Corporation UEFI CA 2011");
    expect(hardware).toContain("nvme0n1");
    expect(document.querySelector('[data-slot="hardware-controllers"]')?.textContent).toContain(
      "ahci",
    );
    expect(document.querySelector('[data-slot="hardware-driver-missing"]')?.textContent).toContain(
      "megaraid_sas",
    );
    expect(document.querySelector('[data-slot="hardware-raid"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="hardware-encryption"]')?.textContent).toContain(
      "de (nodeadkeys)",
    );
    expect(document.querySelector('[data-slot="hardware-tpm"]')?.textContent).toContain(
      "systemd-tpm2",
    );
    expect(hardware).not.toContain("follows with the recovery ISO");
    expect(document.querySelector('[data-slot="code-dialog"]')?.getAttribute("data-snapshot")).toBe(
      NEW,
    );
  });

  it("says where the ISO comes from and links the GPL sources and the firmware licences", async () => {
    const variants = [
      ["github", null],
      ["instance", "import"],
      ["instance", "store"],
    ] as const;
    for (const [source, origin] of variants) {
      state.iso = iso(
        source === "instance"
          ? {
              source,
              url: "https://restow.firma.de/api/v1/recovery-iso/file/restow-recovery_0.5.0_amd64.iso",
              sizeBytes: 734_003_200,
              local: local({ status: "verified", origin }),
            }
          : {},
      );
      page = mount();
      await page.render(<BaremetalWizardPage endpointId={ID} />);
      await page.settle();
      const slot = document.querySelector('[data-slot="recovery-iso-source"]')?.textContent ?? "";
      expect(slot).toContain(source === "instance" ? "this instance" : "public release page");
      // A copy from the drop folder was never fetched by the instance.
      if (origin === "import") {
        expect(slot).toContain("import folder");
        expect(slot).not.toContain("fetched");
      }
      if (origin === "store") expect(slot).toContain("fetched the ISO once");
      const links = [...document.querySelectorAll('[data-slot="recovery-iso-licences"] a')].map(
        (link) => link.getAttribute("href"),
      );
      expect(links).toEqual([
        "https://github.com/restow-backup/restow/releases/tag/v0.5.0",
        "https://github.com/restow-backup/restow/releases/download/v0.5.0/restow-recovery_0.5.0_FIRMWARE-LICENSES.txt",
      ]);
      const download = document.querySelector('[data-slot="recovery-iso-download"]');
      const fallback = document.querySelector('[data-slot="recovery-iso-fallback"] a');
      if (source === "instance") {
        // A plain navigation behind the login: the tenant travels in the address.
        expect(download?.getAttribute("href")).toBe(
          "https://restow.firma.de/api/v1/recovery-iso/file/restow-recovery_0.5.0_amd64.iso?tenant=t-1",
        );
        // The release page stays the fallback.
        expect(fallback?.getAttribute("href")).toBe(GITHUB_ISO);
      } else {
        expect(download?.getAttribute("href")).toBe(GITHUB_ISO);
        expect(fallback).toBeNull();
      }
      if (origin !== "store") page.unmount();
    }
  });

  it("tells how far the instance got with its own copy, in both languages", async () => {
    const cases = [
      [local({ status: "not_fetched" }), "has not fetched the ISO yet", "noch nicht geladen"],
      [
        local({ status: "fetching", bytesDone: 1024 ** 3 / 4, bytesTotal: 1024 ** 3 }),
        "is fetching the ISO in the background: 256 MB of 1 GB",
        "lädt das ISO im Hintergrund: 256",
      ],
      [
        local({ status: "failed", problem: "hash_mismatch" }),
        "does not match the signed checksum",
        "passt nicht zur signierten Prüfsumme",
      ],
      [local({ status: "disabled" }), "does not fetch the ISO itself", "nicht selbst"],
    ] as const;
    for (const language of ["en", "de"] as const) {
      await i18n.changeLanguage(language);
      for (const [state_, en, de] of cases) {
        state.iso = iso({ local: state_ });
        page = mount();
        await page.render(<BaremetalWizardPage endpointId={ID} />);
        await page.settle();
        const block = document.querySelector('[data-slot="recovery-iso-local"]');
        expect(block?.getAttribute("data-status")).toBe(state_.status);
        expect(block?.textContent ?? "").toContain(language === "en" ? en : de);
        // The drop folder for installations without internet access.
        expect(document.querySelector('[data-slot="recovery-iso-import"]')?.textContent).toContain(
          "/data/recovery-iso/import",
        );
        page.unmount();
      }
    }
    await i18n.changeLanguage("en");
    // A rebuild names its number; a skipped one is a note next to the instance's copy.
    state.iso = iso({
      rebuild: 2,
      fileName: "restow-recovery_0.5.0.2_amd64.iso",
      source: "instance",
      url: "https://restow.firma.de/api/v1/recovery-iso/file/restow-recovery_0.5.0.2_amd64.iso",
      local: local({ status: "verified", origin: "store", problem: "signature_invalid" }),
    });
    page = mount();
    await page.render(<BaremetalWizardPage endpointId={ID} />);
    await page.settle();
    expect(document.querySelector('[data-slot="recovery-iso-version"]')?.textContent).toBe(
      "0.5.0, rebuild 2 (newer security updates of the base system)",
    );
    expect(document.querySelector('[data-slot="recovery-iso-local"]')?.textContent).toContain(
      "A newer rebuild of the ISO was not taken: the signature of the checksums does not match",
    );
    expect(document.querySelector('[data-slot="recovery-iso-import"]')).toBeNull();
  });

  it("shows the ISO's hints for afterwards once the session ended", async () => {
    state.iso = iso();
    state.recovery = {
      id: RECOVERY,
      status: "succeeded",
      verification: {
        format: "restow-verify-v1",
        result: "warning",
        checks: [],
        hints: [
          { code: "mok_enroll", params: {} },
          { code: "nic_mapped", params: { oldName: "eno1", oldMac: "aa", newMac: "bb" } },
          { code: "made_up_hint", params: {} },
        ],
        fixups: [],
        notAdaptedKernels: [],
      },
      warnings: [{ code: "old_disk_present", message: "serial X" }],
    };
    page = mount();
    await page.render(<BaremetalWizardPage endpointId={ID} />);
    await page.settle();
    await page.settle();
    const after = document.querySelector('[data-slot="wizard-after"]');
    expect(after).not.toBeNull();
    const text = after?.textContent ?? "";
    expect(text).toContain("eno1");
    expect(text).toContain("bb");
    expect(text).toContain("made_up_hint");
    expect(document.querySelector('[data-hint="mok_enroll"]')?.textContent).toContain(
      "recovery console",
    );
    expect(document.querySelector('[data-code="old_disk_present"]')).not.toBeNull();
    state.recovery = null;
  });
});
