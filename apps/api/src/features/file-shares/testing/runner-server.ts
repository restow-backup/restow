/**
 * A test-only server of the routes a file share runner reaches (docs/FILESHARES.md 5.2, 5.3):
 * the runner routes and the restic route, exactly as app.ts mounts them, on a loopback port.
 * The worker's end-to-end test (apps/worker/src/file-shares/e2e.pg.test.ts) starts it as a
 * child process with the database, master key and storage of its scratch installation, and runs
 * the real restow-share against it. It prints `{"listening": <port>}` once it serves.
 *
 *   tsx apps/api/src/features/file-shares/testing/runner-server.ts
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";

// The shared database handles read the environment when they are first imported.
const { errorHandler } = await import("../../../problem.js");
const { requestBodyLimit } = await import("../../../middleware/body-limit.js");
const { FILE_SHARE_RUNNER_PATH } = await import("../constants.js");
const { fileShareRunnerRoutes } = await import("../runner-routes.js");
const { FILE_SHARE_RESTIC_PATH, fileShareResticRoutes } = await import("../restic-route.js");

const app = new Hono();
app.onError(errorHandler);
app.use("*", requestBodyLimit);
app.route(FILE_SHARE_RESTIC_PATH, fileShareResticRoutes);
app.route(FILE_SHARE_RUNNER_PATH, fileShareRunnerRoutes);

const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
  process.stdout.write(`${JSON.stringify({ listening: info.port })}\n`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close();
    process.exit(0);
  });
}
