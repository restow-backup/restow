import { apiFetch } from "@/lib/api";
import type {
  CompletenessResult,
  CreateTargetInput,
  DefaultTestResult,
  ProbeInput,
  ProbeOutcome,
  PromoteResult,
  StorageMigrationDto,
  StorageTargetDto,
  StorageTargetList,
  StorageUsage,
  TestResult,
  UpdateTargetInput,
} from "./types";

/**
 * Typed calls against `/api/v1/storage`. Every request is tenant-scoped
 * through the shared `apiFetch` (X-Restow-Tenant from the active tenant).
 */

/** Query keys, scoped by tenant so a tenant switch never shows another tenant's storage. */
export const storageKeys = {
  all: (tenantId: string | null) => ["tenant", tenantId, "storage"] as const,
  targets: (tenantId: string | null) => ["tenant", tenantId, "storage", "targets"] as const,
  usage: (tenantId: string | null) => ["tenant", tenantId, "storage", "usage"] as const,
};

function targetPath(targetId: string, action?: string): string {
  const base = `/storage/targets/${encodeURIComponent(targetId)}`;
  return action ? `${base}/${action}` : base;
}

export function fetchTargets(): Promise<StorageTargetList> {
  return apiFetch<StorageTargetList>("/storage/targets");
}

export function fetchUsage(): Promise<StorageUsage> {
  return apiFetch<StorageUsage>("/storage/usage");
}

export function createTarget(input: CreateTargetInput): Promise<StorageTargetDto> {
  return apiFetch<StorageTargetDto>("/storage/targets", { method: "POST", body: input });
}

export function updateTarget(
  targetId: string,
  patch: UpdateTargetInput,
): Promise<StorageTargetDto> {
  return apiFetch<StorageTargetDto>(targetPath(targetId), { method: "PATCH", body: patch });
}

export function deleteTarget(targetId: string): Promise<void> {
  return apiFetch<void>(targetPath(targetId), { method: "DELETE" });
}

/** Probe the stored target and record the result with it. */
export function testTarget(targetId: string): Promise<TestResult> {
  return apiFetch<TestResult>(targetPath(targetId, "test"), { method: "POST" });
}

/** Probe settings from the form; nothing is saved. */
export function probeSettings(input: ProbeInput): Promise<ProbeOutcome> {
  return apiFetch<ProbeOutcome>("/storage/targets/probe", { method: "POST", body: input });
}

export function testInstallationDefault(): Promise<DefaultTestResult> {
  return apiFetch<DefaultTestResult>("/storage/installation-default/test", { method: "POST" });
}

export function checkCompleteness(targetId: string): Promise<CompletenessResult> {
  return apiFetch<CompletenessResult>(targetPath(targetId, "completeness"), { method: "POST" });
}

export function promoteTarget(targetId: string): Promise<PromoteResult> {
  return apiFetch<PromoteResult>(targetPath(targetId, "promote"), { method: "POST" });
}

/** Cancel the storage migration replacing the primary with `targetId` (its destination). */
export function cancelMigration(targetId: string): Promise<StorageMigrationDto> {
  return apiFetch<StorageMigrationDto>(targetPath(targetId, "migration/cancel"), {
    method: "POST",
  });
}

/** Re-queue a failed "move" replacing the primary with `targetId`, with a fresh job. */
export function retryMigration(targetId: string): Promise<StorageMigrationDto> {
  return apiFetch<StorageMigrationDto>(targetPath(targetId, "migration/retry"), { method: "POST" });
}
