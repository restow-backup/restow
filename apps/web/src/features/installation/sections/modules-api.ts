import { apiFetch } from "@/lib/api";
import type { ModuleId } from "@/lib/modules";

/**
 * The installation's modules (GET/PUT /api/v1/settings/modules, apps/api
 * features/settings/modules.ts): which are on, and what each holds across every tenant.
 */

/** What a module holds, by kind; each is listed only while it is above zero. */
export type ModuleDataKind =
  | "connections"
  | "objects"
  | "archivingJobs"
  | "archives"
  | "machines"
  | "fileShares"
  | "jobs"
  | "nodes"
  | "guests";

export interface ModuleDataCount {
  kind: ModuleDataKind;
  count: number;
}

export interface ModuleState {
  id: ModuleId;
  enabled: boolean;
  data: ModuleDataCount[];
}

export interface ModulesView {
  modules: ModuleState[];
}

export const MODULES_KEY = ["installation", "modules"] as const;

export const fetchModules = () => apiFetch<ModulesView>("/settings/modules", { tenantId: null });

/** Replace the modules that are on (at least one). */
export const saveModules = (enabled: readonly ModuleId[]) =>
  apiFetch<ModulesView>("/settings/modules", {
    method: "PUT",
    body: { enabled },
    tenantId: null,
  });
