import type { Database } from "@restow/db";
import { countEndpoints } from "../../routes/v1/endpoints.js";
import type { EndpointSummaryDto } from "../endpoints/dto.js";
import { listEndpoints } from "../endpoints/service.js";
import type { EndpointsWidget } from "./dto.js";

/**
 * The endpoints widget of the start page: how many servers and clients are
 * under protection (in a backup job), how many are in none, and which of them are not proven restorable or failed
 * their last backup. Everything is derived from the endpoint list the
 * Servers and Clients pages show (`listEndpoints`), so the numbers agree with
 * those pages, with the recovery-readiness page (the same rating per machine,
 * `readiness.state`) and with `endpoints` of the integration API's GET /status
 * (`countEndpoints`).
 */

/** The widget from the endpoint list of a tenant (pure); revoked endpoints are not protected and left out. */
export function summarizeEndpoints(items: readonly EndpointSummaryDto[]): EndpointsWidget {
  const active = items.filter((item) => item.status === "active");
  const counts = countEndpoints(items);
  const stateCount = (state: EndpointSummaryDto["readiness"]["state"]) =>
    active.filter((item) => item.readiness.state === state).length;
  const readiness = {
    green: stateCount("green"),
    yellow: stateCount("yellow"),
    red: stateCount("red"),
    unverified: stateCount("unverified"),
    noBackup: stateCount("no_backup"),
  };
  return {
    // A machine in no backup job is not backed up (release 0.2.1): it is not protected, whatever
    // an old backup of it scores.
    protected: counts.total - counts.withoutJob,
    machines: counts.total,
    withoutJob: counts.withoutJob,
    servers: counts.servers,
    clients: counts.clients,
    readiness,
    // Not proven restorable, by the rule every overview follows: a backup without
    // a verified restore counts as failed (docs/TESTING.md), so neither an
    // unverified machine nor one without a backup is ever counted as fine.
    notReady: readiness.red + readiness.unverified + readiness.noBackup,
    failedLastBackup: counts.failedLastBackup,
    needingAttention: counts.needingAttention,
    otherAttention: active.filter((item) => item.attention.some((reason) => reason !== "no_job"))
      .length,
    lastSuccessAt: counts.lastSuccessAt,
  };
}

export async function loadEndpointsWidget(
  db: Database,
  tenantId: string,
  now: Date,
): Promise<EndpointsWidget> {
  return summarizeEndpoints((await listEndpoints(db, tenantId, {}, now)).items);
}
