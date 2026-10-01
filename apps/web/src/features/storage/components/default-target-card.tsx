import { PlugZap, Server, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { storageErrorKey } from "../presenters";
import type { InstallationDefaultDto } from "../types";
import { useTestInstallationDefault } from "../use-storage";
import { ObjectLockLine } from "./object-lock-line";
import { ProbeResult } from "./probe-result";
import { RoleBadge, ToneLine } from "./status";

/**
 * The installation default (from the server's environment) while it is the
 * tenant's primary. It has no row, so a test result is shown but not stored;
 * the card says so instead of pretending a history.
 */
export function DefaultTargetCard({
  installationDefault,
}: { installationDefault: InstallationDefaultDto }) {
  const { t } = useTranslation("storage");
  const { t: tc } = useTranslation();
  const test = useTestInstallationDefault();

  if (installationDefault.misconfigured || installationDefault.kind === null) {
    return (
      <Alert variant="destructive">
        <TriangleAlert />
        <AlertTitle>{t("default.misconfigured.title")}</AlertTitle>
        <AlertDescription>{t("default.misconfigured.description")}</AlertDescription>
      </Alert>
    );
  }

  const kind = installationDefault.kind;
  return (
    <Card className="flex h-full flex-col gap-3">
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
        <RoleBadge value="primary" />
      </CardHeader>

      <CardContent className="flex-1 space-y-3">
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
        {test.data ? (
          <ProbeResult probe={test.data.probe} />
        ) : test.error ? (
          <ToneLine tone="destructive">{tc(storageErrorKey(test.error))}</ToneLine>
        ) : (
          <ToneLine tone="neutral">{t("default.notChecked")}</ToneLine>
        )}
        <ObjectLockLine kind={kind} capability={test.data?.objectLock ?? null} />
      </CardContent>

      <CardFooter className="mt-3 border-t border-border [.border-t]:pt-4">
        <Button variant="outline" size="sm" onClick={() => test.mutate()} loading={test.isPending}>
          {test.isPending ? null : <PlugZap />}
          {test.data ? t("actions.testAgain") : t("actions.test")}
        </Button>
      </CardFooter>
    </Card>
  );
}
