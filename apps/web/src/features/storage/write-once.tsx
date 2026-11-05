import { useQuery } from "@tanstack/react-query";
import { Archive } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";

import { storageKeys } from "./api";
import { STORAGE_NAMESPACE } from "./i18n";
import type { PrimaryWriteOnce } from "./types";

/**
 * Whether the tenant's backups go to write-once storage (GET /api/v1/storage/write-once,
 * docs/STORAGE.md "Write-once storage"): such a repository takes backups but deletes nothing,
 * so retention is not applied there. Every member of the tenant may ask.
 */
export function fetchPrimaryWriteOnce(): Promise<PrimaryWriteOnce> {
  return apiFetch<PrimaryWriteOnce>("/storage/write-once");
}

export function usePrimaryWriteOnce() {
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  return useQuery({
    queryKey: [...storageKeys.all(tenantId), "write-once"] as const,
    queryFn: fetchPrimaryWriteOnce,
    enabled: session.status === "authenticated" && tenantId !== null,
    staleTime: 5 * 60_000,
  });
}

/** Where the notice stands: the page of an object, or the retention settings of a job. */
export type WriteOnceRetentionContext = "guest" | "share" | "machine" | "job" | "settings";

/**
 * "Retention is not applied": on the page of a VM or container, a file share or a machine, and
 * next to the retention settings of a job or a policy, while the tenant's primary repository is
 * write-once. The settings can still be saved (they apply again once the backups go to another
 * repository), but they say plainly that nothing is removed here. Nothing otherwise.
 */
export function WriteOnceRetentionNotice({
  context,
  className,
}: {
  context: WriteOnceRetentionContext;
  className?: string;
}) {
  const { t } = useTranslation(STORAGE_NAMESPACE);
  const { data } = usePrimaryWriteOnce();
  if (!data?.writeOnce) {
    return null;
  }
  const repository = data.installationDefault
    ? t("writeOnceRetention.installationDefault")
    : (data.targetName ?? t("writeOnceRetention.unnamed"));
  return (
    <Alert className={className} data-slot="write-once-retention">
      <Archive aria-hidden="true" />
      <AlertTitle>{t("writeOnceRetention.title")}</AlertTitle>
      <AlertDescription>
        <p>{t(`writeOnceRetention.${context}`, { repository })}</p>
        <p>{t("writeOnceRetention.consequences")}</p>
      </AlertDescription>
    </Alert>
  );
}
