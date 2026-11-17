import type { BackgroundService } from "../../../../apps/api/src/extensions.js";
import {
  type BillingCloseDeps,
  type BillingPassSummary,
  pruneBillingSamples,
  runBillingPass,
} from "./service.js";

/**
 * The billing close as a background service of the API process (docs/ARCHITECTURE.md,
 * "Monatsabschluss der Abrechnung"): a pass every minute closes the months that are due and
 * samples the tenants that have no sample for today, once a day it removes old samples. A pass
 * never overlaps the previous one in this process; across processes the database's lock and
 * unique keys keep the close and the samples single (./service.ts). Nothing in the demo.
 */

export const BILLING_PASS_INTERVAL_MS = 60_000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type Log = NonNullable<BillingCloseDeps["log"]>;

const consoleLog: Log = (level, message, fields) =>
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
    JSON.stringify({ level, component: "billing-close", message, ...fields }),
  );

/** The service over `deps`; `now` and the interval are replaceable for tests. */
export function billingCloseServiceFor(
  load: () => Promise<BillingCloseDeps | null>,
  options: { now?: () => Date; intervalMs?: number } = {},
): BackgroundService {
  return {
    name: "billing-close",
    async start() {
      const deps = await load();
      if (!deps) {
        return null;
      }
      const now = options.now ?? (() => new Date());
      let running = false;
      let lastPrune = 0;
      const tick = async (): Promise<BillingPassSummary | null> => {
        if (running) return null;
        running = true;
        try {
          const summary = await runBillingPass(deps, now());
          if (summary.enabled && summary.timeZone && Date.now() - lastPrune >= PRUNE_INTERVAL_MS) {
            lastPrune = Date.now();
            await pruneBillingSamples(deps.providerDb, now(), summary.timeZone);
          }
          return summary;
        } catch (error) {
          deps.log?.("error", "billing close pass failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        } finally {
          running = false;
        }
      };
      const timer = setInterval(() => void tick(), options.intervalMs ?? BILLING_PASS_INTERVAL_MS);
      timer.unref();
      void tick();
      return { close: () => clearInterval(timer) };
    },
  };
}

/** The service on the API's own pools (apps/api/src/db.ts), registered by ../index.ts. */
export const billingCloseService: BackgroundService = billingCloseServiceFor(async () => {
  const { config } = await import("../../../../apps/api/src/config.js");
  if (config.demo.enabled) {
    return null;
  }
  const { db, providerDb } = await import("../../../../apps/api/src/db.js");
  return { db, providerDb, log: consoleLog };
});
