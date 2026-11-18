/**
 * The end-to-end cases of the restore onto a fresh machine without an ISO
 * (docs/BAREMETAL-ONESHOT.md 19.3): a source machine of cases.mjs is backed up, a "fresh
 * machine" starts from a pinned cloud image with cloud-init (NoCloud seed disk) and runs the
 * command from Restow with its code from fw_cfg (`opt/restow/oneshot`) and an answers file
 * (`restow-oneshot-answers-v1`, confirmErase only); the driver releases or rejects the session
 * over the API and judges by the API and the serial console of the restored machine.
 *
 * These are the definitions only. The driver (run.mjs --oneshot) comes with O9; until then
 * `oneshot-cases.test.mjs` keeps the definitions consistent with the source cases, the answers
 * format of `restow-agent oneshot` and the identities recover uses. What each milestone needs
 * before a case can pass is in `needs` (O3: the command, O4: recover in oneshot mode, O5: the
 * network takeover and cloud-init, O7: UEFI to BIOS).
 *
 * `fresh.network` is the network cloud-init gives the fresh machine; it is always different from
 * the source's. `kind: "static"` with `onlink: true` is the form of a Hetzner cloud server (a /32
 * with a gateway outside it, IPv6 with fe80::/link-local gateway). The image keys name entries of
 * images.json that O9 adds pinned (a null hash makes run.mjs refuse the case until
 * `--pin-images` wrote it, as for E3 to E6b).
 *
 * The test instance signs its checksums with a key made for the run, never the release key, so
 * the command runs with RESTOW_SHA256SUMS_SHA256 set to the hash of the list the driver signed.
 */

import { CASES } from "./cases.mjs";

/** The answers format of `restow-agent oneshot --answers` (agent/internal/oneshot/answers.go). */
export const ONESHOT_ANSWERS_FORMAT = "restow-oneshot-answers-v1";

/**
 * What a fresh machine starts from: cloud images (keys of images.json, pinned in O9) and
 * `rescue-iso`, the recovery ISO itself with restow-recover masked, standing in for a
 * provider's rescue system (17.1).
 */
export const FRESH_IMAGES = Object.freeze([
  "debian12-genericcloud",
  "ubuntu2404-cloud",
  "rescue-iso",
]);

/** Cloud images of sources that cases.mjs does not have yet (pinned in O9). */
export const SOURCE_IMAGES = Object.freeze(["ubuntu2204-cloud"]);

const GiB = (n) => `${n}G`;

const source = (id) => {
  const found = CASES.find((item) => item.id === id);
  if (!found) throw new Error(`oneshot case: no source case ${id}`);
  return found.source;
};

/** The network of a Hetzner-like cloud server, different from every source's. */
const HETZNER_LIKE = Object.freeze({
  kind: "static",
  address4: "10.0.2.15/32",
  gateway4: "10.0.2.2",
  onlink: true,
  address6: "fd00:e2e::15/64",
  gateway6: "fe80::2",
});

export const ONESHOT_CASES = Object.freeze([
  {
    id: "O-E1",
    perPR: true,
    needs: ["O3", "O4", "O5"],
    title:
      "E2's source (Ubuntu 24.04, UEFI, LUKS2 and LVM, netplan) onto a Debian 12 cloud machine, UEFI, virtio-scsi, /32 with an on-link gateway",
    source: { case: "E2", extras: ["nginx-old-address", "hosts-old-address"] },
    fresh: {
      image: "debian12-genericcloud",
      firmware: "uefi",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(24), bus: "scsi" }],
      network: HETZNER_LIKE,
    },
    release: { decision: "approve", networkMode: "takeover", remoteAccess: false },
    expect: {
      result: "succeeded",
      kexec: "ok",
      checks: [
        "E2E-BOOT",
        "netplan-onlink",
        "network-before-restore",
        "cloud-init-restored-cfg",
        "ssh-host-keys-unchanged",
      ],
    },
  },
  {
    id: "O-E2",
    perPR: true,
    needs: ["O3", "O4", "O5"],
    title:
      "E1's source (Debian 12, BIOS, MBR, md RAID1, ifupdown) onto a Debian 12 cloud machine, BIOS, DHCP",
    source: { case: "E1" },
    fresh: {
      image: "debian12-genericcloud",
      firmware: "bios",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(12), bus: "virtio" }],
      network: { kind: "dhcp" },
    },
    release: { decision: "approve", networkMode: "takeover", remoteAccess: false },
    expect: { result: "succeeded", kexec: "ok", checks: ["E2E-BOOT", "ifupdown-dhcp"] },
  },
  {
    id: "O-E3",
    perPR: false,
    needs: ["O3"],
    title:
      "Ubuntu 24.04 cloud machine with Secure Boot (Microsoft keys): the test load is refused, nothing changes",
    source: { case: "E2" },
    fresh: {
      image: "ubuntu2404-cloud",
      firmware: "uefi-sb",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(24), bus: "virtio" }],
      network: { kind: "dhcp" },
    },
    // No release: the command ends before it asks for one.
    release: { decision: "none" },
    expect: {
      result: "pending_approval",
      kexec: "failed",
      commandExit: 3,
      checks: ["disk-unchanged", "fallback-named"],
    },
  },
  {
    id: "O-E4",
    perPR: false,
    needs: ["O3", "O4", "O5"],
    title:
      "Ubuntu 22.04 cloud machine, UEFI, hybrid GPT, onto a Debian 12 cloud machine in BIOS mode",
    // A cloud image source of its own: Ubuntu's images carry a BIOS boot partition next to
    // the ESP (hybrid GPT), which the switch to BIOS needs.
    source: {
      kind: "cloud",
      image: "ubuntu2204-cloud",
      firmware: "uefi",
      hybridGpt: true,
      disks: [{ serial: "e2e-src0", size: GiB(12), bus: "virtio" }],
    },
    fresh: {
      image: "debian12-genericcloud",
      firmware: "bios",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(16), bus: "virtio" }],
      network: HETZNER_LIKE,
    },
    release: { decision: "approve", networkMode: "takeover", remoteAccess: false },
    expect: { result: "succeeded", kexec: "ok", checks: ["E2E-BOOT", "grub-i386-pc"] },
  },
  {
    id: "O-E5",
    perPR: false,
    needs: ["O3"],
    title:
      "Like O-E1, the admin rejects the release: nothing changes, the machine starts as before",
    source: { case: "E2" },
    fresh: {
      image: "debian12-genericcloud",
      firmware: "uefi",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(24), bus: "scsi" }],
      network: HETZNER_LIKE,
    },
    release: { decision: "reject" },
    expect: {
      result: "rejected",
      kexec: "ok",
      commandExit: 4,
      checks: ["disk-unchanged", "boots-as-before"],
    },
  },
  {
    id: "O-E6",
    perPR: false,
    needs: ["O3", "O4"],
    title:
      "E1's source onto a machine started from a rescue system (the ISO with restow-recover masked), kexec from there",
    source: { case: "E1" },
    fresh: {
      image: "rescue-iso",
      firmware: "bios",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(12), bus: "virtio" }],
      network: { kind: "dhcp" },
      rescue: true,
    },
    release: { decision: "approve", networkMode: "keep", remoteAccess: false },
    expect: { result: "succeeded", kexec: "ok", checks: ["E2E-BOOT"] },
  },
]);

/** The source machine of a oneshot case: a source of cases.mjs, or one of its own. */
export function oneshotSource(testCase) {
  return testCase.source.case ? source(testCase.source.case) : testCase.source;
}

/**
 * The identity recover and the command give a disk of a fresh machine (recovery.Identity):
 * `serial.<serial>`, with the namespace for NVMe (the same rule as run.mjs identityOf).
 */
export function freshIdentity(disk) {
  if (disk.bus === "nvme") return `serial.${disk.serial}-1`;
  return `serial.${disk.serial}`;
}

/**
 * The answers file of `restow-agent oneshot` for a case: only the disks to erase. The code
 * comes over stdin, never in this file (the command refuses a `code` key).
 */
export function oneshotAnswers(testCase) {
  return {
    format: ONESHOT_ANSWERS_FORMAT,
    confirmErase: testCase.fresh.disks.map(freshIdentity).sort(),
  };
}

/** The body the driver sends with the release (approveOneshotSchema of the api). */
export function releaseBody(testCase) {
  const r = testCase.release;
  if (r.decision !== "approve") return null;
  return {
    networkMode: r.networkMode,
    confirmShrink: false,
    secureBootWarningsOnly: false,
    remoteAccess: r.remoteAccess,
  };
}

/** The cases of a run: `per-pr`, `nightly`, `all` or a comma-separated list of ids. */
export function selectOneshotCases(filter, cases = ONESHOT_CASES) {
  const wanted = (filter ?? "per-pr").trim();
  if (wanted === "per-pr") return cases.filter((item) => item.perPR);
  if (wanted === "nightly") return cases.filter((item) => !item.perPR);
  if (wanted === "all") return [...cases];
  const ids = wanted
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const known = new Map(cases.map((item) => [item.id.toLowerCase(), item]));
  const unknown = ids.filter((id) => !known.has(id.toLowerCase()));
  if (unknown.length > 0 || ids.length === 0) {
    throw new Error(
      `unknown oneshot case ${unknown.join(", ") || "(none given)"}; known: ${cases.map((item) => item.id).join(", ")}`,
    );
  }
  return ids.map((id) => known.get(id.toLowerCase()));
}
