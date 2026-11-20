/**
 * The end-to-end cases of the restore onto a fresh machine without an ISO
 * (docs/BAREMETAL-ONESHOT.md 19.3): a source machine of cases.mjs is backed up, a "fresh
 * machine" starts from a pinned cloud image with cloud-init (NoCloud seed disk) and runs the
 * command from Restow with its code from fw_cfg (`opt/restow/oneshot`) and an answers file
 * (`restow-oneshot-answers-v1`, confirmErase only); the driver releases or rejects the session
 * over the API and judges by the API and the serial console of the restored machine.
 *
 * The driver is run.mjs (`--cases O-E1,O-E2`, runOneshotCase); it runs O-E1 and O-E2 so far, the
 * other cases are definitions until their driver parts follow. `oneshot-cases.test.mjs` keeps the
 * definitions consistent with the source cases, the answers format of `restow-agent oneshot`, the
 * release body of the API and the identities recover uses. What each milestone needs before a
 * case can pass is in `needs` (O3: the command, O4: recover in oneshot mode, O5: the network
 * takeover and cloud-init, O7: UEFI to BIOS).
 *
 * The code reaches the fresh machine in its cloud-init seed, not over fw_cfg as for the ISO: the
 * Debian cloud kernel is not known to have qemu_fw_cfg, and the seed exists for this run only
 * (deleted with the case). The command runs exactly as an admin pastes it (`curl … | sh`), with
 * `--answers` and the test instance's CA.
 *
 * `fresh.network` is the network cloud-init gives the fresh machine; it is always different from
 * the source's. `kind: "static"` with `onlink: true` is the form of a Hetzner cloud server (a /32
 * with a gateway outside it). Its IPv6 part (a gateway on fe80::) stays out here: QEMU's user
 * network sends router advertisements, which would add a second IPv6 default route, and the
 * command refuses a machine with two (several_default_routes). The image keys name entries of
 * images.json (a null hash makes run.mjs refuse the case until `--pin-images` wrote it).
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

/** The network of a Hetzner-like cloud server, different from every source's (IPv4 only, see above). */
const HETZNER_LIKE = Object.freeze({
  kind: "static",
  address4: "10.0.2.15/32",
  gateway4: "10.0.2.2",
  onlink: true,
  dns4: "10.0.2.3",
});

/** The MAC of every fresh machine; the restored system starts with it too (the takeover binds to it). */
export const FRESH_MAC = "52:54:00:0e:2e:01";

export const ONESHOT_CASES = Object.freeze([
  {
    id: "O-E1",
    perPR: true,
    needs: ["O3", "O4", "O5"],
    title:
      "E2's source (Ubuntu 24.04, UEFI, LUKS2 and LVM, netplan) onto a Debian 12 cloud machine, UEFI, virtio-scsi, /32 with an on-link gateway",
    // The source's nginx and /etc/hosts naming its old address come with O6 (address search).
    source: { case: "E2" },
    fresh: {
      image: "debian12-genericcloud",
      firmware: "uefi",
      disks: [{ serial: "restow-oneshot-target0", size: GiB(24), bus: "scsi" }],
      network: HETZNER_LIKE,
    },
    release: { decision: "approve", networkMode: "takeover", remoteAccess: false },
    // The factory's sources have neither cloud-init nor sshd: 99-restow-restored.cfg and the
    // host keys are checked by the cases with a cloud image source (O-E4) and on real machines.
    expect: {
      result: "succeeded",
      kexec: "ok",
      checks: ["E2E-BOOT", "network-before-restore", "static-address"],
    },
  },
  {
    id: "O-E2",
    perPR: true,
    needs: ["O3", "O4", "O5"],
    title:
      "E1's source (Debian 12, BIOS, MBR, md RAID1 of two disks, systemd-networkd) onto a Debian 12 cloud machine with two disks, BIOS, DHCP",
    source: { case: "E1" },
    fresh: {
      image: "debian12-genericcloud",
      firmware: "bios",
      // Two disks: a oneshot restore maps the disks itself, and a disk of the backup it cannot
      // place fails the plan (the ISO case E1 names the missing one in its answers instead).
      disks: [
        { serial: "restow-oneshot-target0", size: GiB(12), bus: "virtio" },
        { serial: "restow-oneshot-target1", size: GiB(12), bus: "virtio" },
      ],
      network: { kind: "dhcp" },
    },
    release: { decision: "approve", networkMode: "takeover", remoteAccess: false },
    expect: { result: "succeeded", kexec: "ok", checks: ["E2E-BOOT", "network-before-restore"] },
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
 * The answers file of `restow-agent oneshot` for a case: the disks to erase, and the passphrase
 * of new LUKS volumes when the backup has any (the command refuses to go on without it,
 * passphrase_missing). The code comes over stdin, never in this file (a `code` key is refused).
 */
export function oneshotAnswers(testCase, { passphrase } = {}) {
  const needsPassphrase = Boolean(oneshotSource(testCase).passphrase);
  if (needsPassphrase && !passphrase) {
    throw new Error(`${testCase.id}: the source has LUKS, the answers need its passphrase`);
  }
  return {
    format: ONESHOT_ANSWERS_FORMAT,
    confirmErase: testCase.fresh.disks.map(freshIdentity).sort(),
    ...(needsPassphrase ? { passphrase } : {}),
  };
}

/**
 * The body the driver sends with the release (approveOneshotSchema of the api): the decisions
 * and the match code the session shows (`matchCode` of the recovery, as the admin reads it).
 */
export function releaseBody(testCase, matchCode) {
  const r = testCase.release;
  if (r.decision !== "approve") return null;
  if (!/^\d{3} ?\d{3}$/.test(matchCode ?? "")) {
    throw new Error(`${testCase.id}: no match code to release with (${matchCode})`);
  }
  return {
    matchCode,
    networkMode: r.networkMode,
    confirmShrink: false,
    secureBootWarningsOnly: false,
    remoteAccess: r.remoteAccess,
  };
}

/**
 * The network-config (version 2) cloud-init gives the fresh machine, bound to its MAC and named
 * eth0 there (set-name: every renderer, netplan or ifupdown, gets an interface that exists).
 */
export function freshNetworkConfig(network, mac = FRESH_MAC) {
  const match = { match: { macaddress: mac }, "set-name": "eth0" };
  if (network.kind === "dhcp") {
    return { version: 2, ethernets: { eth0: { ...match, dhcp4: true } } };
  }
  return {
    version: 2,
    ethernets: {
      eth0: {
        ...match,
        dhcp4: false,
        dhcp6: false,
        "accept-ra": false,
        addresses: [network.address4],
        routes: [
          {
            to: "0.0.0.0/0",
            via: network.gateway4,
            ...(network.onlink ? { "on-link": true } : {}),
          },
        ],
        nameservers: { addresses: [network.dns4] },
      },
    },
  };
}

/**
 * The script the fresh machine runs once cloud-init is done: the command as the admin pastes it,
 * unattended (`--answers`), trusting the test instance's CA, the ISO checked against the list
 * the run signed (RESTOW_SHA256SUMS_SHA256: the agent knows only the release key). Its output
 * goes to the serial console; a command that switches never comes back, so any
 * `E2E-ONESHOT-EXIT` line is a failure.
 */
export function freshCommandScript({ instanceUrl, sumsSha256 }) {
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(instanceUrl)) {
    throw new Error(`not an instance origin: ${instanceUrl}`);
  }
  if (!/^[0-9a-f]{64}$/.test(sumsSha256)) throw new Error("not a SHA-256 of SHA256SUMS");
  const dir = "/root/restow-oneshot";
  return [
    "#!/bin/sh",
    "# The oneshot end-to-end case (scripts/recovery-e2e): the command of the Restow UI, unattended.",
    `cd ${dir} || exit 1`,
    "{",
    '  echo "E2E-ONESHOT-START"',
    `  curl -fsSL --cacert ${dir}/ca.pem '${instanceUrl}/install/oneshot.sh' |`,
    `    RESTOW_ONESHOT_CODE="$(cat ${dir}/code)" RESTOW_CA_FILE=${dir}/ca.pem \\`,
    `    RESTOW_SHA256SUMS_SHA256=${sumsSha256} sh -s -- --answers ${dir}/answers.json`,
    '  echo "E2E-ONESHOT-EXIT $?"',
    "} >/dev/ttyS0 2>&1",
    "",
  ].join("\n");
}

/**
 * The NoCloud seed of a fresh machine (user-data, meta-data, network-config; JSON, which YAML
 * reads): the files of the command (code 0600, answers 0600, the instance's CA, the script) and
 * the network of the case. The seed holds the code: it lives in the case's folder of this run.
 */
export function freshSeed(testCase, { instanceUrl, code, caPem, sumsSha256, answers }) {
  if (!/^OS-[A-Z0-9-]+$/.test(code ?? "")) throw new Error(`${testCase.id}: not a oneshot code`);
  const dir = "/root/restow-oneshot";
  const file = (path, content, permissions) => ({ path, content, permissions, owner: "root:root" });
  const userData = {
    write_files: [
      file(`${dir}/code`, `${code}\n`, "0600"),
      file(`${dir}/answers.json`, `${JSON.stringify(answers)}\n`, "0600"),
      file(`${dir}/ca.pem`, caPem, "0644"),
      file(`${dir}/run.sh`, freshCommandScript({ instanceUrl, sumsSha256 }), "0700"),
    ],
    runcmd: [[`${dir}/run.sh`]],
  };
  return {
    "user-data": `#cloud-config\n${JSON.stringify(userData, null, 2)}\n`,
    "meta-data": `${JSON.stringify({ "instance-id": `restow-${testCase.id.toLowerCase()}`, "local-hostname": `fresh-${testCase.id.toLowerCase()}` })}\n`,
    "network-config": `${JSON.stringify(freshNetworkConfig(testCase.fresh.network), null, 2)}\n`,
  };
}

/** The `E2E-NET` line of a restored source (integrations/recovery/test/machines/lib.sh). */
export function netEvidence(text) {
  const lines = [...text.matchAll(/^E2E-NET before=(yes|no) static=(.*)$/gm)];
  const last = lines.at(-1);
  if (!last) return null;
  const statics = last[2].trim();
  return {
    before: last[1] === "yes",
    static: statics === "none" ? [] : statics.split(/\s+/).filter(Boolean),
  };
}

/** What a restored machine's console shows against the case's checks: the failures, if any. */
export function judgeOneshot(testCase, evidence) {
  const failures = [];
  const checks = testCase.expect.checks;
  if (!evidence) return ["the restored system printed no E2E-NET line"];
  if (checks.includes("network-before-restore") && !evidence.before) {
    failures.push(
      "the old network configuration was not put aside (/etc/restow/network-before-restore)",
    );
  }
  if (checks.includes("static-address")) {
    const want = testCase.fresh.network.address4;
    if (!evidence.static.includes(want)) {
      failures.push(
        `the active network configuration lacks ${want} of the fresh machine (has ${evidence.static.join(" ") || "none"})`,
      );
    }
  }
  return failures;
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
