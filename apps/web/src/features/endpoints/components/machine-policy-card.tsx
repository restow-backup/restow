import { Lock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

import { AGENT_POLICY_KEYS, type AgentPolicyKey } from "../agent-policy.js";
import type { EndpointDetail } from "../api.js";
import { useEndpointAgentPolicy, useEndpointFormat } from "../hooks.js";
import { usePolicyValueText, useSourceText } from "./agent-policy-fields.js";

/**
 * The agent policy as it applies to this machine (docs/AGENT.md, "Richtlinien"): each setting with
 * its value, where it comes from (default, installation, tenant, backup job or the machine itself)
 * and whether the installation locked it. Read-only for everybody: the tenant's policy and the job
 * are changed where they live.
 */
export function MachinePolicyCard({ detail }: { detail: EndpointDetail }) {
  const { t } = useEndpointFormat();
  const query = useEndpointAgentPolicy(detail.id);
  const valueText = usePolicyValueText();
  const sourceText = useSourceText();
  const view = query.data;
  return (
    <Card data-slot="machine-policy">
      <CardHeader>
        <CardTitle className="text-base">{t("machinePolicy.title")}</CardTitle>
        <CardDescription>{t("machinePolicy.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {view ? (
          <dl className="grid gap-3 text-sm">
            {AGENT_POLICY_KEYS.map((key: AgentPolicyKey) => {
              const setting = view.effective[key];
              return (
                <div
                  key={key}
                  className="grid min-w-0 gap-1"
                  data-slot="machine-policy-setting"
                  data-key={key}
                >
                  <dt className="text-muted-foreground">{t(`policy.${key}.title`)}</dt>
                  <dd className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 font-medium break-words">
                      {valueText(key, setting.value as never)}
                      {key === "bandwidthKbps" && view.bandwidthWindows
                        ? ` ${t("machinePolicy.withWindows")}`
                        : ""}
                    </span>
                    <Badge variant="outline" data-slot="policy-source">
                      {sourceText(setting.source)}
                    </Badge>
                    {setting.locked ? (
                      <Badge variant="outline" data-slot="policy-locked">
                        <Lock aria-hidden="true" />
                        {t("policy.locked")}
                      </Badge>
                    ) : null}
                  </dd>
                </div>
              );
            })}
          </dl>
        ) : query.isError ? (
          <p className="text-sm text-muted-foreground">{t("machinePolicy.loadError")}</p>
        ) : (
          <Skeleton className="h-32 w-full" />
        )}
      </CardContent>
    </Card>
  );
}
