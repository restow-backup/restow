import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { WindowsFacts } from "@/features/backup-jobs/api";

import { windowsRoleKeys, windowsVersionLine } from "../presenters.js";
import { Fact, Facts } from "./facts.js";

/**
 * What the Windows agent reports about its system (W1, docs/BAREMETAL-WINDOWS.md 6.1): the
 * version with build, the domain, the roles that need more than a file backup, the SQL Server
 * instances and the BitLocker state of the volumes. Facts only: nothing here is a rating.
 */
export function WindowsFactsCard({ facts }: { facts: WindowsFacts }) {
  const { t } = useTranslation("endpoints");
  const roles = windowsRoleKeys(facts);
  const bitlocker =
    facts.bitlocker.state === "ok"
      ? facts.bitlocker.volumes.length > 0
        ? facts.bitlocker.volumes
            .map((volume) =>
              t("windowsFacts.bitlockerVolume", {
                name: volume.mount,
                status: t(`windowsFacts.protection.${volume.protection}`),
              }),
            )
            .join(", ")
        : t("windowsFacts.bitlockerNone")
      : t(`windowsFacts.bitlockerState.${facts.bitlocker.state}`);
  return (
    <Card data-slot="windows-facts">
      <CardHeader>
        <CardTitle className="text-base">{t("windowsFacts.title")}</CardTitle>
        <CardDescription>{t("windowsFacts.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Facts>
          <Fact label={t("windowsFacts.version")}>{windowsVersionLine(facts)}</Fact>
          <Fact label={t("windowsFacts.productType")}>
            {t(`windowsFacts.productTypes.${facts.productType}`)}
            {facts.installationType === "server core" || facts.installationType === "core"
              ? ` (${t("windowsFacts.core")})`
              : ""}
          </Fact>
          <Fact label={t("windowsFacts.domain")}>
            {facts.domainMember && facts.domain ? facts.domain : t("windowsFacts.noDomain")}
          </Fact>
          <Fact label={t("windowsFacts.rolesLabel")}>
            {roles.length > 0 ? roles.map((key) => t(key)).join(", ") : t("windowsFacts.noRoles")}
          </Fact>
          {facts.sqlInstances.length > 0 ? (
            <Fact label={t("windowsFacts.sqlInstances")}>
              {facts.sqlInstances
                .map((instance) =>
                  instance.version ? `${instance.name} (${instance.version})` : instance.name,
                )
                .join(", ")}
            </Fact>
          ) : null}
          <Fact label={t("windowsFacts.bitlocker")}>{bitlocker}</Fact>
        </Facts>
      </CardContent>
    </Card>
  );
}
