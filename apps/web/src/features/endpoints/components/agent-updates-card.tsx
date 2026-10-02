import { Link } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";

import { useAgentUpdates, useResumeMachineUpdates, useSetAgentUpdates } from "../hooks.js";
import { endpointDetailTo } from "../paths.js";
import { endpointErrorKey } from "../presenters.js";

/**
 * The tenant's setting for automatic agent updates, on the tenant page
 * (Agents). Agents only install releases signed by the maintainer; pausing keeps
 * every machine of the tenant on its version until the switch is turned on
 * again, for example to test an update first. It is one setting of the tenant:
 * it can be set before the first machine exists and covers machines enrolled
 * later. Machines that carry a pause of their own (how the pause was kept
 * before it became a setting of the tenant) stay paused whatever the switch
 * says; they are listed as overrides and resumed one by one or all at once.
 */
export function AgentUpdatesCard() {
  const { t } = useTranslation("endpoints");
  const updates = useAgentUpdates();
  const change = useSetAgentUpdates();
  const resume = useResumeMachineUpdates();
  const id = React.useId();

  if (updates.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (updates.isError || !updates.data) {
    return (
      <ErrorState
        title={t("agentUpdates.loadError")}
        error={updates.error}
        onRetry={() => void updates.refetch()}
        retrying={updates.isFetching}
      />
    );
  }
  const { paused, overrides } = updates.data;
  const enabled = !paused;

  return (
    <Card data-slot="agent-updates">
      <CardHeader>
        <CardTitle className="text-base">{t("agentUpdates.title")}</CardTitle>
        <CardDescription>{t("agentUpdates.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
              change.mutate(
                { paused: !checked },
                {
                  onSuccess: () =>
                    toast.success(
                      checked ? t("agentUpdates.toast.on") : t("agentUpdates.toast.paused"),
                    ),
                  onError: (error) => toast.error(t(endpointErrorKey(error))),
                },
              )
            }
          />
        </div>

        {overrides.length > 0 ? (
          <Alert variant="info" data-slot="agent-update-overrides">
            <AlertTitle>
              {t("agentUpdates.overrides.title", { count: overrides.length })}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{t("agentUpdates.overrides.description")}</p>
              <ul className="w-full space-y-1.5">
                {overrides.map((machine) => (
                  <li
                    key={machine.id}
                    className="flex flex-wrap items-center justify-between gap-2"
                  >
                    <Link
                      to={endpointDetailTo(machine.id)}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {machine.name}
                    </Link>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={resume.isPending}
                      onClick={() =>
                        resume.mutate(machine.id, {
                          onSuccess: () => toast.success(t("agentUpdates.toast.machineResumed")),
                          onError: (error) => toast.error(t(endpointErrorKey(error))),
                        })
                      }
                    >
                      {t("agentUpdates.overrides.resume")}
                    </Button>
                  </li>
                ))}
              </ul>
              {overrides.length > 1 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate(
                      { paused, resumeMachines: true },
                      {
                        onSuccess: () => toast.success(t("agentUpdates.toast.allResumed")),
                        onError: (error) => toast.error(t(endpointErrorKey(error))),
                      },
                    )
                  }
                >
                  {t("agentUpdates.overrides.resumeAll")}
                </Button>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
