/**
 * Check 10 (endpoint backup, when this build has it):
 * the agent is installed from the running stack with the real install script,
 * enrolls with a one-time token, backs up a folder, and a restore task puts the
 * folder back into a new directory where every file matches by SHA-256.
 *
 * The client is a small Linux container on the host network; it trusts the
 * local CA of the stack's edge. The service is not installed (the installer's
 * RESTOW_SKIP_SERVICE test knob): the agent daemon is started by hand once the
 * restore task exists.
 *
 * The client image has no tool that checks an Ed25519 signature (ssh-keygen,
 * OpenSSL 3), so the smoke checks the maintainer's signature over the served
 * SHA256SUMS itself, against agent/release-signing.pub of this checkout, and
 * hands the installer that file's SHA-256 (RESTOW_SHA256SUMS_SHA256, the manual
 * path the installer documents). A build without a signature (the nightly smoke
 * of an unreleased commit) is pinned as served and says so. The installer's own
 * signature checks are covered by agent/scripts/test-install.sh.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, waitFor } from "../lib/exec.mjs";
import { Skip } from "../lib/report.mjs";
import { tenantForCheck, tenantStep } from "../lib/restow.mjs";

const CLIENT = "restow-smoke-endpoint-client";
const AGENT = "/opt/restow-agent/bin/restow-agent";
const NAMESPACE = "restow-agent-release";

/** SSH wire strings (uint32 length + bytes). */
function sshStrings(buffer) {
  const out = [];
  let offset = 0;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    out.push(buffer.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return out;
}

function sshString(value) {
  const bytes = Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * Whether `signature` (an armored SSH signature, `ssh-keygen -Y sign -n
 * restow-agent-release`) signs `message` with the ssh-ed25519 key `keyLine`.
 */
export function verifyReleaseSignature(message, signature, keyLine) {
  const [type, blob] = keyLine.trim().split(/\s+/);
  if (type !== "ssh-ed25519" || !blob) return false;
  const [, rawKey] = sshStrings(Buffer.from(blob, "base64"));
  const armored = signature.replace(/-----(BEGIN|END) SSH SIGNATURE-----/g, "").replace(/\s+/g, "");
  const sig = Buffer.from(armored, "base64");
  if (sig.subarray(0, 6).toString() !== "SSHSIG") return false;
  const [publicKey, namespace, reserved, hashAlg, sigBlob] = sshStrings(sig.subarray(10));
  if (!publicKey?.equals(Buffer.from(blob, "base64")) || namespace?.toString() !== NAMESPACE) {
    return false;
  }
  const [sigType, rawSig] = sshStrings(sigBlob);
  if (sigType.toString() !== "ssh-ed25519") return false;
  const digest = createHash(hashAlg.toString()).update(message).digest();
  const signed = Buffer.concat([
    Buffer.from("SSHSIG"),
    sshString(NAMESPACE),
    sshString(reserved),
    sshString(hashAlg.toString()),
    sshString(digest),
  ]);
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: rawKey.toString("base64url") },
    format: "jwk",
  });
  return verify(null, signed, key, rawSig);
}

const RELEASE_KEY = join(
  fileURLToPath(new URL("../../..", import.meta.url)),
  "agent",
  "release-signing.pub",
);

const PREPARE = `
set -eu
mkdir -p /srv/smoke-data/docs/sub /srv/smoke-data/empty
i=1
while [ "$i" -le 12 ]; do
  head -c $((i * 3571)) /dev/urandom > "/srv/smoke-data/docs/file-$i.bin"
  i=$((i + 1))
done
printf 'Gr\\303\\274\\303\\237e aus dem Smoke-Test\\n' > "/srv/smoke-data/docs/sub/gr\\303\\274\\303\\237e.txt"
head -c 1048576 /dev/urandom > /srv/smoke-data/big.bin
`;

const LIST = (root) =>
  `cd ${root} && find . -type f | sort | while read -r f; do sha256sum "$f"; done`;

export async function endpoint(ctx, check) {
  const { stack, api } = ctx;
  const probe = await api.request("GET", "/api/v1/endpoints", { tenantId: ctx.imap?.tenantId });
  const installer = await fetch(`${stack.apiUrl}/install/linux.sh`).catch(() => null);
  if (probe.status === 404 || !installer || installer.status === 404) {
    throw new Skip(
      "skipped: this build has no endpoint backup (no /api/v1/endpoints route or no install script)",
    );
  }

  const tenant = await check.step(
    tenantStep(ctx, "a one-time enrollment token for a Linux server"),
    async () => {
      const created = await tenantForCheck(ctx, "Smoke Endpoint Tenant", "smoke-endpoint");
      const token = await api.post(
        "/api/v1/endpoints/tokens",
        { profile: "server", os: "linux", displayName: "smoke-server" },
        { tenantId: created.id },
      );
      created.token = token.token ?? token.secret;
      if (!created.token?.startsWith("rset_")) {
        throw new Error(`the token answer has no rset_ token: ${Object.keys(token).join(", ")}`);
      }
      return created;
    },
  );
  const tenantId = tenant.id;

  const caFile = join(ctx.workDir, "caddy-root.crt");
  await check.step(
    "take the root certificate of the stack's edge for the client to trust",
    async () => {
      await stack.compose([
        "cp",
        "caddy:/data/caddy/pki/authorities/local/root.crt",
        join(ctx.workDir, "caddy-root.crt"),
      ]);
      return "Caddy local CA";
    },
  );

  const exec = (script, options = {}) =>
    run("docker", ["exec", "--user", "root", CLIENT, "sh", "-c", script], {
      allowFailure: true,
      ...options,
    });

  try {
    await check.step("start a Linux client container and create a folder with files", async () => {
      await run("docker", ["rm", "-f", CLIENT], { allowFailure: true });
      await run("docker", [
        "run",
        "-d",
        "--name",
        CLIENT,
        "--user",
        "root",
        "--network",
        "host",
        "-v",
        `${caFile}:/ca.crt:ro`,
        "-e",
        "CURL_CA_BUNDLE=/ca.crt",
        "-e",
        "SSL_CERT_FILE=/ca.crt",
        "--entrypoint",
        "sleep",
        ctx.images.client,
        "3600",
      ]);
      const prepared = await exec(PREPARE);
      if (prepared.code !== 0) {
        throw new Error(prepared.stderr);
      }
      const listed = await exec(LIST("/srv/smoke-data"));
      ctx.endpointFiles = listed.stdout.trim().split("\n");
      return `${ctx.endpointFiles.length} files in /srv/smoke-data`;
    });

    const pin = await check.step(
      "the served agent release is signed with the release key of this checkout",
      async () => {
        const script = await (await fetch(`${stack.apiUrl}/install/linux.sh`)).text();
        const version = /AGENT_VERSION='([^']+)'/.exec(script)?.[1];
        if (!version) throw new Error("the install script names no agent version");
        const sums = Buffer.from(
          await (await fetch(`${stack.apiUrl}/install/agent/${version}/SHA256SUMS`)).arrayBuffer(),
        );
        const signature = await fetch(`${stack.apiUrl}/install/agent/${version}/SHA256SUMS.sig`);
        const sha256 = createHash("sha256").update(sums).digest("hex");
        if (signature.status === 404) {
          return {
            sha256,
            note: `agent ${version} is not signed (unreleased build): checksums pinned as served`,
          };
        }
        const keyLine =
          readFileSync(RELEASE_KEY, "utf8")
            .split("\n")
            .find((line) => line.startsWith("ssh-ed25519 ")) ?? "";
        if (!verifyReleaseSignature(sums, await signature.text(), keyLine)) {
          throw new Error(
            `the signature of agent ${version} does not match agent/release-signing.pub`,
          );
        }
        return { sha256, note: `agent ${version}: signature good` };
      },
    );

    await check.step("the real install script installs and enrolls the agent", async () => {
      const result = await exec(
        `curl -fsSL '${stack.publicUrl}/install/linux.sh' | RESTOW_SKIP_SERVICE=1 RESTOW_SHA256SUMS_SHA256=${pin.sha256} RESTOW_TOKEN='${tenant.token}' sh`,
        { timeoutMs: 180_000 },
      );
      if (result.code !== 0) {
        throw new Error(
          `exit ${result.code}: ${(result.stderr + result.stdout).trim().split("\n").slice(-6).join(" | ")}`,
        );
      }
      const status = await exec(`${AGENT} status`);
      return `${pin.note}; ${status.stdout.trim().split("\n").slice(0, 2).join(" ")}`;
    });

    const endpointId = await check.step("the server lists the endpoint", async () => {
      const list = await api.get("/api/v1/endpoints", { tenantId });
      const items = list.items ?? list;
      if (items.length !== 1) {
        throw new Error(`${items.length} endpoints are listed`);
      }
      return items[0].id;
    });

    const snapshot = await check.step(
      "back up the folder with the agent (append-only, through the stack)",
      async () => {
        const result = await exec(`${AGENT} backup-now`, { timeoutMs: 300_000 });
        if (result.code !== 0 && result.code !== 3) {
          throw new Error(
            `exit ${result.code}: ${(result.stderr + result.stdout).trim().split("\n").slice(-6).join(" | ")}`,
          );
        }
        const found = await waitFor(
          "the snapshot on the server",
          async () => {
            const snapshots = await api.get(`/api/v1/endpoints/${endpointId}/snapshots`, {
              tenantId,
            });
            const items = snapshots.items ?? snapshots;
            return items.length > 0 ? items[0] : null;
          },
          { timeoutMs: 60_000 },
        );
        return found;
      },
    );

    await check.step(
      "a restore task puts the folder into a new directory, every file equal by SHA-256",
      async () => {
        await api.post(
          `/api/v1/endpoints/${endpointId}/tasks`,
          {
            kind: "restore",
            snapshotId: snapshot.id ?? snapshot.snapshotId,
            paths: ["/srv/smoke-data"],
            targetDir: "/restore-smoke",
          },
          { tenantId },
        );
        // The daemon reports in right at its start and receives the task.
        await exec(`nohup ${AGENT} run > /tmp/agent-run.log 2>&1 &`);
        const restored = await waitFor(
          "the restored folder",
          async () => {
            const listed = await exec(LIST("/restore-smoke/srv/smoke-data"));
            return listed.code === 0 &&
              listed.stdout.trim().split("\n").length >= ctx.endpointFiles.length
              ? listed.stdout.trim().split("\n")
              : null;
          },
          { timeoutMs: 240_000, intervalMs: 3000 },
        );
        const same =
          JSON.stringify([...restored].sort()) === JSON.stringify([...ctx.endpointFiles].sort());
        if (!same) {
          throw new Error("the restored files differ from the originals");
        }
        const original = await exec(LIST("/srv/smoke-data"));
        if (original.stdout.trim().split("\n").join("\n") !== ctx.endpointFiles.join("\n")) {
          throw new Error("the original folder changed during the restore");
        }
        return `${restored.length} files equal by SHA-256, originals untouched`;
      },
    );

    await check.step("the server recorded a successful backup run", async () => {
      const runs = await api.get(`/api/v1/endpoints/${endpointId}/runs`, { tenantId });
      const items = runs.items ?? runs;
      if (
        !items.some(
          (entry) => entry.kind === "backup" && ["succeeded", "partial"].includes(entry.status),
        )
      ) {
        throw new Error(
          `runs: ${JSON.stringify(items.map((entry) => `${entry.kind}:${entry.status}`))}`,
        );
      }
      return `${items.length} runs recorded`;
    });
  } finally {
    const logs = await run(
      "docker",
      ["exec", CLIENT, "sh", "-c", "tail -n 20 /tmp/agent-run.log 2>/dev/null"],
      {
        allowFailure: true,
      },
    );
    if (logs.stdout.trim()) {
      ctx.log(logs.stdout.trim().replace(/^/gmu, "      agent: "));
    }
    await run("docker", ["rm", "-f", CLIENT], { allowFailure: true });
  }
}
