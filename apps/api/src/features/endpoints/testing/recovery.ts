/**
 * What the Postgres suites of bare metal M3 share (docs/BAREMETAL.md 9, 11): an agent release with
 * a verified recovery ISO (its signed `SHA256SUMS` lists `recovery/restow-recovery_<v>_amd64.iso`),
 * a Linux machine with a sealed repository password and a whole machine backup with a layout, and
 * what the ISO computes from a code (proof, session secret, its hash).
 */
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateAgentSecret,
  hashSecret,
  normalizeRecoveryCode,
  recoveryCodeProof,
  releaseKeyLineForTests,
  signReleaseForTests,
} from "@restow/core";
import {
  type Database,
  type EndpointConfig,
  endpointLayouts,
  endpointRuns,
  endpoints,
} from "@restow/db";

export const CONFIG: EndpointConfig = {
  profile: "server",
  schedule: { kind: "daily", timeOfDay: "02:00", timeZone: "Europe/Berlin" },
  paths: ["/"],
  excludes: [],
  hooks: {},
  bandwidthKbps: null,
  onlyOnAcPower: false,
  useVss: false,
  wholeMachine: true,
};

/**
 * An agent root whose newest signed release lists the ISO (or does not): the checksums are signed
 * with a throwaway key made here, whose public half is the root's `install/release-signing.pub`
 * (the server checks the signature itself, docs/BAREMETAL.md 26.13).
 */
export async function agentRootWithIso(
  withIso: boolean,
  isoSha256: string = "b".repeat(64),
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "restow-recovery-iso-"));
  await mkdir(join(root, "0.5.0"), { recursive: true });
  await mkdir(join(root, "install"), { recursive: true });
  const lines = [`${"a".repeat(64)}  linux-amd64/restow-agent`];
  if (withIso) {
    lines.push(`${isoSha256}  recovery/restow-recovery_0.5.0_amd64.iso`);
  }
  const sums = `${lines.join("\n")}\n`;
  const { privateKey } = generateKeyPairSync("ed25519");
  await writeFile(join(root, "0.5.0", "SHA256SUMS"), sums);
  await writeFile(join(root, "0.5.0", "SHA256SUMS.sig"), signReleaseForTests(privateKey, sums));
  await writeFile(
    join(root, "install", "release-signing.pub"),
    `${releaseKeyLineForTests(privateKey)}\n`,
  );
  return root;
}

export const HARDWARE = {
  firmware: "uefi" as const,
  secureBoot: true,
  ramBytes: 17_179_869_184,
  disks: [
    {
      sizeBytes: 1_000_204_886_016,
      logicalSectorSize: 512,
      model: "Samsung SSD 980",
      serial: "S64XNF0R",
      wwn: "eui.0025385b11b2",
      transport: "nvme",
    },
  ],
  nics: [{ mac: "52:54:00:12:34:56", driver: "virtio_net", link: true }],
};

/** What the ISO holds for one exchange: the proof for an origin and its own session secret. */
export function isoSide(code: string, origin: string) {
  const normalized = normalizeRecoveryCode(code);
  if (!normalized) throw new Error(`not a code: ${code}`);
  const sessionSecret = randomBytes(32).toString("hex");
  return {
    codeProof: recoveryCodeProof(origin, normalized),
    sessionSecret,
    sessionSecretSha256: hashSecret(sessionSecret),
  };
}

export function exchangeBody(
  iso: { codeProof: string; sessionSecretSha256: string },
  extra: Record<string, unknown> = {},
) {
  return {
    codeProof: iso.codeProof,
    sessionSecretSha256: iso.sessionSecretSha256,
    recoveryVersion: "0.5.0",
    hardware: HARDWARE,
    ...extra,
  };
}

export function sessionBasic(sessionId: string, secret: string): { authorization: string } {
  return { authorization: `Basic ${Buffer.from(`${sessionId}:${secret}`).toString("base64")}` };
}

/**
 * A machine with a sealed repository password, and (unless `layout` is false) a good whole machine
 * backup whose layout has `verdict`.
 */
export async function insertMachine(
  owner: Database,
  storeSecret: (tenantId: string, plaintext: string) => Promise<string>,
  options: {
    tenantId: string;
    os?: "linux" | "windows" | "darwin";
    layout?: boolean;
    verdict?: string;
    status?: "active" | "revoked";
    snapshotId?: string;
    repositoryPassword?: string;
  },
) {
  const id = randomUUID();
  const secret = generateAgentSecret();
  const repositoryPassword = options.repositoryPassword ?? randomBytes(16).toString("hex");
  const secretId = await storeSecret(options.tenantId, repositoryPassword);
  await owner.insert(endpoints).values({
    id,
    tenantId: options.tenantId,
    hostname: `host-${id.slice(0, 8)}`,
    displayName: null,
    os: options.os ?? "linux",
    arch: "amd64",
    profile: "server",
    status: options.status ?? "active",
    secretHash: secret.hash,
    repositorySecretId: secretId,
    agentVersion: "0.5.0",
    config: CONFIG,
    configVersion: 2,
  });
  const snapshotId = options.snapshotId ?? randomBytes(32).toString("hex");
  let layoutSha256: string | null = null;
  if (options.layout !== false) {
    layoutSha256 = randomBytes(32).toString("hex");
    const [layout] = await owner
      .insert(endpointLayouts)
      .values({
        tenantId: options.tenantId,
        endpointId: id,
        sha256: layoutSha256,
        format: "restow-layout-v1",
        schemaVersion: 1,
        platform: "linux",
        manifest: {},
        summary: {},
        verdict: options.verdict ?? "supported",
        layoutFingerprint: "f",
      })
      .returning();
    const at = new Date(Date.now() - 60 * 60 * 1000);
    await owner.insert(endpointRuns).values({
      tenantId: options.tenantId,
      endpointId: id,
      kind: "backup",
      status: "succeeded",
      startedAt: at,
      finishedAt: at,
      snapshotId,
      layoutId: layout?.id ?? null,
    });
  }
  return {
    id,
    tenantId: options.tenantId,
    agentSecret: secret.value,
    repositoryPassword,
    snapshotId,
    layoutSha256,
  };
}
