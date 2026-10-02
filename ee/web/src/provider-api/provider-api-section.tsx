import { useTranslation } from "react-i18next";

import { TooltipProvider } from "@/components/ui/tooltip";
import { AccessNote, ReadOnlyGroup, useInstallationAccess } from "@/features/installation/access";
import { ProviderKeysCard } from "@/features/integrations/api-keys/api-keys-panel";

/**
 * Installation, Provider API (Service Provider, `apiKeys.provider`): the
 * provider keys that RMM and PSA tools use across all tenants (docs
 * internal/DASH-INTEGRATION.md). They moved here from the Integrations page,
 * which keeps the keys and webhooks of one tenant. Creating and revoking a key
 * is for the owner of the provider team; every other provider role sees the
 * keys read-only.
 */
export function ProviderApiSection() {
  const { t } = useTranslation("installation");
  const access = useInstallationAccess();
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-6">
        <p className="max-w-prose text-sm text-muted-foreground">{t("providerApi.intro")}</p>
        <AccessNote block={access.change} level="owner" />
        <ReadOnlyGroup closed={access.change !== null}>
          <ProviderKeysCard />
        </ReadOnlyGroup>
      </div>
    </TooltipProvider>
  );
}
