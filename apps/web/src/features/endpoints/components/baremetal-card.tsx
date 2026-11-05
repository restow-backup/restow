import { HardDrive } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge, type StatusTone } from "@/components/kit";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import type { Baremetal, BaremetalState, LayoutUnsupported, LayoutVerdict } from "../api.js";
import { useBaremetal, useEndpointFormat } from "../hooks.js";
import { BaremetalCheckReport } from "./baremetal-check-report.js";
import { LayoutSummary } from "./layout-summary.js";
import { MinimumSizes } from "./minimum-sizes.js";

const STATE_TONE: Record<BaremetalState, StatusTone> = {
  not_enabled: "muted",
  not_possible: "muted",
  no_layout: "info",
  // A captured layout proves nothing yet.
  unverified: "info",
  // Stage 1 passed; only a boot probe (a later release) is proof that the machine starts, and
  // green is kept for proof (docs/BAREMETAL.md 12).
  layout_checked: "neutral",
  red: "destructive",
};

/** The explanation under the state, if it has one. */
function stateHint(baremetal: Baremetal): string | null {
  switch (baremetal.state) {
    case "unverified":
      return baremetal.stateDetail === "incomplete"
        ? "baremetal.incompleteHint"
        : "baremetal.unverifiedHint";
    case "layout_checked":
      return "baremetal.layoutCheckedHint";
    case "red":
      return "baremetal.redHint";
    default:
      return null;
  }
}

const VERDICT_TONE: Record<LayoutVerdict, StatusTone> = {
  supported: "neutral",
  supported_with_warnings: "warning",
  unsupported: "destructive",
};

/** Whether the card has anything to say: a layout, or the preview for a machine it concerns. */
export function showsBaremetalCard(baremetal: Baremetal | undefined): boolean {
  if (!baremetal) {
    return false;
  }
  if (baremetal.latest) {
    return true;
  }
  return baremetal.preview && (baremetal.enabled || baremetal.state !== "not_possible");
}

function Findings({ items }: { items: LayoutUnsupported[] }) {
  const { t } = useTranslation("endpoints");
  if (items.length === 0) {
    return null;
  }
  // Unsupported first, then the warnings; each in the words of its code.
  const sorted = [...items].sort((a, b) =>
    a.severity === b.severity ? 0 : a.severity === "unsupported" ? -1 : 1,
  );
  return (
    <ul className="space-y-1 text-sm" data-slot="baremetal-findings">
      {sorted.map((item, index) => (
        <li
          key={`${item.code}-${item.ref ?? index}`}
          className={
            item.severity === "unsupported"
              ? "rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1"
              : "rounded-md border border-warning/40 bg-warning/5 px-2 py-1"
          }
          data-severity={item.severity}
        >
          {t(`baremetal.codes.${item.code}`, { defaultValue: item.message })}
          {item.ref ? (
            <span className="ml-1 font-mono text-xs text-muted-foreground">{item.ref}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Bare metal (preview) on the machine's page (docs/BAREMETAL.md 14.6): whether the machine is
 * backed up as a whole, its rating (12.4, up to "layout checked"), the layout check of the newest
 * restore point with its evidence and the minimum sizes of replacement hardware, the layout its
 * newest whole machine backup recorded with the verdict and what is not supported, the summary
 * of the layout, and what to leave free for snapshots. A restore wizard, the recovery ISO and the
 * boot probe come with later releases.
 */
export function BaremetalCard({ endpointId }: { endpointId: string }) {
  const { t } = useTranslation("endpoints");
  const format = useEndpointFormat();
  const query = useBaremetal(endpointId);
  const baremetal = query.data;
  if (query.isPending) {
    return null;
  }
  if (!showsBaremetalCard(baremetal) || !baremetal) {
    return null;
  }
  const latest = baremetal.latest;
  const hint = stateHint(baremetal);
  const check = baremetal.check;
  return (
    <Card data-slot="baremetal-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive aria-hidden="true" className="size-4" />
          {t("baremetal.title")}
        </CardTitle>
        <CardDescription>
          <StatusBadge tone={STATE_TONE[baremetal.state]} data-slot="baremetal-state">
            {t(`baremetal.states.${baremetal.state}`)}
          </StatusBadge>
          {baremetal.notPossible ? (
            <span className="ml-2">{t(`baremetal.notPossible.${baremetal.notPossible}`)}</span>
          ) : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {hint ? (
          <p className="text-sm text-muted-foreground" data-slot="baremetal-hint">
            {t(hint)}
          </p>
        ) : null}
        {baremetal.snapshotHint ? (
          <p
            className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm"
            data-slot="snapshot-hint"
          >
            {t("baremetal.snapshotHint", {
              vg: baremetal.snapshotHint.vg,
              size: format.bytes(baremetal.snapshotHint.suggestedFreeBytes),
              mounts: baremetal.snapshotHint.mounts.join(", "),
            })}
          </p>
        ) : null}
        {latest ? (
          <>
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{t("baremetal.capturedAt")}</dt>
              <dd>{format.dateTime(latest.capturedAt)}</dd>
              {latest.snapshotId ? (
                <>
                  <dt className="text-muted-foreground">{t("baremetal.snapshot")}</dt>
                  <dd className="font-mono text-xs">{latest.snapshotId.slice(0, 8)}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">{t("baremetal.verdictLabel")}</dt>
              <dd>
                <StatusBadge tone={VERDICT_TONE[latest.verdict]} data-slot="baremetal-verdict">
                  {t(`baremetal.verdict.${latest.verdict}`)}
                </StatusBadge>
              </dd>
            </dl>
            <Findings items={latest.unsupported} />
            {check ? (
              <>
                <BaremetalCheckReport check={check} />
                {check.minimumSizes ? <MinimumSizes sizes={check.minimumSizes} /> : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground" data-slot="baremetal-check-pending">
                {t("baremetal.check.pending")}
              </p>
            )}
            <LayoutSummary summary={latest.summary} />
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
