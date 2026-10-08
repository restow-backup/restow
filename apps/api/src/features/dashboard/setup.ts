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
  /**
   * Machines with the agent (servers, clients) of the tenant: active ones, the
   * ones with a good backup, enabled machine backup jobs, and restore checks of
   * machines (all, and the passed ones). A tenant that protects only machines
   * finishes the checklist with them.
   */
  machines: {
    active: number;
    backedUp: number;
    enabledJobs: number;
    checks: number;
    greenChecks: number;
  };
  mail: { configured: boolean; lastTestOk: boolean | null; notNeeded: boolean };
}

type Judgement = Pick<SetupItemDto, "state" | "reason">;

const done: Judgement = { state: "done", reason: null };
const open = (reason: string | null = null): Judgement => ({ state: "open", reason });
const attention = (reason: string): Judgement => ({ state: "attention", reason });
const notNeeded = (reason: string): Judgement => ({ state: "not_needed", reason });

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

function judgeSource(sources: SetupFacts["sources"], machines: number): Judgement {
  // A machine whose agent reported in is a connected source too.
  if (sources.active > 0 || machines > 0) {
    return done;
  }
  if (sources.error > 0) {
    return attention("source_error");
  }
  return open(sources.pending > 0 ? "consent_pending" : null);
}

function judgeVerification(facts: SetupFacts): Judgement {
  const { verification, machines } = facts;
  if (verification.green > 0 || machines.greenChecks > 0) {
    return done;
  }
  return verification.reports > 0 || machines.checks > 0 ? attention("not_green") : open();
}

/**
 * The notification mail is the one optional step. A transport that sent a test
 * mail settles it. Without a transport the operator skipped the mail step of the
 * setup wizard (or removed the transport later): nothing is mailed, which is a
 * decision, so the step counts as not needed. A configured transport the operator
 * does not want tested can be marked as not needed.
 */
function judgeMail(mail: SetupFacts["mail"]): Judgement {
  if (!mail.configured) {
    return notNeeded("mail_skipped");
  }
  if (mail.lastTestOk === true) {
    return done;
  }
  if (mail.notNeeded) {
    return notNeeded("mail_marked");
  }
  return mail.lastTestOk === null ? open("not_tested") : attention("test_failed");
}

const JUDGE: Readonly<Record<SetupItemId, (facts: SetupFacts) => Judgement>> = {
  storage: (facts) => judgeStorage(facts.storage),
  source: (facts) => judgeSource(facts.sources, facts.machines.active),
  // A machine is a protected object of its own.
  objects: (facts) => (facts.activeObjects > 0 || facts.machines.active > 0 ? done : open()),
  // A machine backup job counts once there is a machine for it to back up.
  schedules: (facts) =>
    facts.enabledBackupSchedules > 0 ||
    (facts.machines.active > 0 && facts.machines.enabledJobs > 0)
      ? done
      : open("no_backup_schedule"),
  firstBackup: (facts) =>
    facts.completedSnapshots > 0 || facts.machines.backedUp > 0 ? done : open(),
  firstVerification: (facts) => judgeVerification(facts),
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
  // An optional step that is not needed is settled like a done one.
  const doneCount = items.filter(
    (item) => item.state === "done" || item.state === "not_needed",
  ).length;
  return {
    complete: doneCount === items.length,
    done: doneCount,
    total: items.length,
    items,
  };
}
