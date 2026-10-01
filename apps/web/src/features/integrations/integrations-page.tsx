import { useNavigate, useSearch } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/page-header";
import { RequireRole } from "@/components/require-role";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ApiKeysPanel } from "./api-keys/api-keys-panel";
import { useIntegrationsScope } from "./hooks";
import { integrationsTo } from "./paths";
import { INTEGRATIONS_ROLES, type IntegrationsTab, parseIntegrationsSearch } from "./presenters";
import { WebhooksPanel } from "./webhooks/webhooks-panel";

/**
 * Integrations: API keys (tenant keys and, for provider admins, provider
 * keys) and webhooks with their delivery logs. The tab lives in the URL.
 */
export function IntegrationsPage() {
  return (
    <RequireRole roles={INTEGRATIONS_ROLES}>
      <TooltipProvider delayDuration={200}>
        <IntegrationsContent />
      </TooltipProvider>
    </RequireRole>
  );
}

function IntegrationsContent() {
  const { t } = useTranslation("integrations");
  const { tenantName } = useIntegrationsScope();
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = React.useMemo(() => parseIntegrationsSearch(raw), [raw]);
  const navigate = useNavigate();
  const tab: IntegrationsTab = search.tab ?? "api-keys";

  const selectTab = (value: string) => {
    void navigate({
      to: integrationsTo(),
      search: (value === "webhooks" ? { tab: "webhooks" } : {}) as never,
      replace: true,
    });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={tenantName ? t("tenantScope", { tenant: tenantName }) : t("subtitle")}
      />
      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList>
          <TabsTrigger value="api-keys">{t("tabs.apiKeys")}</TabsTrigger>
          <TabsTrigger value="webhooks">{t("tabs.webhooks")}</TabsTrigger>
        </TabsList>
        <TabsContent value="api-keys" className="mt-2">
          <ApiKeysPanel />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-2">
          <WebhooksPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}
