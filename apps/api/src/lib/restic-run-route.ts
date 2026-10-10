import {
  type ResticLockRegistry,
  type StorageBackend,
  handleResticRequest,
  parseBasicAuthorization,
} from "@restow/core";
import { type Context, Hono } from "hono";
import { ProblemError } from "../problem.js";
import { clientIp } from "./request.js";
import { isUuid } from "./tenant-context.js";

/**
 * The restic REST backend for runs that hold a per-run credential (docs/FILESHARES.md
 * 5.3): a Proxmox VE container backup (features/pve/restic-route.ts, under
 * /agent/pve/restic) and a file share runner (features/file-shares/restic-route.ts,
 * under /internal/file-shares/restic). One builder: parse the HTTP Basic credential
 * (`<runId>:<token>`), let the feature resolve it to a tenant, a repository prefix and
 * a principal, then serve the request with the shared restic REST handler
 * (packages/core/src/endpoints/restic-rest.ts) under the append-only `agent` or the
 * read-only `reader` principal. Failed credentials count against the per-address
 * limiter of the agent routes; refusals of the authorization matrix are audited by
 * the feature.
 */

/** What a valid run credential gives access to. */
export interface RunResticAccess {
  tenantId: string;
  runId: string;
  /** `agent`: append-only (backups). `reader`: read-only (restores). */
  principal: "agent" | "reader";
  /** Storage prefix of the repository, with a trailing slash. */
  prefix: string;
  storage: StorageBackend;
}

/**
 * `invalid`: no such run, the token does not match, or another repository (401, and
 * it counts as a failed credential). `expired`: the run has ended or its tenant is
 * not active (401 "Credential expired", not counted).
 */
export type RunResticResolution =
  | { ok: true; access: RunResticAccess }
  | { ok: false; reason: "invalid" | "expired" };

/** A per-address counter of failed credentials (features/endpoints/agent-auth.ts authFailures). */
export interface CredentialFailures {
  isBlocked(key: string, now: number): boolean;
  record(key: string, now: number): void;
}

export interface RunResticDenial {
  action: string;
  /** The restic type or `config` / `repository`. */
  type: string;
  reason: string;
  method: string;
  ip: string | null;
}

export interface RunResticRouteOptions {
  /** Where the routes are mounted, e.g. `/internal/file-shares/restic`. */
  basePath: string;
  /** The name of the repository path parameter (`guestId`, `shareId`). */
  param: string;
  /** The HTTP Basic realm of the 401 answers. */
  realm: string;
  /** What the credential may access in the repository `repoId` (a UUID). */
  resolve(
    credentials: { runId: string; token: string },
    repoId: string,
    now: number,
  ): Promise<RunResticResolution>;
  /** The lock registry of the run's own locks (append-only principal). */
  locks(access: RunResticAccess, repoId: string): ResticLockRegistry;
  /** Bytes the run may still add (budgets), or null for no limit. */
  remainingBytes?(access: RunResticAccess, repoId: string): Promise<number | null>;
  /** Problem type and text of a refused upload. */
  quotaProblem?: { type: string; detail: string };
  /** Accounting of allowed requests (bytes written or freed). */
  onAllowed?(
    access: RunResticAccess,
    repoId: string,
    bytes: number,
    action: string,
  ): void | Promise<void>;
  /** Called when an upload was refused because the budget is used up. */
  onQuotaExceeded?(access: RunResticAccess, repoId: string): void | Promise<void>;
  /** Called for every request the authorization matrix refused. */
  audit(access: RunResticAccess, repoId: string, denial: RunResticDenial): void;
  failures: CredentialFailures;
  /**
   * Refuse every request that came through a proxy (`X-Forwarded-For`, `Forwarded`,
   * `Via`) with 404: for routes the edge never forwards (/internal, 2.3).
   */
  internalOnly?: boolean;
}

const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "via"];

/** Process-local registries of the locks each run wrote (restic removes its own at the end). */
export function processLocalLocks(limit = 1000): (runId: string) => ResticLockRegistry {
  const runLocks = new Map<string, Set<string>>();
  return (runId) => {
    const own = runLocks.get(runId) ?? new Set<string>();
    runLocks.set(runId, own);
    if (runLocks.size > limit) {
      runLocks.delete(runLocks.keys().next().value as string);
    }
    return {
      isOwn: async (name) => own.has(name),
      created: async (name) => {
        own.add(name);
      },
      removed: async (name) => {
        own.delete(name);
      },
    };
  };
}

export function buildRunResticRoute(options: RunResticRouteOptions): Hono {
  const app = new Hono();
  app.all(`/:${options.param}/*`, async (c: Context) => {
    if (options.internalOnly && PROXY_HEADERS.some((name) => c.req.header(name) !== undefined)) {
      return c.body(null, 404);
    }
    const repoId = c.req.param(options.param) ?? "";
    const now = Date.now();
    const key = clientIp(c) ?? "unknown";
    if (options.failures.isBlocked(key, now)) {
      throw new ProblemError(429, "Too many requests", { type: "urn:restow:problem:rate-limited" });
    }
    const credentials = parseBasicAuthorization(c.req.header("authorization"));
    const deny = () => {
      options.failures.record(key, now);
      c.header("www-authenticate", `Basic realm="${options.realm}"`);
      return new ProblemError(401, "Unauthorized", { detail: "The run credential is not valid." });
    };
    if (!credentials || !isUuid(credentials.username) || !isUuid(repoId)) {
      throw deny();
    }
    const resolution = await options.resolve(
      { runId: credentials.username, token: credentials.password },
      repoId,
      now,
    );
    if (!resolution.ok) {
      if (resolution.reason === "expired") {
        throw new ProblemError(401, "Credential expired", {
          detail: "The run of this credential has ended.",
        });
      }
      throw deny();
    }
    const { access } = resolution;
    const url = new URL(c.req.url);
    const base = `${options.basePath}/${repoId}`;
    const path = url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : "/";
    return handleResticRequest(c.req.raw, {
      storage: access.storage,
      prefix: access.prefix,
      principal: access.principal,
      path,
      query: url.searchParams,
      locks: options.locks(access, repoId),
      remainingBytes: options.remainingBytes
        ? () =>
            (options.remainingBytes as NonNullable<typeof options.remainingBytes>)(access, repoId)
        : undefined,
      quotaProblem: options.quotaProblem,
      onAllowed: options.onAllowed
        ? ({ action, bytes }) => options.onAllowed?.(access, repoId, bytes, action)
        : undefined,
      onQuotaExceeded: options.onQuotaExceeded
        ? () => options.onQuotaExceeded?.(access, repoId)
        : undefined,
      onDenied: ({ action, resource, reason }) => {
        const type =
          resource.kind === "object" || resource.kind === "list" ? resource.type : resource.kind;
        options.audit(access, repoId, {
          action,
          type,
          reason,
          method: c.req.method,
          ip: clientIp(c),
        });
      },
    });
  });
  return app;
}
