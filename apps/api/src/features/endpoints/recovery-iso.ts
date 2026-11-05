import { Hono } from "hono";
import { requireTenant, type TenantEnv } from "../../middleware/session.js";
import { releaseKeyFingerprint } from "./commands.js";
import {
  agentRoot,
  isAgentVersion,
  listAgentVersions,
  readReleaseFile,
  readReleaseKey,
} from "./distribution.js";
import { instanceUrl } from "./instance-url.js";

/**
 * The recovery ISO this installation offers (docs/BAREMETAL.md 8.5, 9.2, 14.6):
 * `restow-recovery_<version>_amd64.iso`, listed in the signed `SHA256SUMS` of an agent release
 * under `recovery/`. The newest signed release decides: when its checksums list the ISO, the ISO is
 * `verified` (the same signature covers it as the agent binaries), and only then can a recovery
 * code be issued and does the web app show the code dialog and the wizard. No release lists one
 * before the ISO ships (M4), so until then both stay hidden.
 *
 * The answer carries the commands to check the file before it is written to a USB stick: the
 * signature of `SHA256SUMS` with the release key of the Git tag (never the one this instance
 * serves alone), then the hash of the file.
 *
 *   GET /api/v1/recovery-iso      version, file name, URL, SHA-256, release key fingerprint, commands
 */

export interface RecoveryIsoCommands {
  linux: string[];
  macos: string[];
  windows: string[];
}

export interface RecoveryIsoState {
  version: string | null;
  fileName: string | null;
  url: string | null;
  sha256: string | null;
  releaseKeyFingerprint: string | null;
  verified: boolean;
  commands: RecoveryIsoCommands;
}

/** The file name of the ISO of a version. */
export function recoveryIsoFileName(version: string): string {
  return `restow-recovery_${version}_amd64.iso`;
}

/** The line of the ISO in a release's SHA256SUMS: `<hash>  recovery/<file>`. */
function isoChecksum(text: string, fileName: string): string | null {
  for (const line of text.split("\n")) {
    const match = /^([0-9a-fA-F]{64})\s+\*?recovery\/(\S+)\s*$/.exec(line.trim());
    if (match && match[2] === fileName) {
      return (match[1] as string).toLowerCase();
    }
  }
  return null;
}

function commandsFor(fileName: string | null, version: string | null): RecoveryIsoCommands {
  if (!fileName || !version) {
    return { linux: [], macos: [], windows: [] };
  }
  const verify = [
    `./verify-agent-signature.sh release-signing.pub SHA256SUMS SHA256SUMS.sig`,
    `grep ' recovery/${fileName}$' SHA256SUMS | sed 's# recovery/# #' | sha256sum -c -`,
  ];
  return {
    linux: verify,
    macos: [
      verify[0] as string,
      `grep ' recovery/${fileName}$' SHA256SUMS | sed 's# recovery/# #' | shasum -a 256 -c -`,
    ],
    windows: [`(Get-FileHash -Algorithm SHA256 '${fileName}').Hash.ToLower()`],
  };
}

/**
 * What the newest signed release says about the ISO. `verified` only when that release has a
 * signature and its checksums list the ISO of its own version.
 */
export async function recoveryIsoState(
  root = agentRoot(),
  instance: string | null = null,
): Promise<RecoveryIsoState> {
  const fingerprintOf = async () => {
    const key = await readReleaseKey().catch(() => "");
    return key ? releaseKeyFingerprint(key) : null;
  };
  for (const version of await listAgentVersions(root)) {
    if (!isAgentVersion(version) || !(await readReleaseFile(version, "SHA256SUMS.sig", root))) {
      continue;
    }
    // The newest signed release decides; an older one with an ISO does not stand in for it.
    const sums = await readReleaseFile(version, "SHA256SUMS", root);
    const fileName = recoveryIsoFileName(version);
    const sha256 = sums ? isoChecksum(sums.toString("utf8"), fileName) : null;
    if (!sha256) {
      break;
    }
    return {
      version,
      fileName,
      url: instance
        ? `${instance.replace(/\/+$/, "")}/install/recovery/${version}/${fileName}`
        : null,
      sha256,
      releaseKeyFingerprint: await fingerprintOf(),
      verified: true,
      commands: commandsFor(fileName, version),
    };
  }
  return {
    version: null,
    fileName: null,
    url: null,
    sha256: null,
    releaseKeyFingerprint: await fingerprintOf(),
    verified: false,
    commands: commandsFor(null, null),
  };
}

export const recoveryIsoRoutes = new Hono<TenantEnv>();

recoveryIsoRoutes.get("/", requireTenant("tenant_admin"), async (c) => {
  const instance = await instanceUrl(c);
  return c.json(await recoveryIsoState(agentRoot(), instance.url || null));
});
