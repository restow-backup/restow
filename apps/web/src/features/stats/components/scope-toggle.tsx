import { Building2, Network } from "lucide-react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import type { StatsScope } from "../period.js";
import { useStatsFormat } from "../use-stats-format.js";

interface ScopeToggleProps {
  scope: StatsScope;
  onChange: (scope: StatsScope) => void;
}

/**
 * Tenant | Provider: provider admins (where the installation enables
 * `stats.allTenants`) switch between the active tenant and the totals of
 * every tenant.
 */
export function ScopeToggle({ scope, onChange }: ScopeToggleProps) {
  const { t } = useStatsFormat();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={scope}
      onValueChange={(value) => {
        if (value === "tenant" || value === "provider") {
          onChange(value);
        }
      }}
      aria-label={t("scope.label")}
    >
      <ToggleGroupItem value="tenant">
        <Building2 aria-hidden="true" />
        {t("scope.tenant")}
      </ToggleGroupItem>
      <ToggleGroupItem value="provider">
        <Network aria-hidden="true" />
        {t("scope.provider")}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
