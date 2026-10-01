import { serve } from "@hono/node-server";
import { config, demoConfigConflict, missingRequiredConfig } from "./config.js";

/**
 * Node entry point for the `api` role. Starts the HTTP server; migrations and the
 * worker/scheduler roles run as separate processes (docs/ARCHITECTURE.md).
 *
 * Required configuration is checked before the app is loaded: without a
 * BETTER_AUTH_SECRET better-auth would fall back to its public default secret,
 * and without the master key no tenant key can be unwrapped. The process exits
 * instead of serving in that state.
 *
 * The same holds for the database roles: an application pool that is a
 * superuser or can bypass Row Level Security would make every tenant policy
 * decorative (packages/db/src/roles.ts), so it is checked before serving.
 */

const missing = missingRequiredConfig(config);
if (missing.length > 0) {
  // Names only — never the values.
  console.error(
    `Missing required configuration: ${missing.join(", ")}. Set it in .env (see .env.example) and restart.`,
  );
  process.exit(1);
}

const demoConflict = demoConfigConflict(config);
if (demoConflict) {
  console.error(demoConflict);
  process.exit(1);
}

// A setup token too short to be a secret would make the setup guessable.
const { setupTokenConfigProblem } = await import("./lib/setup-token.js");
const setupTokenProblem = setupTokenConfigProblem(config.setupToken);
if (setupTokenProblem) {
  console.error(setupTokenProblem);
  process.exit(1);
}

// An entry the edge would reject never makes the api trust anyone; say so.
const { trustedProxies } = await import("./lib/request.js");
const invalidProxies = trustedProxies().invalid;
if (invalidProxies.length > 0) {
  console.warn(
    `RESTOW_EDGE_TRUSTED_PROXIES: ignoring ${invalidProxies.join(", ")} (not an IP address or CIDR range).`,
  );
}

const { assertPoolRoles } = await import("./db.js");
try {
  await assertPoolRoles();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`Database roles could not be verified: ${reason}`);
  process.exit(1);
}

// The Business/Service Provider modules register with the core's extension
// points (extensions.ts) before the app (and better-auth) is built.
await import("./ee.js");
const { app } = await import("./app.js");

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    `${config.productName} API (${config.nodeEnv}) listening on http://localhost:${info.port}`,
  );
});

// While no setup has completed, the log names the setup token the wizard asks
// for (lib/setup-token.ts), so the operator, and only someone who can read
// this server's log, can finish it.
const { announceSetupToken } = await import("./routes/setup.js");
await announceSetupToken((line) => console.log(line));

// Endpoint agents upload restic packs of up to 128 MiB (docs/AGENT.md); Node's default
// request timeout of five minutes would cut off a client on a slow uplink.
if ("requestTimeout" in server) {
  server.requestTimeout = 30 * 60 * 1000;
}

// The report outbox dispatcher (features/reports/dispatcher.ts) and the
// listeners contributed by extensions (extensions.ts), next to the HTTP server.
const { backgroundServices } = await import("./extensions.js");
const { reportDispatcherService } = await import("./features/reports/dispatcher.js");
const { createInstallationNotifier } = await import("./features/settings/service.js");
const { NoopNotifier } = await import("./notify.js");
const { providerDb: reportsProviderDb, db: reportsDb } = await import("./db.js");
const { updateService } = await import("./features/updates/instance.js");
const services: { close(): void }[] = [];
const coreServices = [
  reportDispatcherService({
    providerDb: reportsProviderDb,
    db: reportsDb,
    // The demo sends nothing: e-mail and webhook deliveries are logged as skipped.
    demo: config.demo.enabled,
    notifier: async () =>
      config.demo.enabled ? new NoopNotifier() : createInstallationNotifier(reportsProviderDb),
    log: (level, message, fields) =>
      (level === "error" ? console.error : console.log)(
        JSON.stringify({ level, component: "reports", message, ...fields }),
      ),
  }),
  // The daily update check (only when switched on) and the sync with the opt-in updater.
  { name: "updates", start: async () => updateService.start() },
];
for (const service of [...coreServices, ...backgroundServices()]) {
  const started = await service.start();
  if (started) {
    services.push(started);
  }
}

function shutdown() {
  server.close();
  for (const service of services) {
    service.close();
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
