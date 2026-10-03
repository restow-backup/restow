import { PlugZap, Server, TriangleAlert, Undo2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { storageErrorKey } from "../presenters";
import type { InstallationDefaultDto, StorageTargetDto } from "../types";
import { useDeleteTarget, useTestInstallationDefault } from "../use-storage";
import { ObjectLockLine } from "./object-lock-line";
import { ProbeResult } from "./probe-result";
import { RoleBadge, ToneLine } from "./status";

/**
 * What going back to the installation default means for a tenant with a
 * primary of its own: `available` when nothing is stored there yet (the
 * primary is simply removed, docs/STORAGE.md "Installation default"),
 * `blocked` once it holds data (no migration targets the default yet), and
 * `none` when the viewer may not remove that primary anyway.
 */
export type BackToDefault = "available" | "blocked" | "none";

export function backToDefault(input: {
  primary: Pick<StorageTargetDto, "canManage" | "migration"> | null;
  tenantHasData: boolean;
}): BackToDefault {
  if (!input.primary) {
    return "none";
  }
  if (input.tenantHasData) {
    return "blocked";
  }
  const migrating =
    input.primary.migration !== null &&
    ["queued", "copying", "verifying", "switching"].includes(input.primary.migration.status);
  return input.primary.canManage && !migrating ? "available" : "none";
}

/**
 * The installation default as an explicit choice on the tenant's storage
 * page. While the tenant has no primary target of its own it is the primary
 * (selected), and a test result is shown but not stored: it has no row, so the
 * card says so instead of pretending a history. Once the tenant has a primary
 * of its own, the default is shown as not in use; going back to it is offered
 * while that primary holds no data yet.
 */
export function DefaultTargetCard({
  installationDefault,
  primary,
  tenantHasData,
}: {
  installationDefault: InstallationDefaultDto;
  /** The tenant's own primary target, when it has one. */
  primary: StorageTargetDto | null;
  tenantHasData: boolean;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const test = useTestInstallationDefault();
  const inUse = installationDefault.inUse;

  if (installationDefault.misconfigured || installationDefault.kind === null) {
    return inUse ? (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{t("default.misconfigured.title")}</AlertTitle>
        <AlertDescription>{t("default.misconfigured.description")}</AlertDescription>
      </Alert>
    ) : null;
  }

  const kind = installationDefault.kind;
  const back = inUse ? "none" : backToDefault({ primary, tenantHasData });
  return (
    <Card
      className={cn("flex h-full flex-col gap-3", inUse ? null : "border-dashed")}
      data-slot="installation-default-card"
      data-in-use={inUse ? "true" : "false"}
    >
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Server aria-hidden="true" className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle className="truncate text-base">{t("default.name")}</CardTitle>
          <CardDescription
            className="truncate font-mono text-xs"
            title={installationDefault.location ?? undefined}
          >
            {installationDefault.location ?? t("default.managedByProvider")}
          </CardDescription>
        </div>
        {inUse ? (
          <RoleBadge value="primary" />
        ) : (
          <Badge variant="outline">{t("default.notInUseBadge")}</Badge>
        )}
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
        <p className="text-sm" data-slot="installation-default-choice">
          {t(inUse ? "default.inUse" : "default.notInUse")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(`kindLong.${kind}`)} · {t("default.description")}
        </p>
        {installationDefault.hasCopy ? (
          <p className="text-xs text-muted-foreground">
            {installationDefault.copyLocation
              ? t("default.copyAt", { location: installationDefault.copyLocation })
              : t("default.copy")}
          </p>
        ) : null}
        {inUse ? (
          <>
            {test.data ? (
              <ProbeResult probe={test.data.probe} />
            ) : test.error ? (
              <ToneLine tone="destructive">{tc(storageErrorKey(test.error))}</ToneLine>
            ) : (
              <ToneLine tone="neutral">{t("default.notChecked")}</ToneLine>
            )}
            <ObjectLockLine kind={kind} capability={test.data?.objectLock ?? null} />
          </>
        ) : back === "blocked" ? (
          <p className="text-xs text-muted-foreground">{t("default.backBlocked")}</p>
        ) : null}
      </CardContent>

      {inUse ? (
        <CardFooter className="mt-3 border-t border-border [.border-t]:pt-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => test.mutate()}
            loading={test.isPending}
          >
            {test.isPending ? null : <PlugZap />}
            {test.data ? t("actions.testAgain") : t("actions.test")}
          </Button>
        </CardFooter>
      ) : back === "available" && primary ? (
        <CardFooter className="mt-3 border-t border-border [.border-t]:pt-4">
          <UseDefaultButton primary={primary} />
        </CardFooter>
      ) : null}
    </Card>
  );
}

/**
 * Go back to the installation default: the tenant's own primary, which holds
 * no data yet, is removed (the API refuses with `primary_holds_data` if data
 * arrived meanwhile, and the dialog says so).
 */
function UseDefaultButton({ primary }: { primary: StorageTargetDto }) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const remove = useDeleteTarget(primary.id);
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm">
          <Undo2 />
          {t("actions.useDefault")}
        </Button>
      }
      title={t("default.use.title")}
      description={t("default.use.description", { name: primary.name })}
      confirmLabel={t("default.use.confirm")}
      error={remove.error ? tc(storageErrorKey(remove.error)) : undefined}
      onConfirm={async () => {
        await remove.mutateAsync();
        toast.success(t("toasts.defaultSelected"));
      }}
    />
  );
}
