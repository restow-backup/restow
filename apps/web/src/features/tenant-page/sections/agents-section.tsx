import { Link } from "@tanstack/react-router";
import { ArrowRight, Laptop, Server } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AgentUpdatesCard } from "@/features/endpoints/components/agent-updates-card";
import { EnrollDialog } from "@/features/endpoints/components/enroll-dialog";
import { PendingTokens } from "@/features/endpoints/components/pending-tokens";
import type { EndpointProfile } from "@/features/endpoints/paths";
import { inventoryTo } from "@/features/endpoints/paths";
import type { TenantSectionProps } from "@/lib/extensions";
import { useSession } from "@/lib/session";

/**
 * Agents: how machines get an agent and what the tenant decides about its
 * updates. The install command and the enrolment are the ones of the Inventory
 * page (a one-time command per machine, valid for a day), the pause of
 * automatic updates is one setting of the tenant. The machines themselves, with
 * their status and readiness, stay in the daily work: Servers & endpoints,
 * Inventory.
 */
export function AgentsSection(_props: TenantSectionProps) {
  const { t } = useTranslation("tenantpage");
  const { isProviderAdmin } = useSession();
  const [enrolling, setEnrolling] = React.useState<EndpointProfile | null>(null);

  return (
    <div className="space-y-6">
      <Card data-slot="agent-enrolment">
        <CardHeader>
          <CardTitle className="text-base">{t("agents.enrol.title")}</CardTitle>
          <CardDescription>{t("agents.enrol.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Button onClick={() => setEnrolling("server")}>
            <Server />
            {t("agents.enrol.server")}
          </Button>
          <Button variant="outline" onClick={() => setEnrolling("client")}>
            <Laptop />
            {t("agents.enrol.client")}
          </Button>
          <Link
            to={inventoryTo()}
            className="ml-auto inline-flex items-center gap-1 rounded-sm text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("agents.enrol.inventory")}
            <ArrowRight aria-hidden="true" className="size-3.5" />
          </Link>
        </CardContent>
      </Card>

      <PendingTokens />

      <AgentUpdatesCard />

      <EnrollDialog
        open={enrolling !== null}
        onOpenChange={(open) => {
          if (!open) setEnrolling(null);
        }}
        profile={enrolling ?? "server"}
        canOpenInstallation={isProviderAdmin}
      />
    </div>
  );
}
