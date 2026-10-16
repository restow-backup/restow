import { Lock } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import {
  type AgentPolicySettings,
  JOB_POLICY_KEYS,
  type ResolvedAgentPolicy,
  resolvedGlobal,
  resolveOnTop,
} from "@/features/endpoints/agent-policy";
import {
  AgentPolicyFields,
  usePolicyValueText,
  useSourceText,
} from "@/features/endpoints/components/agent-policy-fields";
import { useTenantAgentPolicy } from "@/features/endpoints/hooks";

import type { JobEndpointSettings } from "../api.js";
import "../i18n.js";
import { EditorSection } from "./editor-section.js";

type JobPolicy = NonNullable<JobEndpointSettings["policy"]>;

/** What the job's machines inherit: the installation's and the tenant's level; null while loading. */
export function useInheritedPolicy(): {
  above: ResolvedAgentPolicy | null;
  isError: boolean;
} {
  const query = useTenantAgentPolicy();
  if (!query.data) {
    return { above: null, isError: query.isError };
  }
  return {
    above: resolveOnTop(resolvedGlobal(query.data), query.data.settings, "tenant"),
    isError: false,
  };
}

/**
 * The job's level of the agent policy in the job editor: backup window, catching up missed
 * backups, AC power and retries for the machines of this job, each with the value that applies and
 * where it comes from; a setting the installation locked cannot be set here. The upload limit is
 * the job's own field above (Bandwidth), which says what applies without one.
 */
export function JobPolicySection({
  id,
  value,
  onChange,
  zone,
  disabled = false,
}: {
  id: string;
  value: JobPolicy;
  onChange: (next: JobPolicy) => void;
  zone: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation("backupjobs");
  const { above, isError } = useInheritedPolicy();
  return (
    <EditorSection
      id={id}
      title={t("editor.policy.title")}
      description={t("editor.policy.description")}
    >
      {above ? (
        <AgentPolicyFields
          idPrefix={`${id}-fields`}
          level="job"
          keys={JOB_POLICY_KEYS}
          above={above}
          value={value as AgentPolicySettings}
          onChange={(next) => onChange(next as JobPolicy)}
          zone={zone}
          disabled={disabled}
        />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">{t("editor.policy.loadError")}</p>
      ) : (
        <Skeleton className="h-32 w-full" />
      )}
    </EditorSection>
  );
}

/**
 * Under the job's upload limit: what applies when the job sets none (the policy's limit and where
 * it comes from), and that the installation locked it, which makes the job's own limit and
 * windows ineffective.
 */
export function PolicyBandwidthNote() {
  const { t } = useTranslation("backupjobs");
  const { above } = useInheritedPolicy();
  const valueText = usePolicyValueText();
  const sourceText = useSourceText();
  if (!above) {
    return null;
  }
  const setting = above.bandwidthKbps;
  return (
    <p
      className="flex items-start gap-2 text-xs text-muted-foreground"
      data-slot="policy-bandwidth"
    >
      {setting.locked ? <Lock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" /> : null}
      {t(setting.locked ? "editor.policy.bandwidthLocked" : "editor.policy.bandwidthDefault", {
        value: valueText("bandwidthKbps", setting.value),
        source: sourceText(setting.source),
      })}
    </p>
  );
}

/** Renders its children with whether the installation locked the upload limit (the job's own then does not apply). */
export function BandwidthLock({ children }: { children: (locked: boolean) => React.ReactNode }) {
  return <>{children(useInheritedPolicy().above?.bandwidthKbps.locked ?? false)}</>;
}
