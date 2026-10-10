import { z } from "zod";
import type { BackgroundService } from "../../extensions.js";
import {
  deleteProviderSecrets,
  findProviderSecret,
  readSecret,
  upsertProviderSecret,
} from "../../lib/secrets.js";
import type { DbExecutor } from "../../lib/tenant-context.js";
import { mountSpecSchema } from "../../mounter/protocol.js";
import { actorSchema } from "../../updater/protocol.js";
import type { MountsService, PendingMount, PendingMountStore } from "./service.js";

/**
 * "Apply when idle" (docs/MOUNTS.md): an add of a network share that the owner asked for
 * while jobs ran waits here until none runs. The request is kept in the installation's
 * secret store (kind `pending_mount_request`, one at most), like a pending license key
 * (lib/pending-license-key.ts): it survives a restart of the api and needs no column of
 * its own. It holds no secret, only the share's settings and who asked.
 */

export const PENDING_MOUNT_KIND = "pending_mount_request";

/** How often the api looks whether the jobs have finished. */
export const PENDING_MOUNT_POLL_MS = 15_000;

const pendingSchema = z.object({
  mount: mountSpecSchema,
  requestedBy: actorSchema,
  requestedAt: z.string(),
  failure: z.object({ code: z.string().nullable(), detail: z.string().nullable() }).nullable(),
});

export function secretPendingMountStore(db: DbExecutor): PendingMountStore {
  return {
    async load() {
      const ref = await findProviderSecret(db, PENDING_MOUNT_KIND);
      if (!ref) {
        return null;
      }
      const raw = await readSecret(db, ref);
      try {
        const parsed = pendingSchema.safeParse(JSON.parse(raw ?? ""));
        return parsed.success ? (parsed.data as PendingMount) : null;
      } catch {
        return null;
      }
    },
    async save(pending) {
      await upsertProviderSecret(db, PENDING_MOUNT_KIND, JSON.stringify(pending));
    },
    async clear() {
      await deleteProviderSecrets(db, PENDING_MOUNT_KIND);
    },
  };
}

type Log = (level: "info" | "warn" | "error", message: string, fields?: object) => void;

/** The loop next to the HTTP server (server.ts) that applies a waiting add once no job runs. */
export function pendingMountService(
  service: Pick<MountsService, "applyPending">,
  options: { intervalMs?: number; log?: Log } = {},
): BackgroundService {
  return {
    name: "mounts-pending",
    async start() {
      let running = false;
      const tick = async () => {
        if (running) {
          return;
        }
        running = true;
        try {
          const outcome = await service.applyPending();
          if (outcome === "applied" || outcome === "failed") {
            options.log?.(outcome === "applied" ? "info" : "warn", "waiting network share", {
              outcome,
            });
          }
        } catch (error) {
          options.log?.("error", "the waiting network share could not be checked", {
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void tick(), options.intervalMs ?? PENDING_MOUNT_POLL_MS);
      timer.unref();
      void tick();
      return { close: () => clearInterval(timer) };
    },
  };
}
