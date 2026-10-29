/**
 * Locked OneDrives and SharePoint sites (HTTP 423).
 *
 * Microsoft locks the OneDrive of an account without a licence, and an admin can lock a site
 * ("no access"): every content request then answers 423 with `notAllowed`/`resourceLocked`
 * ("Access to this site has been blocked"), the drive itself stays listed. A backup that meets
 * such a lock does not fail: the worker confirms it with one cheap read (below), marks the object
 * `orphaned` with the reason `locked` and stops trying (failures/limits.ts). The directory sync
 * must not undo that because the drive is still listed: for every object it knows as locked it
 * asks the same read again and turns it active only on a clean 200 (./plan.ts, ./sites.ts).
 * Anything else (a 404, throttling, a 5xx, a failed batch) proves nothing and keeps the lock; a
 * gone drive or site is left to the regular sync rules, which orphan it without a reason.
 */

import { classifyGraphError } from "../failures/graph.js";
import type { BatchRequest, BatchResponse, GraphClient } from "../graph/client.js";
import { GraphError } from "../graph/errors.js";
import { query } from "../graph/resources/common.js";
import { sitePath } from "../graph/resources/sites.js";

/** Kinds of protected object Microsoft can lock as a whole. */
export type LockableKind = "onedrive" | "site";

/** What the probe found: `locked` (423 lock answer), `unlocked` (200), or unknown (absent). */
export type LockState = "locked" | "unlocked";

/** A known locked object to check again. */
export interface LockTarget {
  readonly kind: LockableKind;
  /** Drive id (OneDrive) or Graph site id (site). */
  readonly externalId: string;
  /** For a readable warning; null when unknown. */
  readonly displayName?: string | null;
}

/**
 * The cheapest read that touches the locked content: the drive's root (OneDrive) or the site's
 * default library root (site), id only. The same path as the backup's own first read, so a lock
 * Microsoft lifts shows here exactly when a backup would get through again.
 */
export function lockProbeRequest(kind: LockableKind, externalId: string): BatchRequest {
  const select = query({ $select: "id" });
  return {
    id: `lock:${externalId}`,
    method: "GET",
    url:
      kind === "onedrive"
        ? `/drives/${encodeURIComponent(externalId)}/root${select}`
        : `${sitePath(externalId)}/drive/root${select}`,
  };
}

/** True when a probe answer is the drive- or site-level lock (failures/graph.ts). */
export function isLockedAnswer(response: Pick<BatchResponse, "status" | "body">, url: string) {
  if (response.status !== 423) {
    return false;
  }
  return (
    classifyGraphError(
      new GraphError({ status: response.status, method: "GET", url, payload: response.body }),
    ).code === "graph.object_locked"
  );
}

/** A probe that answered neither 200 nor a lock (reported, the lock stays). */
export interface LockProbeFailure {
  readonly target: LockTarget;
  readonly response: Pick<BatchResponse, "status" | "body">;
}

/**
 * Ask Graph once per target whether the lock is still there. A target missing from the result
 * is unknown and must stay as it is; `onFailure` hears about each such answer.
 */
export async function recheckLocked(
  client: GraphClient,
  targets: readonly LockTarget[],
  onFailure: (failure: LockProbeFailure) => void = () => {},
): Promise<Map<string, LockState>> {
  const states = new Map<string, LockState>();
  if (targets.length === 0) {
    return states;
  }
  const requests = targets.map((target) => lockProbeRequest(target.kind, target.externalId));
  const byId = new Map(requests.map((request, index) => [request.id, index]));
  const responses = await client.batch(requests);
  for (const response of responses) {
    const index = byId.get(response.id);
    const target = index === undefined ? undefined : targets[index];
    const request = index === undefined ? undefined : requests[index];
    if (!target || !request) {
      continue;
    }
    if (response.status >= 200 && response.status < 300) {
      states.set(target.externalId, "unlocked");
    } else if (isLockedAnswer(response, request.url)) {
      states.set(target.externalId, "locked");
    } else {
      onFailure({ target, response });
    }
  }
  return states;
}

/**
 * Backup-time confirmation that a OneDrive or site is locked as a whole: true only when the probe
 * answers the lock again, false on a 200, null for anything else. Never throws for a Graph answer.
 */
export async function confirmObjectLocked(
  client: GraphClient,
  kind: LockableKind,
  externalId: string,
): Promise<boolean | null> {
  let states: Map<string, LockState>;
  try {
    states = await recheckLocked(client, [{ kind, externalId }]);
  } catch {
    return null;
  }
  const state = states.get(externalId);
  return state === undefined ? null : state === "locked";
}
