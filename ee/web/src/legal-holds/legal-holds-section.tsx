import * as React from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import "@/features/archive/i18n";

import { useCreateLegalHold, useLegalHoldScope, useLegalHolds, useReleaseLegalHold } from "./hooks";

/**
 * Legal holds on the archive page (slot `archive.sections`): place a hold
 * with a reason, list the tenant's holds, release an active one
 * (docs/ARCHIVE.md). Rendered only for a tenant administrator on an edition
 * with legal holds; the archive page itself handles every other access state.
 */
export function LegalHoldsSection() {
  const { t } = useTranslation("archive");
  const { enabled, canManage, licensed } = useLegalHoldScope();
  const legalHolds = useLegalHolds();
  const createHold = useCreateLegalHold();
  const releaseHold = useReleaseLegalHold();
  const [holdReason, setHoldReason] = React.useState("");

  if (!enabled || !canManage || !licensed) {
    return null;
  }

  return (
    <div className="space-y-2 rounded-md border p-4">
      <h3 className="font-medium">{t("legalHold.title")}</h3>
      <p className="text-muted-foreground text-sm">{t("legalHold.description")}</p>
      <div className="flex gap-2">
        <Textarea
          placeholder={t("legalHold.reasonPlaceholder")}
          value={holdReason}
          onChange={(event) => setHoldReason(event.target.value)}
        />
        <Button
          disabled={holdReason.trim().length === 0 || createHold.isPending}
          onClick={() => {
            void createHold
              .mutateAsync({ reason: holdReason.trim() })
              .then(() => setHoldReason(""));
          }}
        >
          {t("actions.placeHold")}
        </Button>
      </div>
      {legalHolds.data && legalHolds.data.items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("legalHold.empty")}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {legalHolds.data?.items.map((hold) => (
            <li key={hold.id} className="flex items-center justify-between gap-2">
              <span>
                {hold.reason} ({hold.active ? t("legalHold.active") : t("legalHold.released")})
              </span>
              {hold.active && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void releaseHold.mutateAsync(hold.id)}
                >
                  {t("actions.release")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
