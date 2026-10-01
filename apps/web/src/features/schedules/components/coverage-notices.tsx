import { Eye, Info, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { ScheduleItem, ScheduleList } from "../api.js";
import { coverageOf } from "../presenters.js";

export interface CoverageNoticesProps {
  list: ScheduleList;
  canManage: boolean;
  /** Add the missing recommended schedules. */
  onApplyRecommended: () => void;
  applying: boolean;
  /** Switch a paused schedule back on. */
  onEnable: (item: ScheduleItem) => void;
  /** Id of the schedule being switched right now. */
  pendingId: string | null;
}

/**
 * The plain truth above the table: backups that run only by hand, backups
 * that are never verified, recommendations not set up yet, what retention
 * does, and that tenant users look but do not change. Each problem comes with
 * the action that fixes it (for administrators).
 */
export function CoverageNotices({
  list,
  canManage,
  onApplyRecommended,
  applying,
  onEnable,
  pendingId,
}: CoverageNoticesProps) {
  const { t } = useTranslation("schedules");
  const backup = coverageOf(list.items, "backup");
  const verify = coverageOf(list.items, "verify");
  const hasRetention = list.items.some((item) => item.kind === "retention" && item.enabled);
  // Missing kinds already named by a warning above are not repeated in the hint.
  const otherMissing = list.missingKinds.filter(
    (kind) =>
      !(kind === "backup" && backup.state === "missing") &&
      !(kind === "verify" && verify.state === "missing"),
  );

  const applyButton = (
    <Button size="sm" variant="outline" onClick={onApplyRecommended} loading={applying}>
      <Sparkles aria-hidden="true" />
      {t("actions.applyRecommended")}
    </Button>
  );
  const enableButton = (item: ScheduleItem) => (
    <Button
      size="sm"
      variant="outline"
      onClick={() => onEnable(item)}
      loading={pendingId === item.id}
    >
      {t("actions.enable")}
    </Button>
  );

  return (
    <div className="space-y-3" data-slot="coverage-notices">
      {!canManage ? (
        <Alert variant="info">
          <Eye aria-hidden="true" />
          <AlertDescription>{t("notices.readOnly")}</AlertDescription>
        </Alert>
      ) : null}

      {backup.state !== "active" ? (
        <Alert variant="warning" data-notice="backup">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{t("notices.noBackup.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {backup.state === "paused"
                ? t("notices.noBackup.paused")
                : t("notices.noBackup.missing")}
            </span>
            {canManage ? (backup.paused ? enableButton(backup.paused) : applyButton) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {verify.state !== "active" ? (
        <Alert variant="warning" data-notice="verify">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{t("notices.noVerify.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {verify.state === "paused"
                ? t("notices.noVerify.paused")
                : t("notices.noVerify.missing")}
            </span>
            {canManage
              ? verify.paused
                ? enableButton(verify.paused)
                : backup.state === "missing"
                  ? null
                  : applyButton
              : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {otherMissing.length > 0 && backup.state === "active" && verify.state === "active" ? (
        <Alert variant="info" data-notice="recommended">
          <Sparkles aria-hidden="true" />
          <AlertTitle>{t("notices.recommended.title")}</AlertTitle>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>
              {t("notices.recommended.description", {
                kinds: otherMissing.map((kind) => t(`kinds.${kind}`)).join(", "),
              })}
            </span>
            {canManage ? applyButton : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {hasRetention ? (
        <Alert data-notice="retention">
          <Info aria-hidden="true" />
          <AlertDescription>{t("notices.retention")}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
