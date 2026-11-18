import { db } from "../../db.js";
import { audit } from "../../lib/audit.js";
import { buildRunResticRoute, processLocalLocks } from "../../lib/restic-run-route.js";
import { authFailures } from "../endpoints/agent-auth.js";
import { resolveDatabaseRunCredential } from "./runs.js";

/**
 * /agent/db/restic/:connectionId: the restic REST backend of a database connection's repository
 * for an agent's run (docs/DATABASES.md 4.3, 4.4, 16 "D3"). The credential is the run's own
 * (`<runId>:<token>`, only its hash is stored, made when the agent fetched the run): a backup run
 * writes append-only (the agent never deletes; retention is the server's), a restore run only
 * reads, a run that has ended may only release its own locks.
 */
export const DATABASE_RESTIC_PATH = "/agent/db/restic";

const runLocks = processLocalLocks();

export const databaseResticRoutes = buildRunResticRoute({
  basePath: DATABASE_RESTIC_PATH,
  param: "connectionId",
  realm: "restow-db",
  resolve: (credentials, connectionId) => resolveDatabaseRunCredential(credentials, connectionId),
  locks: (access) => runLocks(access.runId),
  failures: authFailures,
  audit: (access, connectionId, denial) => {
    void audit(db, {
      tenantId: access.tenantId,
      actor: `database-run:${access.runId}`,
      actorUserId: null,
      ip: denial.ip,
      action: "database_connection.restic_denied",
      target: connectionId,
      targetType: "database_connection",
      details: {
        action: denial.action,
        type: denial.type,
        reason: denial.reason,
        method: denial.method,
      },
    }).catch(() => undefined);
  },
});
