import type { Role } from "../../middleware/rbac.js";
import { isTenantAdmin } from "../../middleware/rbac.js";
import {
  SETUP_ITEM_IDS,
  type SetupItemDto,
  type SetupItemId,
  type SetupWidget,
  type StorageTargetHealth,
} from "./dto.js";

/**
 * The setup checklist: the steps between a fresh tenant and one whose
 * backups are proven restorable, judged from what the database says (never
 * from what the operator clicked). Pure; the facts are loaded in queries.ts.
 */

export interface SetupFacts {
  storage: StorageTargetHealth;
  sources: { active: number; error: number; pending: number };
  activeObjects: number;
  enabledBackupSchedules: number;
  completedSnapshots: number;
  verification: { reports: number; green: number };
  mail: { configured: boolean; lastTestOk: boolean | null };
}

type Judgement = Pick<SetupItemDto, "state" | "reason">;

const done: Judgement = { state: "done", reason: null };
const open = (reason: string | null = null): Judgement => ({ state: "open", reason });
const attention = (reason: string): Judgement => ({ state: "attention", reason });

function judgeStorage(storage: StorageTargetHealth): Judgement {
  switch (storage.status) {
    case "ok":
      return done;
    case "error":
      return attention("target_error");
    case "misconfigured":
      return attention("default_misconfigured");
    case "unverified":
      return open(storage.source === "tenant" ? "target_unverified" : "default_untested");
  }
}

function judgeSource(sources: SetupFacts["sources"]): Judgement {
  if (sources.active > 0) {
    return done;
  }
  if (sources.error > 0) {
    return attention("source_error");
  }
  return open(sources.pending > 0 ? "consent_pending" : null);
}

function judgeVerification(verification: SetupFacts["verification"]): Judgement {
  if (verification.green > 0) {
    return done;
  }
  return verification.reports > 0 ? attention("not_green") : open();
}

function judgeMail(mail: SetupFacts["mail"]): Judgement {
  if (!mail.configured) {
    return open("not_configured");
  }
  if (mail.lastTestOk === null) {
    return open("not_tested");
  }
  return mail.lastTestOk ? done : attention("test_failed");
}

const JUDGE: Readonly<Record<SetupItemId, (facts: SetupFacts) => Judgement>> = {
  storage: (facts) => judgeStorage(facts.storage),
  source: (facts) => judgeSource(facts.sources),
  objects: (facts) => (facts.activeObjects > 0 ? done : open()),
  schedules: (facts) => (facts.enabledBackupSchedules > 0 ? done : open("no_backup_schedule")),
  firstBackup: (facts) => (facts.completedSnapshots > 0 ? done : open()),
  firstVerification: (facts) => judgeVerification(facts.verification),
  notificationMail: (facts) => judgeMail(facts.mail),
};

/**
 * Who may fix an item: the notification mail is installation-wide (provider
 * admins, in the settings); everything else belongs to the tenant's admins.
 */
export function canActOn(id: SetupItemId, role: Role): boolean {
  return id === "notificationMail" ? role === "provider_admin" : isTenantAdmin(role);
}

export function buildSetupChecklist(facts: SetupFacts, role: Role): SetupWidget {
  const items = SETUP_ITEM_IDS.map((id) => ({
    id,
    ...JUDGE[id](facts),
    actionable: canActOn(id, role),
  }));
  const doneCount = items.filter((item) => item.state === "done").length;
  return {
    complete: doneCount === items.length,
    done: doneCount,
    total: items.length,
    items,
  };
}
