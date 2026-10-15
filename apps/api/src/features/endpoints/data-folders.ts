import { effectiveSettings, type JobMemberOverrides, missingDataFolders } from "@restow/core";
import type { BackupJob, Endpoint } from "@restow/db";
import type { DataFoldersDto, MachineDto } from "./dto.js";

/**
 * What the machine's page says about the data folders its agent found (#59): which of them the
 * machine's job leaves out, with the folders and exclusions of the job as they apply to this
 * machine (its own folders, if it has some in the job). Null when the agent reports none (an agent
 * before 0.4.0, or macOS).
 */
export function dataFoldersOf(
  endpoint: Pick<Endpoint, "settings">,
  entry: { job: BackupJob; overrides: JobMemberOverrides } | null,
): DataFoldersDto | null {
  const facts = endpoint.settings.agent;
  const folders = facts?.dataFolders;
  if (!folders) {
    return null;
  }
  if (!entry) {
    return { folders, missing: [], reportedAt: facts.reportedAt ?? null, ownFolders: false };
  }
  const settings = effectiveSettings(entry.job.settings ?? {}, entry.overrides);
  return {
    folders,
    missing: missingDataFolders(folders, {
      paths: settings.paths ?? [],
      excludes: settings.excludes ?? [],
    }),
    reportedAt: facts.reportedAt ?? null,
    ownFolders: entry.overrides.paths !== undefined || entry.overrides.excludes !== undefined,
  };
}

/** Container, VM, desktop as the agent reported them, and why the machine got the server profile. */
export function machineOf(endpoint: Pick<Endpoint, "settings">): MachineDto {
  return {
    facts: endpoint.settings.agent?.machine ?? null,
    profileDetection: endpoint.settings.profileDetection ?? null,
  };
}
