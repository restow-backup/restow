/**
 * Check 2: /healthz and /readyz answer green, the edge serves the interface,
 * and the worker and the scheduler have registered with the database.
 *
 * /readyz is only ready once the database answers and the worker and the
 * scheduler have written a heartbeat (service_heartbeats, every 30 seconds,
 * fresh for two minutes), so a stack that started without a worker never
 * passes here. /healthz is liveness only and is checked on its own.
 */
import { waitFor } from "../lib/exec.mjs";
import { insecureGet } from "../lib/http.mjs";

/**
 * What /readyz says about the stack: `ready` only for HTTP 200 with status
 * `ready`, the database reachable and the worker and the scheduler `ok`;
 * otherwise the reasons, one per failing check.
 */
export function assessReadiness(httpStatus, body) {
  const problems = [];
  if (body?.checks?.database !== true) {
    problems.push("the database is not reachable");
  }
  for (const role of ["worker", "scheduler"]) {
    const value = body?.checks?.[role];
    if (value !== "ok") {
      problems.push(`${role} is ${JSON.stringify(value ?? null)}, not "ok"`);
    }
  }
  if (httpStatus !== 200 || body?.status !== "ready") {
    problems.push(`answered ${httpStatus} ${JSON.stringify(body?.status ?? null)}`);
  }
  return { ready: problems.length === 0, problems };
}

export async function health(ctx, check) {
  const { stack } = ctx;

  await check.step("GET /healthz answers ok", async () => {
    const response = await fetch(`${stack.apiUrl}/healthz`);
    const body = await response.json();
    if (response.status !== 200 || body.status !== "ok") {
      throw new Error(`answered ${response.status} ${JSON.stringify(body)}`);
    }
    return "200 ok";
  });

  await check.step(
    "GET /readyz answers ready once the worker and the scheduler reported in",
    async () => {
      // The worker and the scheduler start once the api is healthy: give them a moment
      // to write their first heartbeat.
      return waitFor(
        "/readyz to report the database, the worker and the scheduler as ok",
        async () => {
          const response = await fetch(`${stack.apiUrl}/readyz`);
          const body = await response.json();
          const { ready, problems } = assessReadiness(response.status, body);
          if (!ready) {
            throw new Error(`${problems.join("; ")} (${JSON.stringify(body)})`);
          }
          return "200 ready, database reachable, worker and scheduler ok";
        },
        { timeoutMs: 120_000, intervalMs: 3000 },
      );
    },
  );

  await check.step("the edge serves the interface and proxies the api over https", async () => {
    const spa = await insecureGet(`${stack.publicUrl}/`);
    if (spa.status !== 200 || !/<div id="root"|<title>/u.test(spa.body)) {
      throw new Error(`GET / answered ${spa.status}`);
    }
    for (const header of ["content-security-policy", "x-content-type-options"]) {
      if (!spa.headers[header]) {
        throw new Error(`the edge sends no ${header} header`);
      }
    }
    const state = await insecureGet(`${stack.publicUrl}/api/v1/setup/state`);
    if (state.status !== 200) {
      throw new Error(`/api/v1/setup/state through the edge answered ${state.status}`);
    }
    return `https ${spa.tls}, interface and api reachable, security headers present`;
  });

  await check.step("the edge serves the third-party notices as plain text", async () => {
    const notices = await insecureGet(`${stack.publicUrl}/licenses/THIRD_PARTY_NOTICES.txt`);
    const type = notices.headers["content-type"] ?? "";
    if (notices.status !== 200 || !type.startsWith("text/plain")) {
      throw new Error(`/licenses/THIRD_PARTY_NOTICES.txt answered ${notices.status} ${type}`);
    }
    if (!notices.body.startsWith("# Third-party notices")) {
      throw new Error("/licenses/THIRD_PARTY_NOTICES.txt is not THIRD_PARTY_NOTICES.md");
    }
    return `200 ${type}, ${notices.body.length} characters`;
  });

  await check.step("worker and scheduler have registered", async () => {
    const rows = await stack.sql(
      `select role || ' ' || version || ' ' || coalesce(details->>'state', '?') || ' ' || instance_id
         from service_heartbeats
        where beat_at > now() - interval '2 minutes' and role in ('worker', 'scheduler')
        order by role, instance_id`,
    );
    const beats = rows
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(" "));
    const roles = new Set(beats.map(([role]) => role));
    for (const role of ["worker", "scheduler"]) {
      if (!roles.has(role)) {
        throw new Error(`no fresh ${role} heartbeat in service_heartbeats`);
      }
    }
    return beats.map(([role, version, state]) => `${role} ${version} (${state})`).join("; ");
  });

  await check.step("no container is restarting or unhealthy", async () => {
    const containers = await stack.containers();
    const problems = [];
    const notes = [];
    for (const [service, info] of Object.entries(containers)) {
      if (
        ["postgres", "api", "worker", "scheduler", "caddy", "dovecot", "garage"].includes(service)
      ) {
        if (info.state !== "running" || info.health === "unhealthy") {
          problems.push(`${service} is ${info.state} ${info.health}`);
        }
        if (info.restarts > 0) {
          notes.push(`${service} restarted ${info.restarts}x`);
        }
      }
    }
    if (problems.length > 0) {
      throw new Error(problems.join("; "));
    }
    return notes.length > 0
      ? `all running; ${notes.join(", ")}`
      : "all containers running, none restarted";
  });
}
