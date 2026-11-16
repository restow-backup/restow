import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

import { storageKeys } from "./api";
import { ToneLine } from "./components/status";
import { STORAGE_NAMESPACE } from "./i18n";
import type { Tone } from "./presenters";

/**
 * The copies of the tenant's restic repositories (docs/STORAGE.md, "restic repositories on
 * copies"): the repositories of containers, machines and file shares are kept on every copy
 * target as well. GET /api/v1/storage/repository-copies sums them per copy target ("x of y
 * repositories current", administrators); GET /storage/repository-copies/objects/:id lists the
 * copies of one object's repository (every member, on the object's page).
 */

export type RepositoryCopyState = "pending" | "current" | "behind" | "failed";

export interface RepositoryCopy {
  prefix: string;
  kind: "container" | "machine" | "file_share";
  ownerId: string;
  targetId: string;
  targetName: string | null;
  state: RepositoryCopyState;
  primarySnapshots: number;
  missingSnapshots: number;
  lastSnapshotId: string | null;
  lastCopiedAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastDataCheckAt: string | null;
  deletionsDeferred: string | null;
  troubleSince: string | null;
}

export interface RepositoryCopyTarget {
  targetId: string;
  targetName: string | null;
  total: number;
  current: number;
  behind: number;
  failed: number;
  pending: number;
}

export interface RepositoryCopies {
  targets: RepositoryCopyTarget[];
  repositories: RepositoryCopy[];
}

export function fetchRepositoryCopies(): Promise<RepositoryCopies> {
  return apiFetch<RepositoryCopies>("/storage/repository-copies");
}

export function fetchObjectCopies(ownerId: string): Promise<{ copies: RepositoryCopy[] }> {
  return apiFetch<{ copies: RepositoryCopy[] }>(
    `/storage/repository-copies/objects/${encodeURIComponent(ownerId)}`,
  );
}

export function useRepositoryCopies(enabled = true) {
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  return useQuery({
    queryKey: [...storageKeys.all(tenantId), "repository-copies"] as const,
    queryFn: fetchRepositoryCopies,
    enabled: enabled && session.status === "authenticated" && tenantId !== null,
    staleTime: 60_000,
  });
}

export function useObjectCopies(ownerId: string | null | undefined) {
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  return useQuery({
    queryKey: [...storageKeys.all(tenantId), "repository-copies", "object", ownerId] as const,
    queryFn: () => fetchObjectCopies(ownerId as string),
    enabled: session.status === "authenticated" && tenantId !== null && Boolean(ownerId),
    staleTime: 60_000,
  });
}

const STATE_TONE: Record<RepositoryCopyState, Tone> = {
  current: "ok",
  behind: "warning",
  pending: "neutral",
  failed: "destructive",
};

/**
 * "x of y repositories current" on the card of a copy target, with what is behind, failed or not
 * copied yet. Nothing while the tenant has no restic repository.
 */
export function TargetCopySummary({
  summary,
}: {
  summary: RepositoryCopyTarget | null | undefined;
}) {
  const { t } = useTranslation(STORAGE_NAMESPACE);
  if (!summary || summary.total === 0) {
    return null;
  }
  const tone: Tone =
    summary.failed > 0
      ? "destructive"
      : summary.behind > 0 || summary.pending > 0
        ? "warning"
        : "ok";
  const rest = [
    summary.behind > 0 ? t("repositoryCopies.behindCount", { count: summary.behind }) : null,
    summary.failed > 0 ? t("repositoryCopies.failedCount", { count: summary.failed }) : null,
    summary.pending > 0 ? t("repositoryCopies.pendingCount", { count: summary.pending }) : null,
  ].filter(Boolean);
  return (
    <ToneLine tone={tone}>
      <span data-slot="repository-copies-summary">
        <span className="font-medium">
          {t("repositoryCopies.summary", { current: summary.current, total: summary.total })}
        </span>
        {rest.length > 0 ? (
          <span className="text-muted-foreground"> · {rest.join(", ")}</span>
        ) : null}
      </span>
    </ToneLine>
  );
}

/** {@link TargetCopySummary} for one copy target, read from the tenant's copies. */
export function TargetCopyLine({ targetId }: { targetId: string }) {
  const { data } = useRepositoryCopies();
  return <TargetCopySummary summary={data?.targets.find((t) => t.targetId === targetId)} />;
}

/** One copy of an object's repository: "Copy on <target>: current / n behind / failed (reason)". */
export function CopyStateLine({ copy }: { copy: RepositoryCopy }) {
  const { t } = useTranslation(STORAGE_NAMESPACE);
  const target = copy.targetName ?? t("repositoryCopies.unnamedTarget");
  const state =
    copy.state === "behind"
      ? t("repositoryCopies.state.behind", { count: copy.missingSnapshots })
      : copy.state === "failed"
        ? t("repositoryCopies.state.failed", {
            reason: copy.lastError ?? t("repositoryCopies.unknownReason"),
          })
        : t(`repositoryCopies.state.${copy.state}`);
  return (
    <ToneLine tone={STATE_TONE[copy.state]}>
      <span data-slot="repository-copy" data-state={copy.state}>
        {t("repositoryCopies.copyOn", { target })} <span className="font-medium">{state}</span>
      </span>
      {copy.deletionsDeferred ? (
        <p className="text-xs text-muted-foreground" data-slot="repository-copy-deferred">
          {t(`repositoryCopies.deferred.${copy.deletionsDeferred}`, {
            defaultValue: t("repositoryCopies.deferred.other"),
          })}
        </p>
      ) : null}
    </ToneLine>
  );
}

/**
 * The copies of an object's restic repository on the page of a container, machine or file share.
 * Nothing when the tenant has no copy target (or the object no repository, e.g. a VM).
 */
export function ObjectCopyStatus({ ownerId }: { ownerId: string | null | undefined }) {
  const { data } = useObjectCopies(ownerId);
  return <ObjectCopyList copies={data?.copies ?? []} />;
}

export function ObjectCopyList({ copies }: { copies: readonly RepositoryCopy[] }) {
  if (copies.length === 0) {
    return null;
  }
  return (
    <div className="space-y-1" data-slot="repository-copies">
      {copies.map((copy) => (
        <CopyStateLine key={copy.targetId} copy={copy} />
      ))}
    </div>
  );
}
