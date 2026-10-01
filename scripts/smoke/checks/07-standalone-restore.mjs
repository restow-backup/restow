/**
 * Check 7: standalone restore. The storage written by check 5 is restored with
 * `restow-restore` while the server is down and the container has no network:
 * the storage format, the key encryption key and the tool are all it needs.
 * A copy of the storage with one damaged byte must be refused.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.mjs";
import { hashTree } from "../lib/files.mjs";
import { signIn } from "../lib/restow.mjs";

const SERVER_SERVICES = ["api", "worker", "scheduler", "caddy", "postgres"];

export async function standaloneRestore(ctx, check) {
  const { stack, images } = ctx;
  if (!ctx.imap?.snapshot) {
    throw new Error("check 5 did not leave a snapshot to restore");
  }
  const { tenantId, snapshot, expected } = ctx.imap;
  const manifest = `tenants/${tenantId}/manifests/${snapshot.id}.json.zst`;
  const volume = stack.volume("restow-data");
  const outDir = join(ctx.workDir, "restore-out");
  const tamperDir = join(ctx.workDir, "tampered");
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tamperDir, { recursive: true });
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;

  /** restow-restore in a throwaway container: no network, storage read-only, the key from the environment. */
  const restoreTool = (args, { storage = "/data/chunks", extraMounts = [] } = {}) =>
    run(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-v",
        `${volume}:/data:ro`,
        "-v",
        `${outDir}:/out`,
        ...extraMounts,
        "-e",
        "RESTOW_MASTER_KEY",
        "--entrypoint",
        "sh",
        images.app,
        "-c",
        `restow-restore ${args.replace("{storage}", storage)}; code=$?; chown -R ${uid}:${gid} /out 2>/dev/null; exit $code`,
      ],
      { env: { RESTOW_MASTER_KEY: stack.masterKey }, allowFailure: true, timeoutMs: 300_000 },
    );

  await check.step("the snapshot's manifest is in the storage", async () => {
    const { code } = await run(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${volume}:/data:ro`,
        "--entrypoint",
        "test",
        images.app,
        "-f",
        `/data/chunks/${manifest}`,
      ],
      { allowFailure: true },
    );
    if (code !== 0) {
      throw new Error(`${manifest} does not exist in the storage volume`);
    }
    return manifest;
  });

  await check.step(
    "stop the server: api, worker, scheduler, edge and database are down",
    async () => {
      await stack.compose(["stop", "--timeout", "15", ...SERVER_SERVICES]);
      const reachable = await fetch(`${stack.apiUrl}/healthz`, {
        signal: AbortSignal.timeout(3000),
      })
        .then(() => true)
        .catch(() => false);
      if (reachable) {
        throw new Error("the api still answers");
      }
    },
  );

  try {
    await check.step("restow-restore verify passes without a server", async () => {
      const result = await restoreTool(
        `verify --manifest ${manifest} --storage {storage} --key RESTOW_MASTER_KEY`,
      );
      if (result.code !== 0) {
        throw new Error(
          `exit ${result.code}: ${result.stderr.trim().split("\n").slice(-5).join(" | ")}`,
        );
      }
      const summary = result.stderr.trim().split("\n").pop();
      return summary;
    });

    await check.step("restow-restore restore writes every message, byte for byte", async () => {
      const result = await restoreTool(
        `restore --manifest ${manifest} --storage {storage} --key RESTOW_MASTER_KEY --out /out`,
      );
      if (result.code !== 0) {
        throw new Error(
          `exit ${result.code}: ${result.stderr.trim().split("\n").slice(-5).join(" | ")}`,
        );
      }
      const files = hashTree(outDir).filter((file) => file.path.endsWith(".eml"));
      let compared = 0;
      for (const folder of Object.keys(expected)) {
        const restored = files
          .filter((file) => file.path.startsWith(`mail/${folder}/`))
          .map((file) => file.sha256)
          .sort();
        const want = [...expected[folder]].sort();
        if (JSON.stringify(restored) !== JSON.stringify(want)) {
          throw new Error(
            `${folder}: ${restored.length} files restored, ${want.length} expected, hashes differ`,
          );
        }
        compared += restored.length;
      }
      return `${compared} messages restored and equal by SHA-256 to the messages written in check 5`;
    });

    await check.step("a copy of the storage with one damaged byte is refused", async () => {
      const prepare = await run(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${volume}:/data:ro`,
          "-v",
          `${tamperDir}:/t`,
          "--entrypoint",
          "sh",
          images.app,
          "-c",
          `cp -a /data/chunks /t/chunks && f="$(find /t/chunks/tenants/${tenantId}/packs -type f | head -1)" && size="$(stat -c %s "$f")" && printf "\\377" | dd of="$f" bs=1 seek=$((size / 2)) conv=notrunc 2>/dev/null && chown -R ${uid}:${gid} /t && echo "damaged $f"`,
        ],
        { allowFailure: true },
      );
      if (prepare.code !== 0) {
        throw new Error(`could not prepare the damaged copy: ${prepare.stderr.trim()}`);
      }
      const result = await restoreTool(
        `verify --manifest ${manifest} --storage /t/chunks --key RESTOW_MASTER_KEY`,
        { extraMounts: ["-v", `${tamperDir}:/t:ro`] },
      );
      if (result.code === 0) {
        throw new Error("restow-restore verify accepted a storage with a damaged pack");
      }
      return `refused with exit ${result.code}`;
    });
  } finally {
    await stack.up([...SERVER_SERVICES]);
    await stack.waitForApi();
  }

  ctx.api = await signIn(stack, ctx.totpSecret);
}
