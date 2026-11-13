#!/usr/bin/env node
/**
 * The end-to-end tests of the bare metal restore (docs/BAREMETAL.md 21.2) in QEMU/KVM:
 *
 *   1. start a test instance like the release smoke (scripts/smoke), with
 *      RESTOW_BAREMETAL_PREVIEW on and an agent folder whose SHA256SUMS lists the ISO under
 *      test, signed with a key made for this run only (never a release key);
 *   2. build the source machine: the test machine factory of the recovery ISO
 *      (integrations/recovery/test/machines, run inside a VM booted from the ISO) or a pinned
 *      cloud image (images.json); it enrolls with a one-time token through fw_cfg;
 *   3. back it up with a whole machine job and wait for the layout check;
 *   4. issue a recovery code (a fresh sign-in), boot the ISO on new disks with the answers
 *      through fw_cfg (opt/restow/answers), release the session over the API and wait for
 *      its end, which the driver judges by the API alone;
 *   5. boot the restored disks on another controller and expect
 *      "E2E-BOOT <hostname> <sha256 of the marker>" on the serial console.
 *
 * The boot probe cases (P1 to P3, cases.mjs) replace 4 and 5 with the recovery lab: its
 * container (the image of this checkout, Dockerfile target lab) runs next to the test instance
 * with /dev/kvm, "Probe now" plans the probe, and the machine's bare metal state and its newest
 * probe report must say what the case expects (docs/BAREMETAL.md 12.3).
 *
 *   node scripts/recovery-e2e/run.mjs --iso <iso> --agent-dist <dir> [--cases per-pr|nightly|all|E1,E2]
 *
 * Needs KVM, qemu-system-x86_64, qemu-img, OVMF and virt-fw-vars (python3-virt-firmware),
 * Docker with compose, ssh-keygen and Node 22. See --help.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";
import { CASES, PROBE_CASES, selectCases } from "./cases.mjs";
import { factoryDebs } from "./factory-debs.mjs";
import {
  assertKvm,
  createDisk,
  createVars,
  qmp,
  sendKeys,
  startMachine,
  waitForSerial,
} from "./lib/qemu.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const FACTORY = join(repoRoot, "integrations/recovery/test/machines");

export const USAGE = `Usage: node scripts/recovery-e2e/run.mjs --iso <iso> --agent-dist <dir> [options]

  --iso FILE          the recovery ISO under test (restow-recovery_<v>_amd64.iso)
  --agent-dist DIR    the agent build the ISO was made from (the folder with linux-amd64/)
  --version V         its version (default: read from the ISO's file name)
  --cases LIST        per-pr (E1, E2; default), nightly (the others), all, or ids: E1,E7
  --work-dir DIR      disks, logs and the test instance (default: recovery-e2e-out)
  --image REF         the application image of the test instance (default: built like the smoke)
  --web-image REF     its web edge image
  --dbx FILE          the current DBX update for the Secure Boot variable store (virt-fw-vars)
  --lab-image REF     the recovery lab image of the probe cases (default: built from this checkout)
  --keep              leave the test instance running afterwards
  --pin-images        download the cloud images of images.json and print their SHA-256 (by hand)
  --help
`;

export function parseArgs(argv) {
  const options = { cases: "per-pr", workDir: "recovery-e2e-out", keep: false, pinImages: false };
  const value = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
    return next;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    switch (flag) {
      case "--iso":
        options.iso = value(index++, flag);
        break;
      case "--agent-dist":
        options.agentDist = value(index++, flag);
        break;
      case "--version":
        options.version = value(index++, flag);
        break;
      case "--cases":
        options.cases = value(index++, flag);
        break;
      case "--work-dir":
        options.workDir = value(index++, flag);
        break;
      case "--image":
        options.image = value(index++, flag);
        break;
      case "--web-image":
        options.webImage = value(index++, flag);
        break;
      case "--dbx":
        options.dbx = value(index++, flag);
        break;
      case "--lab-image":
        options.labImage = value(index++, flag);
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--pin-images":
        options.pinImages = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  if (!options.help && !options.pinImages) {
    if (!options.iso) throw new Error("--iso <file> is needed");
    if (!options.agentDist) throw new Error("--agent-dist <dir> is needed");
    options.version ??= versionOfIso(options.iso);
  }
  // Fails early on a typo in --cases.
  options.selected = options.help || options.pinImages ? [] : selectCases(options.cases);
  return options;
}

/** The version in restow-recovery_<v>_amd64.iso. */
export function versionOfIso(file) {
  const match = /^restow-recovery_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_amd64\.iso$/.exec(
    basename(file),
  );
  if (!match)
    throw new Error(`${basename(file)} is not restow-recovery_<version>_amd64.iso; pass --version`);
  return match[1];
}

/**
 * The address the guests use for the test instance: a name that resolves to 10.0.2.2, QEMU's
 * address of the host, on the port the edge publishes there. The edge gets a certificate of its
 * own CA for it (RESTOW_EDGE_TLS=internal); the ISO pins its key (spkiCheck), the source
 * machines trust the CA.
 */
export function guestInstanceUrl(httpsPort) {
  return `https://restow-e2e.10.0.2.2.nip.io:${httpsPort}`;
}

/**
 * The identity of a QEMU disk as the ISO sees it (C-M4-4), derived like recovery.Identity in
 * agent/internal/recovery/hardware.go: an NVMe namespace by its EUI-64 (eui.<hex>, set
 * explicitly in lib/qemu.mjs), every other disk of the cases by its serial number
 * (serial.<serial>; QEMU gives them no WWN). The shared fixture
 * agent/internal/recovery/testdata/hw/qemu-e2e.json pins both sides.
 */
export function identityOf(disk) {
  if (disk.bus === "nvme") {
    if (!/^[0-9a-f]{16}$/.test(disk.eui64 ?? ""))
      throw new Error(`NVMe disk ${disk.serial} needs eui64`);
    return `eui.${disk.eui64}`;
  }
  return `serial.${disk.serial}`;
}

/**
 * The answers file of a case (restow-answers-v1, C-M4-4). Only the keys the format knows: the
 * ISO refuses any other. The code, the passphrase and the rebind token may come in only this
 * way, through fw_cfg of a QEMU machine.
 */
export function buildAnswers(testCase, context) {
  const answers = {
    format: "restow-answers-v1",
    instanceUrl: context.instanceUrl,
    code: context.code,
    snapshotId: context.snapshotId,
    keymap: testCase.answers.keymap ?? "us",
    language: "en",
    network: { mode: "dhcp" },
    diskMapping: testCase.answers.diskMapping ?? "auto",
    adopt: testCase.answers.adopt ?? [],
    shrink: "none",
    keyFiles: "regenerate",
    confirmErase: [...testCase.target.disks.map(identityOf), ...(testCase.eraseAlso ?? [])].sort(),
    renameNics: true,
    rawLvs: "skip",
    secureBootOff: false,
    afterSuccess: "poweroff",
  };
  if (context.spkiCheck) answers.spkiCheck = context.spkiCheck;
  if (context.passphrase) answers.passphrase = context.passphrase;
  if (context.rebindToken) answers.rebindToken = context.rebindToken;
  return answers;
}

/** The serial line a restored machine prints after its start (C-M4-7). */
export function bootPattern(hostname, markerSha256) {
  const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`E2E-BOOT ${escaped} ${markerSha256}\\b`);
}

/** The marker line of a source machine: hostname and the SHA-256 of its marker file. */
export const SOURCE_BOOT = /E2E-BOOT (\S+) ([0-9a-f]{64})/;

/** Add the ISO's line to an agent release's SHA256SUMS (C-M4-3), once. */
export function withIsoLine(sums, fileName, sha256) {
  const lines = sums
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith(` recovery/${fileName}`));
  lines.push(`${sha256}  recovery/${fileName}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The kernel command line of a factory VM: the ISO's live system without the recovery
 * program, running the factory script from the read-only disk RESTOWFACTORY once, then off.
 * /run is an empty tmpfs at start: the mount point is made first.
 */
export function factoryCmdline() {
  return [
    "boot=live",
    "components",
    "noswap",
    "nopersistence",
    "console=ttyS0,115200n8",
    "systemd.mask=restow-recover.service",
    "systemd.run=\"/usr/bin/sh -c 'mkdir -p /run/restow-factory && mount -o ro /dev/disk/by-label/RESTOWFACTORY /run/restow-factory && exec sh /run/restow-factory/run.sh'\"",
    "systemd.run_success_action=poweroff",
    "systemd.run_failure_action=poweroff",
  ].join(" ");
}

/**
 * The settings of the test instance for the boot probe cases among `selected`: the lab's token,
 * image and /dev/kvm group, and the restore limit a case asks for. Empty without probe cases.
 */
export function labEnv(selected, { token, kvmGid, image }) {
  const probes = selected.filter((item) => item.probe);
  if (probes.length === 0) return {};
  const limits = probes.map((item) => item.probe.maxRestoreGiB).filter((v) => v !== undefined);
  return {
    RESTOW_LAB_TOKEN: token,
    RESTOW_LAB_IMAGE: image,
    RESTOW_LAB_KVM_GID: String(kvmGid),
    ...(limits.length > 0 ? { RESTOW_LAB_MAX_RESTORE_GIB: String(Math.min(...limits)) } : {}),
  };
}

/**
 * Whether the machine's bare metal state shows the end of the probe the case asked for at
 * `requestedAt`: null while it runs, else `{ ok, reason }` judged against the case.
 */
export function probeOutcome(testCase, state, requestedAt) {
  const latest = state.probe?.latest;
  if (!latest || Date.parse(latest.checkedAt) < requestedAt || state.probe?.pending) return null;
  const expect = testCase.probe;
  const cause = latest.cause ?? {};
  const said = `state ${state.state}, probe ${latest.readiness ?? "without a rating"} (${cause.kind ?? latest.notPossible ?? "?"}${cause.reason ? `: ${cause.reason}` : ""}${cause.pattern ? `: ${cause.pattern}` : ""})`;
  if (expect.expect === "green") {
    const empty = (expect.emptyDirs ?? []).filter((dir) => !latest.emptyDirs.includes(dir));
    if (state.state !== "green" || latest.readiness !== "green" || cause.kind !== "booted") {
      return { ok: false, reason: `expected green: ${said}` };
    }
    if (empty.length > 0) return { ok: false, reason: `not left empty: ${empty.join(", ")}` };
    return { ok: true, reason: said };
  }
  if (state.state !== "red" || latest.readiness !== "red") {
    return { ok: false, reason: `expected red: ${said}` };
  }
  if (expect.pattern && cause.pattern !== expect.pattern) {
    return { ok: false, reason: `expected the pattern ${expect.pattern}: ${said}` };
  }
  return { ok: true, reason: said };
}

/** The status of a recovery the API reports, until it leaves the running states. */
export function isFinal(status) {
  return ["succeeded", "failed", "cancelled", "expired", "revoked"].includes(status);
}

// ---------------------------------------------------------------------------------------------
// The run (needs KVM, Docker; the parts above are pure and tested)
// ---------------------------------------------------------------------------------------------

function sh(command, args, options = {}) {
  return execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], ...options })
    .toString("utf8")
    .trim();
}

async function runAsync(command, args) {
  sh(command, args);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * The agent folder of the test instance: the build, its SHA256SUMS with the ISO's line, signed
 * with an Ed25519 key made here and deleted right after (only its public half stays, as the
 * instance's release-signing.pub), and the install scripts of this checkout.
 */
export function testAgentDir({ agentDist, iso, version, dir }) {
  const release = join(dir, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(release, { recursive: true });
  cpSync(agentDist, release, { recursive: true });
  const sumsFile = join(release, "SHA256SUMS");
  const sums = existsSync(sumsFile) ? readFileSync(sumsFile, "utf8") : "";
  writeFileSync(sumsFile, withIsoLine(sums, basename(iso), sha256File(iso)));
  const key = join(dir, "ephemeral-signing-key");
  sh("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "restow-e2e-test-only", "-f", key]);
  try {
    sh("ssh-keygen", ["-q", "-Y", "sign", "-f", key, "-n", "restow-agent-release", sumsFile]);
  } finally {
    rmSync(key, { force: true });
  }
  copyFileSync(`${key}.pub`, join(dir, "release-signing.pub"));
  rmSync(`${key}.pub`, { force: true });
  cpSync(join(repoRoot, "agent/install"), join(dir, "install"), { recursive: true });
  return dir;
}

/** The SPKI SHA-256 of the edge's certificate, as the ISO will see it (RESTOW_PUBLIC_TLS_SPKI). */
async function measureSpki(port, servername) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(
      { host: "127.0.0.1", port, servername, rejectUnauthorized: false },
      () => {
        const certificate = socket.getPeerX509Certificate();
        socket.end();
        if (!certificate) return reject(new Error("the edge sent no certificate"));
        const der = certificate.publicKey.export({ type: "spki", format: "der" });
        resolvePromise(createHash("sha256").update(der).digest("hex"));
      },
    );
    socket.on("error", reject);
  });
}

/** The test instance: the smoke's stack with the preview, the test agent folder and the guest address. */
async function startInstance(options, workDir, agentDir) {
  const { Stack } = await import("../smoke/lib/stack.mjs");
  const { setUpInstallation } = await import("../smoke/lib/restow.mjs");
  const stack = new Stack({
    repoRoot,
    dir: join(workDir, "instance"),
    project: "restow-recovery-e2e",
    portBase: 39300,
    tag: options.image ? "external" : "recovery-e2e",
  });
  const host = new URL(guestInstanceUrl(stack.ports.https)).hostname;
  stack.publicUrl = guestInstanceUrl(stack.ports.https);
  stack.writeFiles();
  // The boot probe cases: the lab's token and image, the group of /dev/kvm on this host.
  const lab = labEnv(options.selected, {
    token: randomBytes(32).toString("hex"),
    kvmGid: options.selected.some((item) => item.probe) ? sh("stat", ["-c", "%g", "/dev/kvm"]) : 0,
    image: options.labImage ?? "restow-lab:recovery-e2e",
  });
  if (lab.RESTOW_LAB_TOKEN && !options.labImage) {
    sh("docker", [
      "buildx",
      "build",
      "--load",
      "--target",
      "lab",
      "-t",
      "restow-lab:recovery-e2e",
      repoRoot,
    ]);
  }
  const overlay = join(stack.dir, "docker-compose.recovery-e2e.yml");
  writeFileSync(
    overlay,
    [
      "# The recovery end-to-end overlay (scripts/recovery-e2e/run.mjs): the test agent folder.",
      "services:",
      "  api:",
      "    volumes:",
      `      - ${agentDir}:/srv/agent:ro`,
      "  worker:",
      "    volumes:",
      `      - ${agentDir}:/srv/agent:ro`,
      "",
    ].join("\n"),
  );
  const composeArgs = stack.composeArgs.bind(stack);
  stack.composeArgs = (args) => {
    const base = composeArgs([]);
    return [...base, "-f", overlay, ...args];
  };
  stack.addEnv({
    RESTOW_PUBLIC_URL: stack.publicUrl,
    RESTOW_APP_DOMAIN: host,
    RESTOW_EDGE_TLS: "internal",
    RESTOW_BAREMETAL_PREVIEW: "true",
    ...lab,
    ...(options.image ? { RESTOW_IMAGE: options.image, RESTOW_UPDATER_IMAGE: options.image } : {}),
    ...(options.webImage ? { RESTOW_WEB_IMAGE: options.webImage } : {}),
  });
  if (!options.image) {
    sh("docker", [
      "buildx",
      "build",
      "--load",
      "--target",
      "runtime",
      "-t",
      "restow-smoke/app:recovery-e2e",
      repoRoot,
    ]);
    sh("docker", [
      "buildx",
      "build",
      "--load",
      "--target",
      "web",
      "-t",
      "restow-smoke/web:recovery-e2e",
      repoRoot,
    ]);
  }
  await stack.up();
  await stack.waitForApi();
  // The ISO pins the edge's key; the source machines trust its CA.
  stack.addEnv({ RESTOW_PUBLIC_TLS_SPKI: await measureSpki(stack.ports.https, host) });
  await stack.up(["api"], { forceRecreate: true });
  await stack.waitForApi();
  const caFile = join(workDir, "instance-ca.pem");
  const ca = await stack.compose([
    "exec",
    "-T",
    "caddy",
    "cat",
    "/data/caddy/pki/authorities/local/root.crt",
  ]);
  writeFileSync(caFile, ca.stdout);
  const setup = await setUpInstallation(stack);
  if (lab.RESTOW_LAB_TOKEN) {
    // The worker opens its lab API with the token; the lab asks it for work from now on.
    await stack.up(["worker", "recovery-lab"], { forceRecreate: true });
  }
  const { listTenants, ownOrganisationOf } = await import("../smoke/lib/restow.mjs");
  const tenant = ownOrganisationOf(await listTenants(setup.api));
  if (!tenant) throw new Error("the setup created no own organisation");
  return { stack, caFile, tenantId: tenant.id, ...setup };
}

/** What the factory installs into the live overlay with dpkg (lib.sh factory_prepare). */
export const FACTORY_ROOTS = ["debootstrap"];
/** The archive keyrings of the factory disk (keyrings/), installed with the rest. */
export const FACTORY_KEYRINGS = ["debian-archive-keyring", "ubuntu-keyring"];
/** apt-cache depends limited to what dpkg -i checks: Depends and Pre-Depends. */
const APT_DEPENDS_ONLY =
  "--no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances";

/**
 * run.sh of the factory disk: the settings of the case, then the network (the factory starts
 * right after sysinit, before it is up, and debootstrap needs it), then the machine script,
 * then the marker run.mjs waits for.
 */
export function factoryRunScript({ mirror, passphrase, env, script }) {
  return [
    "#!/bin/sh",
    "set -eu",
    `export FACTORY_MIRROR='${mirror}'`,
    passphrase ? `export FACTORY_PASSPHRASE='${passphrase}'` : "",
    ...Object.entries(env ?? {}).map(
      ([name, value]) => `export ${name}='${String(value).replace(/'/g, "")}'`,
    ),
    "systemctl start --no-block systemd-networkd.service systemd-resolved.service",
    "/usr/lib/systemd/systemd-networkd-wait-online --any --timeout=180 ||",
    "  { echo 'factory: no network after 180 s' >/dev/ttyS0; exit 1; }",
    `sh /run/restow-factory/${script} >/dev/ttyS0 2>&1`,
    "echo E2E-FACTORY-DONE >/dev/ttyS0",
    "",
  ].join("\n");
}

/** The read-only factory disk: the machine scripts, run.sh and the debootstrap packages. */
function factoryDisk(workDir, testCase, context) {
  const tree = join(workDir, `${testCase.id}-factory`);
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(join(tree, "debs"), { recursive: true });
  mkdirSync(join(tree, "keyrings"), { recursive: true });
  for (const file of readdirSync(FACTORY)) copyFileSync(join(FACTORY, file), join(tree, file));
  copyFileSync(context.caFile, join(tree, "ca.pem"));
  const snapshot = readFileSync(join(repoRoot, "integrations/recovery/snapshot.env"), "utf8");
  const stamp = /^SNAPSHOT_TIMESTAMP=(\S+)$/m.exec(snapshot)?.[1];
  const image = /^DEBIAN_IMAGE_DIGEST=(\S+)$/m.exec(snapshot)?.[1];
  // debootstrap with what it needs that the ISO lacks (factory-debs.mjs) and the keyrings,
  // from the ISO's own snapshot, in its build container.
  const apt = [
    `printf 'deb http://snapshot.debian.org/archive/debian/${stamp}/ trixie main\\n' >/etc/apt/sources.list`,
    "rm -f /etc/apt/sources.list.d/debian.sources",
    "apt-get -o Acquire::Check-Valid-Until=false update >/dev/null",
  ];
  const depends = sh("docker", [
    "run",
    "--rm",
    image,
    "sh",
    "-c",
    [...apt, `apt-cache depends --recurse ${APT_DEPENDS_ONLY} ${FACTORY_ROOTS.join(" ")}`].join(
      " && ",
    ),
  ]);
  const lock = readFileSync(join(repoRoot, "integrations/recovery/packages.lock"), "utf8");
  const debs = factoryDebs(depends, lock, FACTORY_ROOTS);
  const download = [...new Set([...debs, ...FACTORY_KEYRINGS])].sort();
  sh("docker", [
    "run",
    "--rm",
    "-v",
    `${tree}:/out`,
    image,
    "sh",
    "-c",
    [
      ...apt,
      `cd /out/debs && apt-get download ${download.join(" ")}`,
      "dpkg-deb -x ubuntu-keyring_*.deb /tmp/u && cp /tmp/u/usr/share/keyrings/ubuntu-archive-keyring.gpg /out/keyrings/",
      "dpkg-deb -x debian-archive-keyring_*.deb /tmp/d && cp /tmp/d/usr/share/keyrings/debian-archive-keyring.gpg /out/keyrings/",
    ].join(" && "),
  ]);
  const mirror =
    testCase.source.mirror === "ubuntu"
      ? "http://archive.ubuntu.com/ubuntu"
      : `http://snapshot.debian.org/archive/debian/${stamp}/`;
  writeFileSync(
    join(tree, "run.sh"),
    factoryRunScript({
      mirror,
      passphrase: context.passphrase,
      env: testCase.source.env,
      script: testCase.source.script,
    }),
  );
  const disk = join(workDir, `${testCase.id}-factory.img`);
  sh("truncate", ["-s", "512M", disk]);
  sh("mkfs.ext4", ["-q", "-F", "-L", "RESTOWFACTORY", "-d", tree, disk]);
  return disk;
}

async function api(context) {
  const { signIn } = await import("../smoke/lib/restow.mjs");
  return signIn(context.stack, context.totpSecret);
}

async function waitUntil(what, check, { timeoutMs, intervalMs = 5000 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Build, enroll and back up the source machine; answers what the restore is checked against. */
async function sourceMachine(testCase, context) {
  const dir = join(context.workDir, testCase.id);
  mkdirSync(dir, { recursive: true });
  const disks = testCase.source.disks.map((disk) => ({
    ...disk,
    file: join(dir, `${disk.serial}.qcow2`),
  }));
  for (const disk of disks) await createDisk(runAsync, disk.file, disk.size);
  const varsFile = testCase.source.firmware === "bios" ? undefined : join(dir, "source-vars.fd");
  if (varsFile) await createVars(runAsync, varsFile, testCase.source.firmware, context.dbx);
  const client = await api(context);
  const tenantId = context.tenantId;
  if (testCase.source.kind === "factory") {
    const kernel = join(dir, "vmlinuz");
    const initrd = join(dir, "initrd.img");
    sh("xorriso", ["-osirrox", "on", "-indev", context.iso, "-extract", "/live/vmlinuz", kernel]);
    sh("xorriso", [
      "-osirrox",
      "on",
      "-indev",
      context.iso,
      "-extract",
      "/live/initrd.img",
      initrd,
    ]);
    const factory = factoryDisk(context.workDir, testCase, context);
    // Direct kernel boot of the ISO's live system with the factory command line.
    const build = startMachine({
      name: `${testCase.id}-factory`,
      firmware: "bios",
      disks,
      cdrom: context.iso,
      extraDisks: [factory],
      serialLog: join(dir, "factory.log"),
      qmpSocket: join(dir, "factory.qmp"),
      kernel: { file: kernel, initrd, append: factoryCmdline() },
    });
    await waitForSerial(join(dir, "factory.log"), /E2E-FACTORY-DONE/, {
      timeoutMs: 40 * 60_000,
      machine: build,
    });
    await build.exited;
  } else {
    throw new Error(
      `${testCase.id}: cloud image sources (${testCase.source.image}) need a pinned image; see images.json`,
    );
  }
  const token = await client.post(
    "/api/v1/endpoints/tokens",
    { profile: "server", os: "linux", displayName: `e2e-${testCase.id}` },
    { tenantId },
  );
  const enroll = join(dir, "enroll.txt");
  writeFileSync(enroll, `url=${context.instanceUrl}\ntoken=${token.token}\n`, { mode: 0o600 });
  const source = startMachine({
    name: `${testCase.id}-source`,
    firmware: testCase.source.firmware,
    varsFile,
    disks,
    serialLog: join(dir, "source.log"),
    qmpSocket: join(dir, "source.qmp"),
    fwCfg: { "opt/restow/enroll": enroll },
  });
  if (testCase.source.unlockAtBoot) {
    await waitForSerial(join(dir, "source.log"), /Enter passphrase/, {
      timeoutMs: 10 * 60_000,
      machine: source,
    });
    await sendKeys(join(dir, "source.qmp"), `${context.passphrase}\n`);
  }
  const [, hostname, markerSha256] = await waitForSerial(join(dir, "source.log"), SOURCE_BOOT, {
    timeoutMs: 15 * 60_000,
    machine: source,
  });
  const endpoint = await waitUntil(
    "the source machine to enroll",
    async () =>
      (await client.get("/api/v1/endpoints", { tenantId })).items.find(
        (item) => item.hostname === hostname,
      ),
    { timeoutMs: 10 * 60_000 },
  );
  const job = await client.post(
    "/api/v1/backup-jobs",
    {
      kind: "endpoint",
      name: `Recovery ${testCase.id}`,
      schedule: { kind: "daily", timeOfDay: "03:00", timeZone: "UTC" },
      settings: { wholeMachine: true },
      scope: { mode: "selected", members: [{ id: endpoint.id }] },
    },
    { tenantId },
  );
  await client.post(`/api/v1/endpoints/${endpoint.id}/tasks`, { kind: "backup" }, { tenantId });
  const baremetal = await waitUntil(
    "the whole machine backup and its layout check",
    async () => {
      const state = await client.get(`/api/v1/endpoints/${endpoint.id}/baremetal`, { tenantId });
      return state.check && state.latest?.snapshotId ? state : null;
    },
    { timeoutMs: 60 * 60_000, intervalMs: 15_000 },
  );
  await qmp(join(dir, "source.qmp"), "quit").catch(() => undefined);
  await source.exited;
  return {
    dir,
    disks,
    hostname,
    markerSha256,
    endpoint,
    job,
    snapshotId: baremetal.latest.snapshotId,
  };
}

/** Issue a code, boot the ISO on the target, release the session; answers the final recovery. */
async function restore(testCase, context, source, { interrupt } = {}) {
  const client = await api(context);
  const tenantId = context.tenantId;
  const issued = await client.post(
    `/api/v1/endpoints/${source.endpoint.id}/recovery-codes`,
    { validityHours: 4, requireApproval: true, snapshotId: source.snapshotId },
    { tenantId },
  );
  const answersFile = join(source.dir, "answers.json");
  writeFileSync(
    answersFile,
    JSON.stringify(
      buildAnswers(testCase, {
        instanceUrl: context.instanceUrl,
        code: issued.code,
        spkiCheck: issued.spkiCheck,
        snapshotId: source.snapshotId,
        passphrase: context.passphrase,
      }),
    ),
    { mode: 0o600 },
  );
  const kept = (testCase.target.keepSourceDisks ?? []).map((serial) =>
    source.disks.find((disk) => disk.serial === serial),
  );
  const fresh = testCase.target.disks.map((disk) => ({
    ...disk,
    file: join(source.dir, `${disk.serial}.qcow2`),
  }));
  if (!context.targetsMade?.has(testCase.id)) {
    for (const disk of fresh) await createDisk(runAsync, disk.file, disk.size);
    context.targetsMade = new Set([...(context.targetsMade ?? []), testCase.id]);
  }
  const varsFile =
    testCase.target.firmware === "bios" ? undefined : join(source.dir, "target-vars.fd");
  if (varsFile && !existsSync(varsFile))
    await createVars(runAsync, varsFile, testCase.target.firmware, context.dbx);
  const log = join(source.dir, `iso-${issued.id}.log`);
  const iso = startMachine({
    name: `${testCase.id}-iso`,
    firmware: testCase.target.firmware,
    varsFile,
    disks: [...kept, ...fresh],
    cdrom: context.iso,
    serialLog: log,
    qmpSocket: join(source.dir, "iso.qmp"),
    mac: testCase.target.newMac ? "52:54:00:65:43:21" : undefined,
    fwCfg: { "opt/restow/answers": answersFile },
  });
  rmSync(answersFile, { force: true });
  const recoveryPath = `/api/v1/endpoints/${source.endpoint.id}/recoveries/${issued.id}`;
  await waitUntil(
    "the ISO to redeem the code",
    async () => (await client.get(recoveryPath, { tenantId })).status === "pending_approval",
    { timeoutMs: 20 * 60_000 },
  );
  await client.post(`${recoveryPath}/approve`, {}, { tenantId });
  if (interrupt) {
    await waitUntil(
      "the restore to start",
      async () => (await client.get(recoveryPath, { tenantId })).phase === "restoring",
      { timeoutMs: 30 * 60_000 },
    );
    await sleep(30_000);
    if (interrupt === "cancel") await client.post(`${recoveryPath}/cancel`, {}, { tenantId });
    else await qmp(join(source.dir, "iso.qmp"), "quit").catch(() => undefined);
  }
  const final = await waitUntil(
    "the end of the recovery",
    async () => {
      const recovery = await client.get(recoveryPath, { tenantId });
      return isFinal(recovery.status) ? recovery : null;
    },
    { timeoutMs: 3 * 60 * 60_000, intervalMs: 15_000 },
  );
  await Promise.race([iso.exited, sleep(10 * 60_000)]);
  iso.child.kill("SIGKILL");
  return { final, disks: [...kept, ...fresh], varsFile };
}

/** Boot the restored disks and expect the source machine's marker line. */
async function bootRestored(testCase, context, source, restored, { emptyNvram = false } = {}) {
  let varsFile = restored.varsFile;
  if (varsFile && emptyNvram) {
    varsFile = join(source.dir, "target-vars-empty.fd");
    await createVars(runAsync, varsFile, testCase.target.firmware, context.dbx);
  }
  const log = join(source.dir, emptyNvram ? "restored-empty-nvram.log" : "restored.log");
  const machine = startMachine({
    name: `${testCase.id}-restored`,
    firmware: testCase.target.firmware,
    varsFile,
    disks: restored.disks,
    serialLog: log,
    qmpSocket: join(source.dir, "restored.qmp"),
    mac: testCase.target.newMac ? "52:54:00:65:43:21" : undefined,
  });
  try {
    if (testCase.source.unlockAtBoot) {
      await waitForSerial(log, /Enter passphrase/, { timeoutMs: 10 * 60_000, machine });
      await sendKeys(join(source.dir, "restored.qmp"), `${context.passphrase}\n`);
    }
    await waitForSerial(log, bootPattern(source.hostname, source.markerSha256), {
      timeoutMs: 15 * 60_000,
      machine,
    });
  } finally {
    await qmp(join(source.dir, "restored.qmp"), "quit").catch(() => undefined);
    machine.child.kill("SIGKILL");
  }
}

/** A boot probe case: back up the source, plan a probe, wait for its report and judge it. */
async function runProbeCase(testCase, context) {
  const started = Date.now();
  context.passphrase = testCase.source.passphrase
    ? `e2e-${randomBytes(9).toString("hex")}`
    : undefined;
  const source = await sourceMachine(testCase, context);
  const client = await api(context);
  const tenantId = context.tenantId;
  const path = `/api/v1/endpoints/${source.endpoint.id}/baremetal`;
  const before = await client.get(path, { tenantId });
  if (before.check?.readiness !== "green") {
    throw new Error(`${testCase.id}: the layout check is ${before.check?.readiness}, not green`);
  }
  // The lab must have asked once with KVM before a probe can be planned.
  await waitUntil(
    "the recovery lab to ask for work with KVM",
    async () => {
      const state = await client.get(path, { tenantId });
      return state.probe?.lab.present && state.probe.lab.kvm;
    },
    { timeoutMs: 5 * 60_000, intervalMs: 10_000 },
  );
  const requestedAt = Date.now() - 1000;
  await client.post(`${path}/probe`, {}, { tenantId });
  let outcome = null;
  try {
    outcome = await waitUntil(
      "the boot probe's report",
      async () => probeOutcome(testCase, await client.get(path, { tenantId }), requestedAt),
      { timeoutMs: 150 * 60_000, intervalMs: 20_000 },
    );
  } finally {
    const logs = await context.stack.compose(["logs", "--no-color", "recovery-lab"], {
      allowFailure: true,
    });
    writeFileSync(join(source.dir, "lab.log"), logs.stdout ?? "");
  }
  console.log(`${testCase.id}: ${outcome.reason}`);
  if (!outcome.ok) throw new Error(`${testCase.id}: ${outcome.reason}`);
  return { id: testCase.id, seconds: Math.round((Date.now() - started) / 1000) };
}

async function runCase(testCase, context) {
  if (testCase.probe) return runProbeCase(testCase, context);
  const started = Date.now();
  context.passphrase = testCase.source.passphrase
    ? (testCase.source.passphraseText ?? `e2e-${randomBytes(9).toString("hex")}`)
    : undefined;
  const source = await sourceMachine(testCase, context);
  for (const interrupt of testCase.interrupt ?? []) {
    const stopped = await restore(testCase, context, source, { interrupt });
    if (!["cancelled", "failed"].includes(stopped.final.status)) {
      throw new Error(
        `${testCase.id}: after the ${interrupt} the recovery is ${stopped.final.status}`,
      );
    }
  }
  const restored = await restore(testCase, context, source);
  if (restored.final.status !== "succeeded") {
    throw new Error(`${testCase.id}: the recovery ended ${restored.final.status}`);
  }
  if (restored.final.verification?.format !== "restow-verify-v1") {
    throw new Error(`${testCase.id}: the ISO sent no verification report`);
  }
  await bootRestored(testCase, context, source, restored);
  if (testCase.target.alsoEmptyNvram) {
    await bootRestored(testCase, context, source, restored, { emptyNvram: true });
  }
  return { id: testCase.id, seconds: Math.round((Date.now() - started) / 1000) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (options.pinImages) {
    const images = JSON.parse(readFileSync(new URL("./images.json", import.meta.url), "utf8"));
    for (const [name, image] of Object.entries(images)) {
      if (name.startsWith("$")) continue;
      const response = await fetch(image.url);
      if (!response.ok) throw new Error(`${image.url}: ${response.status}`);
      const hash = createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex");
      console.log(`${name} ${hash} ${image.url}`);
    }
    return;
  }
  assertKvm();
  const workDir = resolve(options.workDir);
  mkdirSync(workDir, { recursive: true });
  const agentDir = testAgentDir({
    agentDist: options.agentDist,
    iso: options.iso,
    version: options.version,
    dir: join(workDir, "agent"),
  });
  const instance = await startInstance(options, workDir, agentDir);
  const context = {
    ...instance,
    workDir,
    iso: resolve(options.iso),
    dbx: options.dbx,
    instanceUrl: instance.stack.publicUrl,
  };
  const results = [];
  let failed = 0;
  try {
    for (const testCase of options.selected) {
      console.log(`== ${testCase.id}: ${testCase.title}`);
      try {
        results.push({ ...(await runCase(testCase, context)), result: "passed" });
      } catch (error) {
        failed += 1;
        results.push({
          id: testCase.id,
          result: "failed",
          reason: String(error?.message ?? error),
        });
        console.error(`${testCase.id} failed: ${error?.stack ?? error}`);
      }
    }
  } finally {
    writeFileSync(join(workDir, "report.json"), `${JSON.stringify(results, null, 2)}\n`);
    if (!options.keep) await instance.stack.down();
  }
  for (const result of results)
    console.log(`${result.id} ${result.result} ${result.reason ?? `${result.seconds}s`}`);
  if (failed > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

export { CASES, PROBE_CASES };
