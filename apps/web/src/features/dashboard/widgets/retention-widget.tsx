import { Hourglass } from "lucide-react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatInteger } from "@/lib/format";

// The `retention` namespace's preset/cutoff/guard sentences, reused here so
// this widget's rule sentence stays word-for-word the same one the retention
// page shows. This registers the namespace even when nothing else on the
// current page has visited that feature yet (see that module's own comment;
// harmless once packages/i18n/src/index.ts lists the namespace directly).
import "@/features/retention/i18n.js";

import type { RetentionWidget as RetentionData } from "../api.js";
import { WidgetCard, type WidgetStateProps } from "../components/widget-frame.js";

function RetentionSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32 rounded-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/**
 * Built-in preset ids (packages/core/src/retention/tiers.ts); each has a
 * complete, accurate sentence in the `retention` namespace's `presets`
 * group (the same one the retention page's policy table uses), so naming
 * the preset says exactly what the rule does — daily/weekly thinning
 * included — instead of reducing it to a single cutoff.
 */
const BUILTIN_PRESETS = ["default", "30d", "90d", "1y", "3y", "7y", "keep_all"] as const;
type BuiltinPreset = (typeof BUILTIN_PRESETS)[number];

function isBuiltinPreset(value: string | undefined): value is BuiltinPreset {
  return value != null && (BUILTIN_PRESETS as readonly string[]).includes(value);
}

interface RetentionTierLike {
  fromDays: number;
  toDays: number | null;
  keepEveryDays: number;
}

/**
 * `RetentionWidget["policy"]`, widened with the preset id and (for a custom
 * or legacy policy) its own tiers — fields the API's dashboard/retention.ts
 * already fills in on the response; a wiring request tracks adding them to
 * the documented `RetentionPolicyDto` and the web-side type formally. Until
 * then this widget reads them defensively: a caller that does not supply
 * them (an older payload, or a test fixture) falls back to the plain
 * cutoff/keepLast summary exactly as before.
 */
type PolicyWithRule = NonNullable<RetentionData["policy"]> & {
  preset?: string;
  tiers?: RetentionTierLike[];
};

function PolicySentence({
  policy,
  scopedPolicies,
}: {
  policy: RetentionData["policy"];
  scopedPolicies: number;
}) {
  const { t, i18n } = useTranslation(["dashboard", "retention"]);
  const language = i18n.resolvedLanguage ?? i18n.language;

  if (!policy) {
    if (scopedPolicies > 0) {
      // No tenant default, but per-object overrides exist: those objects
      // ARE pruned under their own policy, so "everything is kept" would be
      // false for them. Say what actually happens for both groups instead.
      return (
        <div className="space-y-1">
          <p className="text-sm">
            {t("retention:dashboardWidget.onlyOverrides", { count: scopedPolicies })}
          </p>
        </div>
      );
    }
    return (
      <div className="space-y-1">
        <p className="text-sm">{t("retention:dashboardWidget.keepAll")}</p>
        <p className="text-sm text-muted-foreground">
          {t("retention:dashboardWidget.recommendedDefault", {
            rule: t("retention:presetRule.default"),
          })}
        </p>
      </div>
    );
  }

  const rule = policy as PolicyWithRule;
  const guard = <p className="text-sm text-muted-foreground">{t("retention:form.description")}</p>;

  if (isBuiltinPreset(rule.preset)) {
    return (
      <div className="space-y-1">
        <p className="text-sm">{t(`retention:presets.${rule.preset}`)}</p>
        {guard}
      </div>
    );
  }

  if (rule.preset === "custom" || rule.preset === "legacy") {
    // Only the cutoff is known to be true here; a thinning tier before it
    // is called out instead of silently disappearing into "kept" or
    // "no age limit".
    const hasThinning = (rule.tiers ?? []).some((tier) => tier.keepEveryDays > 0);
    return (
      <div className="space-y-1">
        <p className="text-sm">
          {policy.keepDays === null
            ? t("retention:cutoff.forever")
            : t("retention:cutoff.days", { days: formatInteger(policy.keepDays, language) })}
        </p>
        {hasThinning ? (
          <p className="text-sm text-muted-foreground">
            {t("retention:dashboardWidget.thinningNote")}
          </p>
        ) : null}
        {guard}
      </div>
    );
  }

  // No preset information on this payload at all: the plain cutoff/keepLast summary.
  if (policy.keepDays === null) {
    return <p className="text-sm">{t("retention:dashboardWidget.keepByAge")}</p>;
  }
  return (
    <p className="text-sm">
      {t("retention:dashboardWidget.prunes", {
        days: formatInteger(policy.keepDays, language),
        keepLast: policy.keepLast,
      })}
    </p>
  );
}

function RetentionBody({ data }: { data: RetentionData }) {
  const { t, i18n } = useTranslation(["dashboard", "retention"]);
  const language = i18n.resolvedLanguage ?? i18n.language;
  // When there is no tenant-default policy, the per-object overrides are
  // already explained inside PolicySentence's "onlyOverrides" sentence, so
  // the generic count line below would only repeat it — show it only
  // alongside an actual tenant policy, where it is additional information.
  const showScopedLine = data.policy !== null && data.scopedPolicies > 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {data.policy ? (
          <StatusBadge tone="info">{t("retention.policy", { name: data.policy.name })}</StatusBadge>
        ) : (
          <StatusBadge tone="muted">{t("retention.noPolicy")}</StatusBadge>
        )}
        {data.activeHolds > 0 ? (
          <StatusBadge tone="warning" icon>
            {t("retention.holds", { count: data.activeHolds })}
          </StatusBadge>
        ) : null}
      </div>
      <PolicySentence policy={data.policy} scopedPolicies={data.scopedPolicies} />
      {showScopedLine ? (
        <p className="text-sm text-muted-foreground">
          {t("retention.scoped", { count: data.scopedPolicies })}
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t("retention:dashboardWidget.kept")}</dt>
        <dd className="text-right font-medium tabular-nums">
          {formatInteger(data.snapshots.active, language)}
        </dd>
        <dt className="text-muted-foreground">{t("retention:dashboardWidget.pruned")}</dt>
        <dd className="text-right font-medium tabular-nums">
          {formatInteger(data.snapshots.pruned, language)}
        </dd>
        <dt className="text-muted-foreground">{t("retention.oldest")}</dt>
        <dd className="text-right">
          <RelativeTime value={data.snapshots.oldestAt} fallback={t("retention.none")} />
        </dd>
        <dt className="text-muted-foreground">{t("retention.lastRun")}</dt>
        <dd className="flex items-center justify-end gap-2">
          {data.lastRun?.status === "failed" ? (
            <StatusBadge tone="destructive">{t("retention.runFailed")}</StatusBadge>
          ) : null}
          <RelativeTime value={data.lastRun?.at} fallback={t("retention.notRun")} />
        </dd>
      </dl>
    </div>
  );
}

/**
 * How long restore points are kept: the real active policy's rule (a
 * built-in preset's full sentence, daily/weekly thinning included, or the
 * cutoff plus a note when a custom or legacy policy also thins in between).
 * Without a tenant default it says so plainly — every restore point is kept
 * for objects without their own policy — and, honestly, that any per-object
 * overrides still prune their own objects (never the blanket "nothing is
 * ever deleted" claim when overrides exist); with no policy at all, it shows
 * the recommended default rule an administrator could add.
 */
export function RetentionWidget(props: WidgetStateProps<RetentionData>) {
  const { t } = useTranslation(["dashboard", "retention"]);
  return (
    <WidgetCard
      id="retention"
      {...props}
      title={t("retention:dashboardWidget.title")}
      description={t("retention:dashboardWidget.description")}
      icon={Hourglass}
      skeleton={<RetentionSkeleton />}
      empty={(data) =>
        data.snapshots.active === 0 && data.snapshots.pruned === 0
          ? {
              icon: Hourglass,
              title: t("retention:dashboardWidget.emptyTitle"),
              description: data.policy
                ? t("retention:dashboardWidget.emptyWithPolicy")
                : data.scopedPolicies > 0
                  ? t("retention:dashboardWidget.onlyOverrides", { count: data.scopedPolicies })
                  : t("retention:dashboardWidget.keepAll"),
            }
          : null
      }
    >
      {(data) => <RetentionBody data={data} />}
    </WidgetCard>
  );
}
