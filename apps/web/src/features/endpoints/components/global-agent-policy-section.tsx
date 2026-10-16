import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { providerMay } from "@/lib/provider-role";
import { useSession } from "@/lib/session";

import {
  AGENT_POLICY_KEYS,
  type AgentPolicyKey,
  type AgentPolicySettings,
  cleanLevel,
  firstPolicyProblem,
  resolvedDefaults,
} from "../agent-policy.js";
import { useGlobalAgentPolicy, useSaveGlobalAgentPolicy } from "../hooks.js";
import { endpointErrorKey } from "../presenters.js";
import { AgentPolicyFields } from "./agent-policy-fields.js";

interface Draft {
  settings: AgentPolicySettings;
  locks: AgentPolicyKey[];
}

/**
 * Installation > Agent policy (docs/AGENT.md, "Richtlinien"): the global policy for the agents of
 * servers and clients in every tenant, and the settings no tenant and no job may change (locked).
 * Every provider admin reads it; administrators with every tenant change it. Saving writes the
 * configuration of every machine whose policy changes, in every tenant.
 */
export function GlobalAgentPolicySection() {
  const { t } = useTranslation("endpoints");
  const session = useSession();
  const canChange = providerMay(session, "administrator", { everyTenant: true });
  const query = useGlobalAgentPolicy();
  const save = useSaveGlobalAgentPolicy();
  const id = React.useId();
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [attempted, setAttempted] = React.useState(false);

  React.useEffect(() => {
    if (query.data) {
      setDraft({ settings: query.data.settings, locks: query.data.locks });
    }
  }, [query.data]);

  if (query.isPending) {
    return <Skeleton className="h-64 w-full" aria-busy="true" />;
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
  const problem = firstPolicyProblem(draft.settings);
  const stored = { settings: query.data.settings, locks: query.data.locks };
  const changed = JSON.stringify(draft) !== JSON.stringify(stored);

  const submit = () => {
    setAttempted(true);
    if (problem) {
      return;
    }
    save.mutate(
      {
        settings: cleanLevel(draft.settings, AGENT_POLICY_KEYS),
        locks: AGENT_POLICY_KEYS.filter((key) => draft.locks.includes(key)),
      },
      {
        onSuccess: (result) => {
          setAttempted(false);
          toast(t("policy.saved", { count: result.machinesUpdated }));
        },
        onError: (error) => toast.error(t(endpointErrorKey(error))),
      },
    );
  };

  return (
    <Card data-slot="global-agent-policy">
      <CardHeader>
        <CardTitle>{t("policy.global.title")}</CardTitle>
        <CardDescription>{t("policy.global.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canChange ? null : (
          <p className="text-sm text-muted-foreground">{t("policy.global.readOnly")}</p>
        )}
        <AgentPolicyFields
          idPrefix={`${id}-policy`}
          level="global"
          keys={AGENT_POLICY_KEYS}
          above={resolvedDefaults(query.data.defaults)}
          value={draft.settings}
          onChange={(settings) => setDraft({ ...draft, settings })}
          locks={draft.locks}
          onLocksChange={(locks) => setDraft({ ...draft, locks })}
          disabled={!canChange || save.isPending}
        />
        {attempted && problem ? (
          <p className="text-sm text-destructive" role="alert">
            {t(`policy.problems.${problem.problem}`)}
          </p>
        ) : null}
        {canChange ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={submit} loading={save.isPending} disabled={!changed}>
              {t("policy.save")}
            </Button>
            <Button
              variant="outline"
              disabled={!changed || save.isPending}
              onClick={() => setDraft(stored)}
            >
              {t("policy.discard")}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
