import { CircleCheck, CircleMinus, CircleX, type LucideIcon, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { StatusBadge, type StatusTone } from "@/components/kit";

import type {
  BaremetalCheck,
  BaremetalCheckFinding,
  BaremetalCheckStatus,
  BaremetalLayoutCheck,
  BaremetalPlannerRun,
} from "../api.js";
import { useEndpointFormat } from "../hooks.js";

// A passed stage 1 is not proof that the machine starts: never green (docs/BAREMETAL.md 12).
const RESULT_TONE: Record<BaremetalCheck["readiness"], StatusTone> = {
  green: "neutral",
  red: "destructive",
  yellow: "warning",
};

const STATUS_ICON: Record<BaremetalCheckStatus, { icon: LucideIcon; className: string }> = {
  ok: { icon: CircleCheck, className: "text-success" },
  warning: { icon: TriangleAlert, className: "text-warning" },
  failed: { icon: CircleX, className: "text-destructive" },
  skipped: { icon: CircleMinus, className: "text-muted-foreground" },
};

/** The ICU placeholders a text names (`{target}`, `{count, plural, …}`). */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)].map(
    (match) => match[1] as string,
  );
}

/** A parameter as text: sizes in bytes formatted, lists joined, anything else as it reads. */
function paramText(key: string, value: unknown, bytes: (value: number) => string): string | number {
  if (typeof value === "number") {
    return /bytes$/i.test(key) ? bytes(value) : value;
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "✓" : "–";
  if (Array.isArray(value))
    return value.map((item) => String(paramText(key, item, bytes))).join(", ");
  if (value === null || value === undefined) return "–";
  return JSON.stringify(value);
}

/**
 * The words of a finding: a planner code by `baremetal.plan.codes.<code>`, a check code by
 * `baremetal.check.findings.<code>`, its parameters filled in; a placeholder the finding has no
 * value for reads as a dash, never as `{name}`.
 */
export function useFindingText() {
  const { t, i18n } = useTranslation("endpoints");
  const format = useEndpointFormat();
  return (finding: Pick<BaremetalCheckFinding, "code" | "params">, plan: boolean) => {
    const key = plan
      ? `baremetal.plan.codes.${finding.code}`
      : `baremetal.check.findings.${finding.code}`;
    const template =
      i18n.getResource(i18n.language, "endpoints", key) ?? i18n.getResource("en", "endpoints", key);
    const values: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(finding.params ?? {})) {
      values[name] = paramText(name, value, format.bytes);
    }
    // `bytes` of the restore sizes is a size, too.
    if (typeof finding.params?.bytes === "number")
      values.bytes = format.bytes(finding.params.bytes);
    for (const name of typeof template === "string" ? placeholders(template) : []) {
      if (!(name in values)) values[name] = name === "count" || name === "mounts" ? 0 : "–";
    }
    return t(key, { ...values, defaultValue: finding.code });
  };
}

function evidenceLines(evidence: Record<string, unknown>): string[] {
  return Object.entries(evidence).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}: ${value.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : String(item))).join("; ")}`;
    }
    return `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}`;
  });
}

function CheckRow({ check }: { check: BaremetalLayoutCheck }) {
  const { t } = useTranslation("endpoints");
  const text = useFindingText();
  const [open, setOpen] = useState(false);
  const { icon: Icon, className } = STATUS_ICON[check.status] ?? STATUS_ICON.skipped;
  const lines = evidenceLines(check.evidence ?? {});
  return (
    <li
      className="py-1"
      data-slot="baremetal-check"
      data-check={check.id}
      data-status={check.status}
    >
      <div className="flex items-start gap-2 text-sm">
        <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${className}`} />
        <span className="min-w-0 flex-1">
          <span className="font-mono text-xs text-muted-foreground">{check.id}</span>{" "}
          {t(`baremetal.check.items.${check.id}`)}
        </span>
        <span className="text-xs text-muted-foreground">
          {t(`baremetal.check.status.${check.status}`)}
        </span>
      </div>
      {check.findings.length > 0 ? (
        <ul className="mt-1 ml-6 space-y-0.5 text-sm" data-slot="baremetal-check-findings">
          {check.findings.map((finding, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: findings carry no id; a report never changes.
              key={`${finding.code}-${finding.ref ?? ""}-${index}`}
              data-severity={finding.severity}
              className={
                finding.severity === "failed"
                  ? "text-destructive"
                  : finding.severity === "warning"
                    ? undefined
                    : "text-muted-foreground"
              }
            >
              {text(
                finding,
                check.id === "L3" && finding.code !== "planner_refused_valid_manifest",
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {lines.length > 0 ? (
        <details
          className="mt-1 ml-6 text-xs"
          data-slot="baremetal-evidence"
          onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary className="cursor-pointer text-muted-foreground">
            {open ? t("baremetal.check.hideEvidence") : t("baremetal.check.showEvidence")}
          </summary>
          <pre className="mt-1 whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1 font-mono">
            {lines.join("\n")}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

const PLANNER_TARGETS = [
  ["same", "same"],
  ["minimal", "minimal"],
  ["otherController", "other-controller"],
] as const;

function PlannerRun({ label, run }: { label: string; run: BaremetalPlannerRun }) {
  const { t } = useTranslation("endpoints");
  const text = useFindingText();
  const findings = [...(run.problems ?? []), ...(run.warnings ?? [])];
  return (
    <li className="text-sm" data-slot="baremetal-planner-run">
      <span className="font-medium">{label}</span>
      {": "}
      {run.incomplete
        ? t(`baremetal.check.incomplete.${run.incomplete}`, { defaultValue: run.incomplete })
        : run.refused
          ? t("baremetal.check.plannerRefused")
          : run.ok && findings.length === 0
            ? t("baremetal.check.plannerOk")
            : null}
      {findings.length > 0 ? (
        <ul className="ml-4 list-disc">
          {(run.problems ?? []).map((finding, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: findings carry no id; a report never changes.
              key={`p-${finding.code}-${index}`}
              className="text-destructive"
              data-severity="problem"
            >
              {text(finding, true)}
            </li>
          ))}
          {(run.warnings ?? []).map((finding, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: findings carry no id; a report never changes.
            <li key={`w-${finding.code}-${index}`} data-severity="warning">
              {text(finding, true)}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The newest layout check of the machine (docs/BAREMETAL.md 12.1, 14.6): when it ran, on which
 * restore point, its result, each check L1 to L8 with what it found and its evidence (text only,
 * folded), and what the restore planner said for each target.
 */
export function BaremetalCheckReport({ check }: { check: BaremetalCheck }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  return (
    <section className="space-y-2" data-slot="baremetal-check-report">
      <h3 className="text-sm font-medium">{t("baremetal.check.title")}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t("baremetal.check.checkedAt")}</dt>
        <dd>{format.dateTime(check.checkedAt)}</dd>
        {check.snapshotId ? (
          <>
            <dt className="text-muted-foreground">{t("baremetal.check.snapshot")}</dt>
            <dd className="font-mono text-xs">{check.snapshotId.slice(0, 8)}</dd>
          </>
        ) : null}
        <dt className="sr-only">{t("baremetal.check.title")}</dt>
        <dd className="col-span-2">
          <StatusBadge tone={RESULT_TONE[check.readiness]} data-slot="baremetal-check-result">
            {t(`baremetal.check.result.${check.readiness}`)}
          </StatusBadge>
          {check.incomplete ? (
            <span className="ml-2 text-muted-foreground" data-slot="baremetal-check-incomplete">
              {t(`baremetal.check.incomplete.${check.incomplete}`, {
                defaultValue: check.incomplete,
              })}
            </span>
          ) : null}
        </dd>
      </dl>
      <ul className="divide-y divide-border" data-slot="baremetal-checks">
        {check.checks.map((item) => (
          <CheckRow key={item.id} check={item} />
        ))}
      </ul>
      {check.planner ? (
        <div className="space-y-1">
          <h4 className="text-sm font-medium">{t("baremetal.check.plannerTitle")}</h4>
          <ul className="space-y-1">
            {PLANNER_TARGETS.map(([key, target]) => {
              const run = check.planner?.[key];
              return run ? (
                <PlannerRun key={key} label={t(`baremetal.check.targets.${target}`)} run={run} />
              ) : null;
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
