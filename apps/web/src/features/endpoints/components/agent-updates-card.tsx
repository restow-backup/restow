import * as React from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";

import { useAgentUpdates, useSetAgentUpdates } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";

/**
 * The tenant-wide switch for automatic agent updates. Agents only install
 * releases signed by the maintainer; pausing keeps every machine of the tenant
 * on its version until the switch is turned on again (machines enrolled in the
 * meantime are paused too). Shown once the tenant has a machine.
 */
export function AgentUpdatesCard() {
  const { t } = useTranslation("endpoints");
  const updates = useAgentUpdates();
  const change = useSetAgentUpdates();
  const id = React.useId();
  if (!updates.data || updates.data.endpoints === 0) {
    return null;
  }
  const enabled = !updates.data.paused;
  return (
    <Card data-slot="agent-updates">
      <CardHeader>
        <CardTitle className="text-base">{t("agentUpdates.title")}</CardTitle>
        <CardDescription>{t("agentUpdates.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <label htmlFor={id} className="text-sm font-medium">
              {t("agentUpdates.label")}
            </label>
            <p className="text-xs text-muted-foreground">
              {enabled ? t("agentUpdates.on") : t("agentUpdates.paused")}
            </p>
          </div>
          <Switch
            id={id}
            checked={enabled}
            disabled={change.isPending}
            onCheckedChange={(checked) =>
              change.mutate(!checked, {
                onSuccess: () =>
                  toast.success(
                    checked ? t("agentUpdates.toast.on") : t("agentUpdates.toast.paused"),
                  ),
                onError: (error) => toast.error(t(endpointErrorKey(error))),
              })
            }
          />
        </div>
      </CardContent>
    </Card>
  );
}
