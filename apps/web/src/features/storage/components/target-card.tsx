import {
  ArrowUpToLine,
  ListChecks,
  MoreHorizontal,
  Pencil,
  PlugZap,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/sonner";
import {
  healthSummary,
  isMigrationRunning,
  storageErrorKey,
  targetDisplayName,
} from "../presenters";
import type { StorageTargetDto } from "../types";
import { useIsTestingTarget, useTestTarget } from "../use-storage";
import { MigrationLine } from "./migration-line";
import { ObjectLockLine } from "./object-lock-line";
import { ProbeResult } from "./probe-result";
import { RoleBadge, TargetKindIcon, TargetStatusBadge, ToneLine } from "./status";

export type TargetAction = "edit" | "delete" | "promote" | "completeness";

/**
 * One storage target: what and where it is, its role, whether its last test
 * passed and whether it can enforce WORM. Test runs in place; everything that
 * changes the setup opens a dialog through `onAction`.
 */
export function TargetCard({
  target,
  onAction,
}: {
  target: StorageTargetDto;
  onAction: (action: TargetAction, target: StorageTargetDto) => void;
}) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const test = useTestTarget();
  const testing = useIsTestingTarget(target.id);
  const health = healthSummary(target);
  const isCopy = target.role === "copy";
  const migrationActive = target.migration ? isMigrationRunning(target.migration) : false;
  const isRetiredDefault = target.kind === "installation_default";
  const name = targetDisplayName(target, t);

  const runTest = () => {
    test.mutate(target.id, {
      onSuccess: (result) => {
        if (result.probe.ok) {
          toast.success(t("toasts.testOk", { name }));
        } else {
          toast.error(t("toasts.testFailed", { name }));
        }
      },
      onError: (error) => toast.error(tc(storageErrorKey(error))),
    });
  };

  return (
    <Card className="flex h-full flex-col gap-3">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <TargetKindIcon kind={target.kind} className="size-4" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle className="truncate text-base" title={name}>
            {name}
          </CardTitle>
          {isRetiredDefault ? (
            // No addressing of its own to show (insertRetiredInstallationDefault):
            // `target.location` is empty, so a plain explanation replaces it
            // instead of leaving the line blank.
            <CardDescription className="text-xs">{t("targets.retiredLocation")}</CardDescription>
          ) : (
            <CardDescription className="truncate font-mono text-xs" title={target.location}>
              {target.location}
            </CardDescription>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <RoleBadge value={target.role} />
          {/* The placeholder can never be tested (it has no addressing of its
              own), so a status badge would only ever misleadingly read "Not tested". */}
          {isRetiredDefault ? null : <TargetStatusBadge status={target.status} />}
        </div>
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
        <p className="text-xs text-muted-foreground">
          {t(`kindLong.${target.kind}`)} · {t(`role.${target.role}Hint`)}
        </p>
        <MigrationLine target={target} />
        {target.kind !== "installation_default" ? (
          target.lastProbe && target.status !== "unverified" && target.configValid ? (
            <ProbeResult probe={target.lastProbe} />
          ) : (
            <ToneLine tone={health.tone}>{t(health.key, health.values)}</ToneLine>
          )
        ) : null}
        <ObjectLockLine kind={target.kind} capability={target.objectLock} />
        {!target.canManage ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            {t("targets.managedByProvider")}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="mt-3 flex items-center justify-between gap-2 border-t border-border [.border-t]:pt-4">
        {isRetiredDefault ? (
          // Nothing of its own to test (see the location hint above): a
          // permanently disabled button would only invite a click that can
          // never do anything.
          <span />
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={runTest}
            loading={testing}
            disabled={!target.configValid}
          >
            {testing ? null : <PlugZap />}
            {target.lastProbe ? t("actions.testAgain") : t("actions.test")}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("actions.moreActions", { name })}
              title={t("actions.moreActions", { name })}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {isCopy && !migrationActive ? (
              <DropdownMenuItem onSelect={() => onAction("completeness", target)}>
                <ListChecks />
                {t("actions.checkCopy")}
              </DropdownMenuItem>
            ) : null}
            {isCopy && !migrationActive && target.canManage ? (
              <DropdownMenuItem onSelect={() => onAction("promote", target)}>
                <ArrowUpToLine />
                {t("actions.promote")}
              </DropdownMenuItem>
            ) : null}
            {target.canManage ? (
              <>
                {target.kind !== "installation_default" ? (
                  <DropdownMenuItem onSelect={() => onAction("edit", target)}>
                    <Pencil />
                    {t("actions.edit")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => onAction("delete", target)}
                  variant="destructive"
                  disabled={migrationActive}
                >
                  <Trash2 />
                  {t("actions.delete")}
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem disabled>{t("targets.managedByProvider")}</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </CardFooter>
    </Card>
  );
}
