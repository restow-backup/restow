import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";

import {
  AGENT_POLICY_KEYS,
  type AgentPolicySettings,
  cleanLevel,
  firstPolicyProblem,
  resolvedGlobal,
} from "../agent-policy.js";
import { useSaveTenantAgentPolicy, useTenantAgentPolicy } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";
import { AgentPolicyFields } from "./agent-policy-fields.js";

/**
 * The tenant's level of the agent policy, on the tenant page (Agents): what the installation
 * decides, what the tenant sets on top for all its servers and clients, and what the installation
 * locked. A backup job can still set its own values for its machines (the job editor), except for
 * what is locked. Saving writes the configuration of every machine whose policy changes.
 */
export function AgentPolicyCard({ readOnly = false }: { readOnly?: boolean }) {
  const { t } = useTranslation("endpoints");
  const query = useTenantAgentPolicy();
  const save = useSaveTenantAgentPolicy();
  const id = React.useId();
  const [draft, setDraft] = React.useState<AgentPolicySettings | null>(null);
  const [attempted, setAttempted] = React.useState(false);

  React.useEffect(() => {
    if (query.data) {
      setDraft(query.data.settings);
    }
  }, [query.data]);

  if (query.isPending) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (query.isError || !query.data || !draft) {
    return (
      <ErrorState
        title={t("policy.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const above = resolvedGlobal(query.data);
  const problem = firstPolicyProblem(draft);
  const changed = JSON.stringify(draft) !== JSON.stringify(query.data.settings);

  const submit = () => {
    setAttempted(true);
    if (problem) {
      return;
    }
    save.mutate(cleanLevel(draft, AGENT_POLICY_KEYS, query.data.global.locks), {
      onSuccess: (result) => {
        setAttempted(false);
        toast(t("policy.saved", { count: result.machinesUpdated }));
      },
      onError: (error) => toast.error(t(endpointErrorKey(error))),
    });
  };

  return (
    <Card data-slot="agent-policy">
      <CardHeader>
        <CardTitle className="text-base">{t("policy.tenant.title")}</CardTitle>
        <CardDescription>{t("policy.tenant.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <AgentPolicyFields
          idPrefix={`${id}-policy`}
          level="tenant"
          keys={AGENT_POLICY_KEYS}
          above={above}
          value={draft}
          onChange={setDraft}
          disabled={readOnly || save.isPending}
        />
        {attempted && problem ? (
          <p className="text-sm text-destructive" role="alert">
            {t(`policy.problems.${problem.problem}`)}
          </p>
        ) : null}
        {readOnly ? null : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} loading={save.isPending} disabled={!changed}>
              {t("policy.save")}
            </Button>
            <Button
              variant="outline"
              disabled={!changed || save.isPending}
              onClick={() => setDraft(query.data.settings)}
            >
              {t("policy.discard")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
