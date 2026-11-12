/**
 * The recovery lab (docs/BAREMETAL.md 12.3; image `restow-lab`, compose profile `recovery-lab`):
 * asks the worker's lab API for work, runs the leased boot probes in QEMU/KVM and reports what
 * it saw. It has no database URL, no master key and never a repository credential; its whole
 * configuration is:
 *
 *   RESTOW_LAB_TOKEN          the token of the lab API (at least 32 characters)
 *   RESTOW_LAB_API            the lab API (default http://worker:8095)
 *   RESTOW_LAB_DIR            its folder: the ISO cache and the probes' disks (default /var/lib/restow-lab)
 *   RESTOW_LAB_CONCURRENCY    probes at the same time (default 1; the worker leases no more)
 *   RESTOW_LAB_TLS_UPSTREAM   where the CONNECT proxy reaches the TLS edge (default caddy:443)
 *   RESTOW_LAB_DBX_DIR        the DBX updates of the image (default /usr/share/restow-lab/dbx)
 *
 * Without /dev/kvm it keeps telling the worker so (the machine's card says "no KVM") and runs
 * nothing.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { type LabClient, labClient } from "./client.js";
import { dbxCount, unionDbx } from "./dbx.js";
import { kvmUsable } from "./qemu.js";
import { removeLeftovers, runProbe, type VmDriver } from "./runner.js";
import { qemuDriver } from "./vm.js";

export interface LabConfig {
  token: string;
  api: string;
  dir: string;
  concurrency: number;
  tlsUpstream: string | null;
  dbxDir: string;
  version: string;
}

/** The lab's configuration from its environment; throws on a missing or short token. */
export function labConfigFromEnv(env: Record<string, string | undefined> = process.env): LabConfig {
  const token = env.RESTOW_LAB_TOKEN?.trim() ?? "";
  if (token.length < 32) throw new Error("RESTOW_LAB_TOKEN must have at least 32 characters");
  const concurrency = Number(env.RESTOW_LAB_CONCURRENCY?.trim() || "1");
  return {
    token,
    api: env.RESTOW_LAB_API?.trim() || "http://worker:8095",
    dir: env.RESTOW_LAB_DIR?.trim() || "/var/lib/restow-lab",
    concurrency:
      Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8 ? concurrency : 1,
    tlsUpstream: env.RESTOW_LAB_TLS_UPSTREAM?.trim() || "caddy:443",
    dbxDir: env.RESTOW_LAB_DBX_DIR?.trim() || "/usr/share/restow-lab/dbx",
    version: env.RESTOW_VERSION?.trim() || "dev",
  };
}

/** The union of the image's DBX updates, written once into the lab's folder (null without any). */
export function prepareDbx(dbxDir: string, dir: string): { file: string; count: number } | null {
  let names: string[];
  try {
    names = readdirSync(dbxDir)
      .filter((name) => /\.(bin|efiauth2|auth2)$/.test(name))
      .sort();
  } catch {
    return null;
  }
  if (names.length === 0) return null;
  const union = unionDbx(names.map((name) => readFileSync(join(dbxDir, name))));
  const file = join(dir, "dbx-union.auth2");
  writeFileSync(file, union, { mode: 0o600 });
  return { file, count: dbxCount(union) };
}

function log(message: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), component: "lab", message, ...fields })}\n`,
  );
}

/** The loop: ask every 30 s while a slot is free (the worker then sees the lab and its KVM). */
export async function runLab(
  config: LabConfig,
  deps: { client?: LabClient; driver?: VmDriver; kvm?: () => boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const client = deps.client ?? labClient(config.api, config.token);
  await removeLeftovers(config.dir);
  const dbx = prepareDbx(config.dbxDir, config.dir);
  log("lab ready", {
    version: config.version,
    concurrency: config.concurrency,
    dbxEntries: dbx?.count ?? 0,
  });
  const driver = deps.driver ?? qemuDriver({ dbxFile: dbx?.file ?? null });
  const running = new Set<Promise<void>>();
  while (!deps.signal?.aborted) {
    const kvm = (deps.kvm ?? kvmUsable)();
    try {
      if (running.size < config.concurrency) {
        const answer = await client.next({ labVersion: config.version, kvm });
        if (answer.probe) {
          const probe = answer.probe;
          log("probe leased", { probeId: probe.id, firmware: probe.hardware.firmware });
          const job = runProbe(
            {
              client,
              driver,
              dir: config.dir,
              labVersion: config.version,
              kvm,
              tlsUpstream: config.tlsUpstream,
              log,
            },
            probe,
          )
            .then((result) => {
              log("probe ended", {
                probeId: probe.id,
                outcome: result.outcome,
                error: result.error?.code,
              });
              return client.result(probe.id, result);
            })
            .catch((error: unknown) =>
              log("probe result not delivered", { probeId: probe.id, error: String(error) }),
            )
            .finally(() => running.delete(job));
          running.add(job);
          continue;
        }
      }
      // Busy: the events of the running probes keep the lab seen by the worker.
    } catch (error) {
      log("lab API not reachable", { error: String(error).slice(0, 300) });
    }
    await sleep(30_000, undefined, { signal: deps.signal }).catch(() => undefined);
  }
  await Promise.allSettled(running);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
  runLab(labConfigFromEnv(), { signal: controller.signal }).catch((error: unknown) => {
    log("lab stopped", { error: String(error) });
    process.exit(1);
  });
}
