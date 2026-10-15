import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";

import "../i18n";
import type { Suspicion } from "../api";
import { lastCleanOf, type PointRef } from "../presenters";

/**
 * Above the restore points of an object whose newest restore point is suspicious: since when
 * restore points show signs of ransomware, and a button that picks the newest one without
 * findings, where a restore should start. Nothing while the newest restore point is clean.
 */
export function LastCleanHint<P extends PointRef>({
  points,
  judgements,
  onPick,
}: {
  points: readonly P[];
  judgements: ReadonlyMap<string, Suspicion>;
  onPick: (point: P) => void;
}) {
  const { t, i18n } = useTranslation("suspicion");
  const found = lastCleanOf(points, judgements);
  if (!found) {
    return null;
  }
  const when = (time: string) => formatDateTime(time, i18n.language) ?? time;
  const clean = found.clean;
  return (
    <Alert variant="destructive" data-slot="last-clean-hint">
      <ShieldAlert aria-hidden="true" />
      <AlertTitle>{t("lastClean.title")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>
          {clean
            ? t("lastClean.description", { since: when(found.since.time), time: when(clean.time) })
            : t("lastClean.none")}
        </p>
        {clean ? (
          <Button size="sm" variant="outline" onClick={() => onPick(clean)}>
            {t("lastClean.pick")}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

/** Under the title of a chosen restore point that is suspicious: which one is the last clean. */
export function SelectedPointNote<P extends PointRef>({
  point,
  points,
  judgements,
}: {
  point: P;
  points: readonly P[];
  judgements: ReadonlyMap<string, Suspicion>;
}) {
  const { t, i18n } = useTranslation("suspicion");
  if (!judgements.get(point.id)?.active) {
    return null;
  }
  const older = points.filter((other) => Date.parse(other.time) < Date.parse(point.time));
  const clean = [...older]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .find((other) => !judgements.get(other.id)?.active);
  return (
    <p className="text-sm text-destructive-text" data-slot="selected-point-suspicious">
      {clean
        ? t("lastClean.selected", { time: formatDateTime(clean.time, i18n.language) ?? clean.time })
        : t("lastClean.selectedNone")}
    </p>
  );
}
