import {
  type GuardTarget,
  type RestoreModeDetectionInput,
  RestoreModeGuard,
  type RestoreModeSnapshot,
  type RestoreModeStore,
  resolveStorageTargets,
  type StorageTargets,
  type TargetProgress,
} from "@restow/core";
import {
  activateRestoreMode,
  type Database,
  detectedHoldBoundary,
  drizzleQueryable,
  readInstallationIdentity,
  readRestoreMode,
  readStorageProgress,
  rebaseStorageProgress,
  recordRestoreModeRefusal,
  recordStorageProgressCheck,
  storageTargets,
} from "@restow/db";
import { asc, eq } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { withTenantTx } from "../../lib/tenant-context.js";
import { currentDefaultStorage, tenantSecretReader } from "../restore/storage.js";
import { raiseInstallationEvent } from "../updates/notify.js";

/**
 * The deletion guard of the api and the command line (@restow/core storage/deletion-guard.ts,
 * docs/STORAGE.md "Restore mode and progress markers"): the same decision as the worker's, on
 * the installation pool. The api deletes little itself (a failed enrollment's own repository,
 * a cancelled upload's staging area, a container chain that is reset); the Restore mode page and
 * `restow restore-mode` use it to compare every tenant's storage with the database.
 */

export const RESTORE_MODE_EVENT = "installation.restore_mode";

export const RESTORE_MODE_AUDIT_ACTIONS = {
  started: "installation.restore_mode.started",
  detected: "installation.restore_mode.detected",
  ended: "installation.restore_mode.ended",
  keysImported: "installation.restore_mode.keys_imported",
} as const;

/** When this api process started (this module is loaded at start): see `detectedHoldBoundary`. */
const PROCESS_STARTED_AT = new Date();

export class ApiRestoreModeStore implements RestoreModeStore {
  private installation: Promise<string | null> | null = null;

  constructor(
    private readonly db: Database,
    private readonly processStartedAt: Date | null = PROCESS_STARTED_AT,
  ) {}

  async read(): Promise<RestoreModeSnapshot> {
    const state = await readRestoreMode(this.db.$client);
    return {
      active: state.active,
      id: state.id,
      activatedAt: state.activatedAt,
      holdJobsBefore: state.holdJobsBefore,
      keepUnknownBefore: state.keepUnknownBefore,
    };
  }

  readDbSeq(tenantId: string): Promise<number> {
    return readStorageProgress(this.db.$client, tenantId);
  }

  async readDbKeyMax(tenantId: string): Promise<number> {
    const { rows } = await this.db.$client.query<{ version: number | null }>(
      "SELECT max(key_version) AS version FROM tenant_keys WHERE tenant_id = $1::uuid",
      [tenantId],
    );
    return Number(rows[0]?.version ?? 0);
  }

  installationId(): Promise<string | null> {
    this.installation ??= readInstallationIdentity(this.db.$client).catch((error) => {
      this.installation = null;
      throw error;
    });
    return this.installation;
  }

  async recordCheck(tenantId: string, result: TargetProgress): Promise<void> {
    await recordStorageProgressCheck(this.db.$client, {
      tenantId,
      targetId: result.targetId,
      outcome: result.outcome,
      storageMaxSeq: result.storageMaxSeq,
      dbSeq: result.dbSeq,
      unknownKeyVersions: result.unknownKeyVersions,
      detail: result.detail,
    });
  }

  async activateDetected(
    detection: RestoreModeDetectionInput,
  ): Promise<{ id: string; created: boolean }> {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const queryable = drizzleQueryable(tx);
      // Hold the jobs of the restored dump only, not new backups queued since the start.
      const holdJobsBefore = await detectedHoldBoundary(queryable, this.processStartedAt);
      const activated = await activateRestoreMode(queryable, {
        source: "detected",
        reason: "A storage target shows progress the database does not have.",
        actor: { label: "system:api" },
        detection: { ...detection, keyVersions: [...detection.keyVersions] },
        now,
        holdJobsBefore,
      });
      if (activated.created) {
        const details = {
          tenantId: detection.tenantId,
          targetId: detection.targetId,
          markerSeq: detection.markerSeq,
          dbSeq: detection.dbSeq,
          keyVersions: [...detection.keyVersions],
          restoreModeId: activated.id,
          objectName: "restore mode",
        };
        await audit(tx, {
          tenantId: null,
          actor: "system",
          action: RESTORE_MODE_AUDIT_ACTIONS.detected,
          target: activated.id,
          targetType: "installation",
          details,
        });
        await raiseInstallationEvent(tx, {
          event: RESTORE_MODE_EVENT,
          level: "error",
          message:
            "Restore mode is on: a storage target shows progress the database does not have. Nothing is deleted until a provider owner ends it.",
          details,
          now,
        });
      }
      return activated;
    });
  }

  async recordRefusal(input: {
    restoreModeId: string;
    tenantId: string | null;
    pass: string;
    sample?: Record<string, unknown>;
  }): Promise<void> {
    await recordRestoreModeRefusal(this.db.$client, input);
  }

  async rebaseAbove(tenantId: string, to: number): Promise<void> {
    await rebaseStorageProgress(this.db.$client, tenantId, to);
  }
}

/** The tenant's targets as the guard compares them: primary and copies, with their ids. */
export async function tenantStorageTargets(
  db: Database,
  tenantId: string,
): Promise<{ targets: GuardTarget[]; previous: GuardTarget[]; storage: StorageTargets }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(storageTargets)
      .where(eq(storageTargets.tenantId, tenantId))
      .orderBy(asc(storageTargets.createdAt));
    const resolved = await resolveStorageTargets(rows, {
      secrets: tenantSecretReader(tx, tenantId),
      defaults: async () => {
        const storage = await currentDefaultStorage();
        return { primary: storage.primary, copies: [...storage.copies] };
      },
    });
    const all = resolved.targets ?? [];
    return {
      targets: all
        .filter((target) => target.role !== "previous")
        .map((target) => ({ id: target.id, backend: target.backend })),
      previous: all
        .filter((target) => target.role === "previous")
        .map((target) => ({ id: target.id, backend: target.backend })),
      storage: { primary: resolved.primary, copies: resolved.copies },
    };
  });
}

/** A guard over `db` (the installation pool), comparing with {@link tenantStorageTargets}. */
export function createApiRestoreModeGuard(
  db: Database,
  log: (level: "info" | "warn" | "error", message: string, fields?: object) => void = (
    level,
    message,
    fields,
  ) =>
    (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(
      JSON.stringify({ level, component: "restore-mode", message, ...fields }),
    ),
): RestoreModeGuard {
  const logger = {
    debug: () => undefined,
    info: (message: string, fields?: object) => log("info", message, fields),
    warn: (message: string, fields?: object) => log("warn", message, fields),
    error: (message: string, fields?: object) => log("error", message, fields),
    child() {
      return logger;
    },
  };
  return new RestoreModeGuard({
    store: new ApiRestoreModeStore(db),
    targetsOf: async (tenantId) => (await tenantStorageTargets(db, tenantId)).targets,
    logger,
  });
}
