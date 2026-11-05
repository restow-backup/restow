import { type Context, Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { config } from "../config.js";
import { assertDeclaredLength, readSegmentBody } from "../features/imports/body.js";
import { updaterClient } from "../features/updates/instance.js";
import {
  type UpdaterClient,
  UpdaterRejectedError,
  UpdaterUnavailableError,
} from "../features/updates/updater-client.js";
import { clientIp } from "../lib/request.js";
import {
  retireSetupToken,
  SETUP_TOKEN_HEADER,
  setupTokenMatches,
  setupTokenProblem,
} from "../lib/setup-token.js";
import { DEMO_READ_ONLY_PROBLEM } from "../middleware/demo-guard.js";
import { guardBrowserRequest } from "../middleware/session.js";
import { ProblemError } from "../problem.js";
import { parseOrProblem, readJsonBody } from "../schemas.js";
import type { RestoreRecord } from "../updater/restore-protocol.js";
import { UPLOAD_PART_BYTES, uploadStartSchema } from "../updater/restore-protocol.js";

/**
 * Restoring an installation from a database dump in the setup wizard (docs/DATABASE.md, "Restore
 * an installation from a dump"), mounted at /api/v1/setup/restore. The work is the opt-in
 * updater's (updater/restore.ts): it alone can stop and start services and run pg_restore. These
 * routes relay the wizard's calls to it:
 *
 *   GET    /                         whether a restore is possible here, the updater's kept
 *                                    dumps, the restore and its report
 *   POST   /uploads                  begin uploading a dump: { bytes, sha256 }
 *   PUT    /uploads/:id?offset=N     one part (application/octet-stream, at most 32 MiB)
 *   POST   /uploads/:id/complete     the checksum is checked; the upload becomes a dump
 *   POST   /start                    restore a dump and prepare it: { dump }
 *   POST   /activate                 put it live: { confirm: true, acceptUnreachable? }
 *   POST   /abort                    drop it again
 *
 * Every route requires the setup token (a fresh installation is reached by anyone who knows its
 * address: without it they could restore a dump of their own and take it over), an installation
 * whose setup has not completed, a request from the web app itself (JSON, or the raw part), and
 * no demo mode. The setup token, the disclaimer, the operating mode, the first admin and the
 * mail step of a new installation do not apply: the dump brings its users and settings; the
 * token is retired once the restore is activated.
 */

export const RESTORE_UNAVAILABLE_PROBLEM = "urn:restow:problem:restore-unavailable";
export const RESTORE_REFUSED_PROBLEM = "urn:restow:problem:restore-refused";

/** Why a restore cannot be done in the wizard here. */
export type RestoreUnavailableReason =
  | "updater_disabled"
  | "updater_unreachable"
  | "updater_incompatible"
  | "demo";

export interface SetupRestoreDeps {
  readonly updater: UpdaterClient;
  /** Whether the setup has completed (setup.ts `isConfigured` of the settings row). */
  readonly configured: () => Promise<boolean>;
}

const startSchema = z.object({ dump: z.string().min(1).max(200) }).strict();
const activateSchema = z
  .object({ confirm: z.literal(true), acceptUnreachable: z.boolean().optional() })
  .strict();

function unavailableReason(error: UpdaterUnavailableError): RestoreUnavailableReason {
  return error.reason === "disabled"
    ? "updater_disabled"
    : error.reason === "incompatible"
      ? "updater_incompatible"
      : "updater_unreachable";
}

/** The updater's answer as a problem the wizard explains. */
function relayed(error: unknown): never {
  if (error instanceof UpdaterUnavailableError) {
    throw new ProblemError(503, "Restore not available", {
      type: RESTORE_UNAVAILABLE_PROBLEM,
      detail:
        "The updater does not answer, so the wizard cannot restore a dump here. Use install.sh --restore on the server (docs/DATABASE.md).",
      extensions: { reason: unavailableReason(error) },
    });
  }
  if (error instanceof UpdaterRejectedError) {
    const body = error.body as { code?: string; message?: string } | null;
    throw new ProblemError(
      error.status === 404 ? 404 : error.status === 422 ? 422 : 409,
      "Restore refused",
      {
        type: RESTORE_REFUSED_PROBLEM,
        detail:
          typeof body?.message === "string" ? body.message.slice(0, 500) : "The updater refused.",
        extensions: { code: error.code },
      },
    );
  }
  throw error;
}

/** What the wizard may see of the restore: no requester's address. */
function operationOf(record: RestoreRecord | null | undefined) {
  if (!record) {
    return null;
  }
  const { requestedBy: _requestedBy, ...rest } = record;
  return rest;
}

const actorOf = (c: Context) => ({ userId: null, label: "setup wizard", ip: clientIp(c) });

export function buildSetupRestoreRoutes(deps: SetupRestoreDeps): Hono {
  const routes = new Hono();

  const gate: MiddlewareHandler = async (c, next) => {
    await guardBrowserRequest(c, { allowOctetStream: c.req.method === "PUT" });
    if (config.demo.enabled) {
      // Reads stay reachable in the demo (middleware/demo-guard.ts): it simply restores nothing.
      if (c.req.method === "GET") {
        return c.json({
          available: false,
          reason: "demo",
          dumps: [],
          operation: null,
          partBytes: UPLOAD_PART_BYTES,
        });
      }
      throw new ProblemError(403, "Demo installation is read-only", {
        type: DEMO_READ_ONLY_PROBLEM,
        detail: "A demo installation restores no dumps.",
      });
    }
    if (await deps.configured()) {
      throw new ProblemError(409, "Already configured", {
        type: "urn:restow:problem:already-configured",
        detail: "The installation is set up; a dump is restored only into a fresh installation.",
      });
    }
    if (!setupTokenMatches(c.req.header(SETUP_TOKEN_HEADER), config.setupToken)) {
      throw setupTokenProblem();
    }
    await next();
  };
  routes.use("*", gate);

  routes.get("/", async (c) => {
    let state: Awaited<ReturnType<UpdaterClient["state"]>> = null;
    let reason: RestoreUnavailableReason | null = null;
    try {
      state = deps.updater.enabled ? await deps.updater.state({ fresh: true }) : null;
      if (!state) {
        reason = deps.updater.enabled ? "updater_unreachable" : "updater_disabled";
      }
    } catch (error) {
      if (!(error instanceof UpdaterUnavailableError)) {
        throw error;
      }
      reason = unavailableReason(error);
    }
    return c.json({
      available: state !== null,
      reason,
      dumps: state?.capabilities.dumps ?? [],
      operation: operationOf(state?.restore),
      partBytes: UPLOAD_PART_BYTES,
    });
  });

  routes.post("/uploads", async (c) => {
    const input = parseOrProblem(uploadStartSchema, await readJsonBody(c.req));
    try {
      return c.json(await deps.updater.startDumpUpload(input), 201);
    } catch (error) {
      relayed(error);
    }
  });

  routes.put("/uploads/:id", async (c) => {
    const offset = Number(c.req.query("offset") ?? "");
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new ProblemError(422, "Validation failed", { detail: "The part needs ?offset=N." });
    }
    const declared = Number(c.req.header("content-length") ?? "");
    if (!Number.isInteger(declared) || declared <= 0 || declared > UPLOAD_PART_BYTES) {
      throw new ProblemError(422, "Validation failed", {
        detail: `A part has a Content-Length of 1 to ${UPLOAD_PART_BYTES} bytes.`,
      });
    }
    assertDeclaredLength(c.req.header("content-length"), declared);
    const part = await readSegmentBody(c.req.raw.body, declared);
    try {
      return c.json(await deps.updater.putDumpPart(c.req.param("id"), offset, part));
    } catch (error) {
      relayed(error);
    }
  });

  routes.post("/uploads/:id/complete", async (c) => {
    try {
      return c.json({ dump: await deps.updater.completeDumpUpload(c.req.param("id")) });
    } catch (error) {
      relayed(error);
    }
  });

  routes.post("/start", async (c) => {
    const input = parseOrProblem(startSchema, await readJsonBody(c.req));
    try {
      const state = await deps.updater.startRestore({ dump: input.dump, requestedBy: actorOf(c) });
      return c.json({ operation: operationOf(state.restore) }, 202);
    } catch (error) {
      relayed(error);
    }
  });

  routes.post("/activate", async (c) => {
    const input = parseOrProblem(activateSchema, await readJsonBody(c.req));
    try {
      const state = await deps.updater.activateRestore({
        acceptUnreachable: input.acceptUnreachable === true,
        requestedBy: actorOf(c),
      });
      // The restored installation has its users: the token of a new one has served its purpose.
      retireSetupToken();
      return c.json({ operation: operationOf(state.restore) }, 202);
    } catch (error) {
      relayed(error);
    }
  });

  routes.post("/abort", async (c) => {
    await readJsonBody(c.req).catch(() => null);
    try {
      const state = await deps.updater.abortRestore({ requestedBy: actorOf(c) });
      return c.json({ operation: operationOf(state.restore) }, 202);
    } catch (error) {
      relayed(error);
    }
  });

  return routes;
}

/** Whether a restore runs or waits for its confirmation (POST /setup refuses meanwhile). */
export async function restoreInProgress(updater: UpdaterClient = updaterClient): Promise<boolean> {
  try {
    const state = updater.enabled ? await updater.state() : null;
    const status = state?.restore?.status;
    return status === "running" || status === "awaiting_confirmation";
  } catch {
    return false;
  }
}

/** Statuses whose one-line reason the public setup state carries (the Done step shows it). */
const PUBLIC_MESSAGE_STATUSES: ReadonlySet<RestoreRecord["status"]> = new Set([
  "failed",
  "needs_attention",
]);

/**
 * The public view for GET /setup/state: whether a restore is possible, and how it stands. The
 * setup token is retired once a restore is activated and a restarted api has a new one, so the
 * Done step of the wizard learns from here alone that the activation did not finish: then the
 * updater's one-line reason (redacted, no report, no requester) comes along.
 */
export async function restoreAvailability(updater: UpdaterClient = updaterClient): Promise<{
  available: boolean;
  status: RestoreRecord["status"] | null;
  phase: RestoreRecord["phase"] | null;
  message: string | null;
}> {
  try {
    const state = updater.enabled ? await updater.state() : null;
    const restore = state?.restore ?? null;
    return {
      available: state !== null,
      status: restore?.status ?? null,
      phase: restore?.phase ?? null,
      message:
        restore && PUBLIC_MESSAGE_STATUSES.has(restore.status) && restore.message
          ? restore.message.slice(0, 300)
          : null,
    };
  } catch {
    return { available: false, status: null, phase: null, message: null };
  }
}
