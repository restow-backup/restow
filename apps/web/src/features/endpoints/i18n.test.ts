import { readFileSync } from "node:fs";
import de from "@restow/i18n/resources/de/endpoints.json" with { type: "json" };
import en from "@restow/i18n/resources/en/endpoints.json" with { type: "json" };
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";

import { RECOVERY_SERVER_WARNING_CODES } from "./api.js";
import "./i18n.js";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string"
      ? [[prefix ? `${prefix}.${key}` : key, value] as [string, string]]
      : leaves(value, prefix ? `${prefix}.${key}` : key),
  );
}

const sources = import.meta.glob<string>(
  ["./**/*.ts", "./**/*.tsx", "!./**/*.test.*", "!./dom-harness.tsx"],
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

/** The keys the feature's source names outright (`t("list.search")`), dynamic ones left out. */
function staticKeys(): Set<string> {
  const keys = new Set<string>();
  for (const source of Object.values(sources)) {
    for (const match of source.matchAll(/\bt\(\s*"([^"$]+)"/g)) {
      // Keys of another namespace (`common:app.name`) are not this feature's.
      if (!(match[1] as string).includes(":")) keys.add(match[1] as string);
    }
    // Keys the presenters hand to components as messages.
    for (const match of source.matchAll(/\bkey:\s*"([a-zA-Z_.]+)"/g)) {
      keys.add(match[1] as string);
    }
  }
  return keys;
}

const VALUES = {
  count: 2,
  hours: 2,
  days: 7,
  min: 5,
  max: 50,
  default: 240,
  name: "web-01",
  person: "Alice Example",
  url: "https://restow.example",
  time: "30 Sep 2026",
  date: "30 Sep 2026",
  at: "30 Sep 2026, 20:00",
  vmid: 300,
  node: "pve1",
  hostname: "web-01",
  id: "abcd1234",
  path: "/etc",
  index: 1,
  kind: "server",
  reason: "container",
  technology: "lxc",
  value: "x",
  done: "1",
  total: "2",
  step: 3,
  totalFiles: "40",
  matched: "19",
  files: "20",
  percent: 12,
  size: "1 GB",
  used: "900 GB",
  budget: "1 TB",
  kept: "40",
  message: "boom",
  status: "ok",
  daily: 30,
  weekly: 12,
  monthly: 12,
  version: 3,
  applied: 2,
  code: 3,
  scripts: "db-dump, fsfreeze",
  tokenFile: "/root/restow-enrollment.token",
  fingerprint: "0123456789abcdef",
  job: "Linux servers, daily",
  sequence: 12,
  zone: "Europe/Berlin",
  from: "20:00",
  to: "06:00",
  mode: "As soon as the machine is on again",
  kbps: 2000,
  os: "windows",
  method: "vss",
  live: "D:\\",
  vg: "vg0",
  mounts: "/, /home",
  disk: "nvme0n1",
  luks: 1,
  plain: 0,
  // The layout check and the restore planner (docs/BAREMETAL.md 12.1, C-M2-5).
  codes: "fs_type_unsupported",
  target: "t0",
  source: "UUID=1A2B-3C4D",
  expected: "a1b2",
  actual: "c3d4",
  type: "ext4",
  device: "/dev/sda2",
  entry: 1,
  tool: "update-initramfs",
  tools: "grub-install",
  bytes: "9 GB",
  kname: "nvme0n1",
  minBytes: "108 GB",
  haveBytes: "100 GB",
  needBytes: "108 GB",
  targets: "t0, t1",
  uuid: "1a2b",
  modalias: "pci:v00008086",
  kernel: "6.1.0-27-amd64",
  loader: "/boot/efi/EFI/debian/shimx64.efi",
  issuer: "UEFI CA",
  component: "shim",
  generation: 4,
  level: "shim,5",
  object: "f2",
  subject: "DKMS key",
  fs: "f2",
  feature: "nrext64",
  sizes: "512, 4096",
  md: "m0",
  have: 1,
  need: 2,
  lv: "root",
  unit: "md:md1",
  nic: "enp3s0",
  module: "ahci",
  partition: "d0p1",
  freeBytes: "1 TB",
  fromBytes: "50 GB",
  toBytes: "40 GB",
  sizeBytes: "260 MB",
  blockSize: 4096,
  sourceBlockSize: 1024,
  sectorSize: 4096,
  sourceSectorSize: 512,
  tokens: "systemd-tpm2",
  lvs: "vm-100-disk-0",
  restore: "9 GB",
  mount: "/",
  // The recovery ISO's report (docs/BAREMETAL.md 10.17, C-M4-6) and the wizard's hardware guide.
  issuers: "UEFI CA",
  modules: "ahci, nvme",
  recommended: "4 GB",
  layout: "de",
  kernels: "6.1.0-25-amd64",
  checks: "fstab, crypttab",
  model: "Samsung SSD 980",
  identity: "serial.S64",
  line: 3,
  volume: "c0",
  tokenTypes: "systemd-tpm2",
  array: "md0",
  oldName: "eno1",
  oldMac: "52:54:00:12:34:56",
  newMac: "52:54:00:65:43:21",
  phase: "Restoring files",
  rebuild: 2,
  folder: "/data/recovery-iso/import",
};

/** The planner's codes (agent/internal/baremetal/testdata/plan-codes.json, C-M2-6). */
const PLAN_CODES = JSON.parse(
  readFileSync(
    new URL("../../../../../agent/internal/baremetal/testdata/plan-codes.json", import.meta.url),
    "utf8",
  ),
) as { problems: string[]; warnings: string[] };

/** The codes, checks and hints of `restow-agent recover` (agent/internal/recovery/testdata, C-M4-6). */
const RECOVER_CODES = JSON.parse(
  readFileSync(
    new URL("../../../../../agent/internal/recovery/testdata/recover-codes.json", import.meta.url),
    "utf8",
  ),
) as {
  problems: string[];
  warnings: string[];
  checks: string[];
  hints: string[];
  hintParams: Record<string, string[]>;
};

/** The layout check's codes, as @restow/core lists them (`CHECK_FINDING_CODES`). */
const CHECK_CODES = (() => {
  const source = readFileSync(
    new URL("../../../../../packages/core/src/endpoints/baremetal/check.ts", import.meta.url),
    "utf8",
  );
  const list = /export const CHECK_FINDING_CODES = \[([\s\S]*?)\] as const/.exec(source)?.[1] ?? "";
  return [...list.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1] as string);
})();

describe("endpoints translations", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("has the same keys in German and English, and no empty text", () => {
    const enKeys = leaves(en as Tree)
      .map(([key]) => key)
      .sort();
    const deKeys = leaves(de as Tree)
      .map(([key]) => key)
      .sort();
    expect(deKeys).toEqual(enKeys);
    for (const [key, value] of [...leaves(en as Tree), ...leaves(de as Tree)]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("words every code a recovery can report, every check and every hint, in both languages", () => {
    const codes = [
      ...PLAN_CODES.problems,
      ...PLAN_CODES.warnings,
      ...RECOVER_CODES.problems,
      ...RECOVER_CODES.warnings,
    ];
    const placeholders = (text: string) =>
      [...new Set([...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((match) => match[1]))].sort();
    for (const tree of [en, de] as Tree[]) {
      const recovery = tree.recovery as Tree;
      const reported = recovery.reported as Record<string, string>;
      for (const code of codes) {
        expect(reported[code], code).toBeTruthy();
        // Finish warnings carry no parameters (C-M4-6): the ISO's message goes below the text.
        expect(placeholders(reported[code] as string), code).toEqual([]);
      }
      expect(Object.keys(reported).sort()).toEqual([...new Set(codes)].sort());
      const checks = (recovery.verification as Tree).checks as Record<string, string>;
      expect(Object.keys(checks).sort()).toEqual([...RECOVER_CODES.checks].sort());
      const hints = recovery.hints as Record<string, string>;
      expect(Object.keys(hints).sort()).toEqual([...RECOVER_CODES.hints].sort());
      for (const hint of RECOVER_CODES.hints) {
        expect(placeholders(hints[hint] as string), hint).toEqual(
          [...(RECOVER_CODES.hintParams[hint] ?? [])].sort(),
        );
      }
      const planCodes = ((tree.baremetal as Tree).plan as Tree).codes as Record<string, string>;
      for (const code of [...PLAN_CODES.problems, ...PLAN_CODES.warnings]) {
        expect(planCodes[code], code).toBeTruthy();
      }
    }
  });

  it("words every reason the server gives for not taking a reported success, in both languages", () => {
    // The list of @restow/core (the web app does not depend on it): both must name the same.
    const core = readFileSync(
      new URL(
        "../../../../../packages/core/src/endpoints/baremetal/verification.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const list = /SERVER_FINISH_WARNING_CODES = \[([^\]]+)\]/.exec(core)?.[1] ?? "";
    const serverCodes = [...list.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] as string);
    expect(serverCodes.length).toBeGreaterThan(0);
    expect([...RECOVERY_SERVER_WARNING_CODES]).toEqual(serverCodes);
    const reported = [
      ...PLAN_CODES.problems,
      ...PLAN_CODES.warnings,
      ...RECOVER_CODES.problems,
      ...RECOVER_CODES.warnings,
    ];
    for (const tree of [en, de] as Tree[]) {
      const texts = ((tree.recovery as Tree).serverReported as Tree).codes as Record<
        string,
        string
      >;
      expect(Object.keys(texts).sort()).toEqual([...serverCodes].sort());
      for (const code of serverCodes) {
        // The ISO cannot report one of them: no code of its own has the name.
        expect(reported).not.toContain(code);
        expect(texts[code], code).not.toMatch(/\{[a-zA-Z]+\}/);
      }
    }
  });

  it("has every key the feature's code names, in both languages", () => {
    const enKeys = new Set(leaves(en as Tree).map(([key]) => key));
    const deKeys = new Set(leaves(de as Tree).map(([key]) => key));
    // Guards the scan itself: it must actually find the feature's keys.
    expect(staticKeys().size).toBeGreaterThan(150);
    const missing = [...staticKeys()].filter((key) => !enKeys.has(key) || !deKeys.has(key));
    expect(missing).toEqual([]);
  });

  it("names the product through {appName}, never as a literal word", () => {
    for (const [key, value] of [...leaves(en as Tree), ...leaves(de as Tree)]) {
      // The folder the agent creates, the install location on macOS and the program
      // names are technical and stay literal.
      const prose = value
        .replace(/Restow-Restore/g, "")
        .replace(/\/Library\/Application Support\/Restow\b/g, "")
        .replace(/C:\\(?:Program Files|ProgramData)\\Restow\b/g, "");
      expect(prose, key).not.toMatch(/\bRestow\b/);
    }
    expect(i18n.t("endpoints:repositoryKey.title", { appName: "Acme Backup" })).toBe(
      "Restore without Acme Backup",
    );
  });

  it("drops the alpha and planned placeholders of the old section", () => {
    expect(en).not.toHaveProperty("alpha");
    expect(en).not.toHaveProperty("planned");
    expect(de).not.toHaveProperty("alpha");
    expect(JSON.stringify(en).toLowerCase()).not.toContain("not part of this release");
  });

  for (const language of ["en", "de"] as const) {
    it(`formats every ${language} text without leaving a placeholder or a tag behind`, async () => {
      await i18n.changeLanguage(language);
      try {
        for (const [key] of leaves(en as Tree)) {
          const text = String(i18n.t(`endpoints:${key}`, VALUES as never));
          expect(text, key).not.toBe(`endpoints:${key}`);
          expect(text, key).not.toMatch(/\{[a-zA-Z]+[,}]/);
          expect(text, key).not.toMatch(/<\/?[a-z]+>/);
        }
      } finally {
        await i18n.changeLanguage("en");
      }
    });
  }

  it("says Planned and Geplant for Windows and keeps Linux and macOS names", async () => {
    expect(i18n.t("endpoints:enroll.os.planned")).toBe("Planned");
    expect(i18n.t("endpoints:os.darwin")).toBe("macOS");
    await i18n.changeLanguage("de");
    try {
      expect(i18n.t("endpoints:enroll.os.planned")).toBe("Geplant");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("words every state the presenters can return", () => {
    const keys = [
      ...[
        "silent",
        "backup_overdue",
        "last_backup_failed",
        "restore_test_failed",
        "repository_damaged",
        "never_seen",
        "no_job",
      ].flatMap((a) => [`attention.${a}.label`, `attention.${a}.hint`, `attention.${a}.message`]),
      ...["running", "succeeded", "partial", "failed"].map((s) => `runStatus.${s}`),
      ...["backup", "restore", "verify_sample"].flatMap((k) => [`runKind.${k}`, `activity.${k}`]),
      ...["online", "offline", "never", "revoked"].map((s) => `status.${s}`),
      ...["green", "yellow", "red", "unverified", "no_backup"].map((s) => `readiness.state.${s}`),
      ...[
        "interrupted",
        "agent_stopped",
        "no_paths",
        "pre_hook_failed",
        "post_hook_failed",
        "timeout",
        "target_not_empty",
        "invalid_task",
        "hash_mismatch",
        "missing",
        "not_regular",
        "read_error",
        "restic_exit",
        "unknown",
      ].map((code) => `runErrors.${code}`),
      "runStatus.interrupted",
      ...[
        "resticBusy",
        "repositoryLocked",
        "repositoryUnavailable",
        "resticFailed",
        "resticUnavailable",
        "unsupportedOs",
        "revoked",
        "nothingToTest",
        "instanceUnknown",
        "queueNotReady",
        "pathNotFound",
        "tokenSettled",
      ].map((e) => `errors.${e}`),
    ];
    for (const key of keys) {
      expect(i18n.exists(`endpoints:${key}`, { lng: "en" }), key).toBe(true);
      expect(i18n.exists(`endpoints:${key}`, { lng: "de" }), key).toBe(true);
    }
  });

  it("words every code of the restore planner and of the layout check, in both languages", () => {
    expect(PLAN_CODES.problems.length).toBeGreaterThan(10);
    expect(CHECK_CODES.length).toBeGreaterThan(20);
    const keys = [
      ...[...PLAN_CODES.problems, ...PLAN_CODES.warnings].map(
        (code) => `baremetal.plan.codes.${code}`,
      ),
      ...CHECK_CODES.map((code) => `baremetal.check.findings.${code}`),
      ...["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"].map(
        (id) => `baremetal.check.items.${id}`,
      ),
      ...["same", "minimal", "other-controller"].map(
        (target) => `baremetal.check.targets.${target}`,
      ),
      ...[
        "planner_timeout",
        "planner_output_too_large",
        "planner_crashed",
        "planner_unavailable",
        "planner_refused_valid_manifest",
      ].map((reason) => `baremetal.check.incomplete.${reason}`),
      ...["ok", "warning", "failed", "skipped"].map((status) => `baremetal.check.status.${status}`),
      ...["green", "red", "yellow"].map((result) => `baremetal.check.result.${result}`),
      ...["unverified", "layout_checked", "red"].map((state) => `baremetal.states.${state}`),
      ...["unsupported", "arm64_later"].map((reason) => `baremetal.notPossible.${reason}`),
      "baremetal.unverifiedHint",
      "baremetal.incompleteHint",
      "baremetal.layoutCheckedHint",
      "baremetal.redHint",
    ];
    for (const key of keys) {
      expect(i18n.exists(`endpoints:${key}`, { lng: "en" }), key).toBe(true);
      expect(i18n.exists(`endpoints:${key}`, { lng: "de" }), key).toBe(true);
    }
  });
});
