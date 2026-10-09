import { Hono } from "hono";
import { clientIp } from "../../lib/request.js";
import { guardBrowserRequest } from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { parseJsonBody, parseOrProblem } from "../../schemas.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { instanceUrl } from "../endpoints/instance-url.js";
import { type NodeEnv, requireNode } from "./node-auth.js";
import {
  enrollNode,
  enrollmentPreflight,
  listing,
  nodeHeartbeat,
  pveEnrollFailures,
  reportInventory,
  taskResult,
  updateOffer,
} from "./node-service.js";
import {
  MAX_FRAME_BYTES,
  commitRun,
  diskHashes,
  finishRun,
  openRun,
  putBlocks,
  queryIncremental,
  resolveVolname,
  restoreBlocks,
  restoreRestic,
  runLog,
  runRestic,
} from "./runs.js";
import {
  blocksQuerySchema,
  commitSchema,
  enrollPreflightSchema,
  enrollSchema,
  finishSchema,
  heartbeatSchema,
  incrementalSchema,
  inventorySchema,
  logSchema,
  openRunSchema,
  runParamSchema,
  snapshotDiskParamSchema,
  snapshotParamSchema,
  taskParamSchema,
  taskResultSchema,
  volnameQuerySchema,
} from "./schemas.js";

/**
 * /agent/pve/v1: the API of restow-pve, the node helper for Proxmox VE
 * (docs/PVE-PROTOCOL.md). JSON over HTTPS except the block upload and the
 * restore reads (application/octet-stream). Enrollment authenticates with the
 * one-time token in its body, everything else with HTTP Basic
 * `nodeId:nodeSecret`.
 *
 *   POST /enroll/preflight                            token -> still valid? the admin's PVE API token, if any
 *   POST /enroll                                      token + cluster facts -> node id and secret
 *   POST /heartbeat                                   state in, tasks out
 *   POST /inventory                                   the guests of this node
 *   POST /tasks/:taskId/result                        how a task ended
 *   GET  /listing                                     the cluster's restore points (storage plugin)
 *   GET  /update                                      a newer helper release, or none
 *   POST /runs                                        open a backup run (backup_init)
 *   POST /runs/:runId/incremental                     which disks have a base (query_incremental)
 *   PUT  /runs/:runId/blocks                          one frame of blocks (binary)
 *   POST /runs/:runId/commit                          seal the restore point (idempotent by commit id)
 *   POST /runs/:runId/finish                          end of the run
 *   POST /runs/:runId/log                             the PVE task log
 *   POST /runs/:runId/restic                          per-run restic credential (containers)
 *   GET  /restore-points?volname=                     a restore point by its PVE volume name
 *   GET  /snapshots/:snapshotId/disks/:device/hashes  the block hash list (binary)
 *   GET  /snapshots/:snapshotId/disks/:device/blocks?from=&count=  blocks of the synthetic full (binary)
 *   POST /snapshots/:snapshotId/restic                read credential for a container restore
 */
export const pveNodeRoutes = new Hono<NodeEnv>();

pveNodeRoutes.post("/enroll", async (c) => {
  const key = clientIp(c) ?? "unknown";
  const now = Date.now();
  if (pveEnrollFailures.isBlocked(key, now)) {
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Too many failed enrollments from this address. Try again later.",
    });
  }
  let input: ReturnType<typeof enrollSchema.parse>;
  try {
    await guardBrowserRequest(c);
    input = await parseJsonBody(c.req, enrollSchema);
  } catch (error) {
    pveEnrollFailures.record(key, now);
    authFailures.record(key, now);
    throw error;
  }
  try {
    const result = await enrollNode(input, clientIp(c));
    c.header("cache-control", "no-store");
    return c.json(result, 201);
  } catch (error) {
    if (error instanceof ProblemError && error.status === 401) {
      pveEnrollFailures.record(key, now);
      authFailures.record(key, now);
    }
    throw error;
  }
});

pveNodeRoutes.post("/enroll/preflight", async (c) => {
  const key = clientIp(c) ?? "unknown";
  const now = Date.now();
  if (pveEnrollFailures.isBlocked(key, now)) {
    throw new ProblemError(429, "Too many requests", {
      type: "urn:restow:problem:rate-limited",
      detail: "Too many failed enrollments from this address. Try again later.",
    });
  }
  let input: ReturnType<typeof enrollPreflightSchema.parse>;
  try {
    await guardBrowserRequest(c);
    input = await parseJsonBody(c.req, enrollPreflightSchema);
  } catch (error) {
    pveEnrollFailures.record(key, now);
    authFailures.record(key, now);
    throw error;
  }
  try {
    const result = await enrollmentPreflight(input.token);
    c.header("cache-control", "no-store");
    return c.json(result);
  } catch (error) {
    if (error instanceof ProblemError && error.status === 401) {
      pveEnrollFailures.record(key, now);
      authFailures.record(key, now);
    }
    throw error;
  }
});

pveNodeRoutes.use("*", requireNode);

pveNodeRoutes.post("/heartbeat", async (c) => {
  const input = await parseJsonBody(c.req, heartbeatSchema);
  c.header("cache-control", "no-store");
  return c.json(await nodeHeartbeat(c.get("node"), input));
});

pveNodeRoutes.post("/inventory", async (c) => {
  const input = await parseJsonBody(c.req, inventorySchema);
  return c.json(await reportInventory(c.get("node"), input.guests));
});

pveNodeRoutes.post("/tasks/:taskId/result", async (c) => {
  const { taskId } = parseOrProblem(taskParamSchema, c.req.param());
  await taskResult(c.get("node"), taskId, await parseJsonBody(c.req, taskResultSchema));
  return c.body(null, 204);
});

pveNodeRoutes.get("/listing", async (c) => {
  c.header("cache-control", "no-store");
  return c.json(await listing(c.get("node")));
});

pveNodeRoutes.get("/update", async (c) => {
  const offer = await updateOffer(c.req.header("x-restow-helper-version") ?? "");
  return c.json(offer ?? { version: "" });
});

pveNodeRoutes.post("/runs", async (c) => {
  const input = await parseJsonBody(c.req, openRunSchema);
  return c.json(await openRun(c.get("node"), input), 201);
});

pveNodeRoutes.post("/runs/:runId/incremental", async (c) => {
  const { runId } = parseOrProblem(runParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, incrementalSchema);
  return c.json(await queryIncremental(c.get("node"), runId, input.devices));
});

pveNodeRoutes.put("/runs/:runId/blocks", async (c) => {
  const { runId } = parseOrProblem(runParamSchema, c.req.param());
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_FRAME_BYTES) {
    throw new ProblemError(413, "Payload Too Large", {
      type: "urn:restow:problem:payload-too-large",
    });
  }
  const body = Buffer.from(await c.req.arrayBuffer());
  if (body.length > MAX_FRAME_BYTES) {
    throw new ProblemError(413, "Payload Too Large", {
      type: "urn:restow:problem:payload-too-large",
    });
  }
  return c.json(await putBlocks(c.get("node"), runId, body));
});

pveNodeRoutes.post("/runs/:runId/commit", async (c) => {
  const { runId } = parseOrProblem(runParamSchema, c.req.param());
  const input = await parseJsonBody(c.req, commitSchema);
  return c.json(await commitRun(c.get("node"), runId, input));
});

pveNodeRoutes.post("/runs/:runId/finish", async (c) => {
  const { runId } = parseOrProblem(runParamSchema, c.req.param());
  await finishRun(c.get("node"), runId, await parseJsonBody(c.req, finishSchema));
  return c.body(null, 204);
});

pveNodeRoutes.post("/runs/:runId/log", async (c) => {
  const { runId } = parseOrProblem(runParamSchema, c.req.param());
  const { log } = await parseJsonBody(c.req, logSchema);
  await runLog(c.get("node"), runId, log);
  return c.body(null, 204);
});

pveNodeRoutes.post("/runs/:runId/restic", async (c) => {
  const { runId } = parseOrProblem(runParamSchema, c.req.param());
  const instance = await instanceUrl(c);
  c.header("cache-control", "no-store");
  return c.json(await runRestic(c.get("node"), runId, instance.url));
});

pveNodeRoutes.get("/restore-points", async (c) => {
  const { volname } = parseOrProblem(volnameQuerySchema, c.req.query());
  return c.json(await resolveVolname(c.get("node"), volname));
});

pveNodeRoutes.get("/snapshots/:snapshotId/disks/:device/hashes", async (c) => {
  const { snapshotId, device } = parseOrProblem(snapshotDiskParamSchema, c.req.param());
  const bytes = await diskHashes(c.get("node"), snapshotId, device);
  return c.body(new Uint8Array(bytes), 200, { "content-type": "application/octet-stream" });
});

pveNodeRoutes.get("/snapshots/:snapshotId/disks/:device/blocks", async (c) => {
  const { snapshotId, device } = parseOrProblem(snapshotDiskParamSchema, c.req.param());
  const { from, count } = parseOrProblem(blocksQuerySchema, c.req.query());
  const bytes = await restoreBlocks(c.get("node"), snapshotId, device, from, count);
  return c.body(new Uint8Array(bytes), 200, { "content-type": "application/octet-stream" });
});

pveNodeRoutes.post("/snapshots/:snapshotId/restic", async (c) => {
  const { snapshotId } = parseOrProblem(snapshotParamSchema, c.req.param());
  const instance = await instanceUrl(c);
  c.header("cache-control", "no-store");
  return c.json(await restoreRestic(c.get("node"), snapshotId, instance.url));
});
