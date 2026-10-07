import * as React from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, ErrorState } from "@/components/kit";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import "@/features/archive/i18n";
import { mailboxesOfArchive } from "@/features/archive/archive-page";
import { useSnapshotObjects } from "@/features/restore/use-restore-data";
import { errorMessageKey } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

import type { LegalHold } from "./api";
import { useCreateLegalHold, useLegalHoldScope, useLegalHolds, useReleaseLegalHold } from "./hooks";

const WHOLE_TENANT = "tenant";

/** Where a hold applies, by name: the whole tenant, a mailbox, or one that is no longer protected. */
export function holdScopeLabel(
  hold: Pick<LegalHold, "protectedObjectId">,
  mailboxes: readonly { id: string; label: string }[],
  t: (key: string) => string,
): string {
  if (hold.protectedObjectId === null) {
    return t("legalHold.mailboxAll");
  }
  return (
    mailboxes.find((mailbox) => mailbox.id === hold.protectedObjectId)?.label ??
    t("legalHold.mailboxRemoved")
  );
}

/**
 * Legal holds in the tenant's archive settings (slot `tenant.archiveSettings`):
 * place a hold for the whole tenant or one mailbox, list every hold with its
 * scope and dates, and release an active one after a confirmation that asks
 * for the reason (recorded in the audit log). Rendered only for a tenant
 * administrator on an edition with legal holds.
 */
export function LegalHoldsSection() {
  const { t, i18n } = useTranslation("archive");
  const { t: tCommon } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const { enabled, canManage, licensed } = useLegalHoldScope();
  const legalHolds = useLegalHolds();
  const createHold = useCreateLegalHold();
  const releaseHold = useReleaseLegalHold();
  const objects = useSnapshotObjects();
  const mailboxes = mailboxesOfArchive(objects.data ?? []);
  const [holdReason, setHoldReason] = React.useState("");
  const [scope, setScope] = React.useState<string>(WHOLE_TENANT);
  const [releasing, setReleasing] = React.useState<LegalHold | null>(null);
  const [releaseReason, setReleaseReason] = React.useState("");

  if (!enabled || !canManage || !licensed) {
    return null;
  }

  const place = () => {
    const reason = holdReason.trim();
    if (reason.length === 0 || createHold.isPending) {
      return;
    }
    createHold.mutate(
      { reason, protectedObjectId: scope === WHOLE_TENANT ? null : scope },
      {
        onSuccess: () => {
          setHoldReason("");
          setScope(WHOLE_TENANT);
          toast.success(t("legalHold.createDone"));
        },
        onError: (error) =>
          toast.error(t("legalHold.createFailed"), {
            description: tCommon(errorMessageKey(error)),
          }),
      },
    );
  };

  const date = (iso: string | null) => (iso ? (formatDateTime(iso, language) ?? iso) : "—");
  const items = legalHolds.data?.items ?? [];

  return (
    <div className="space-y-3 rounded-md border p-4" data-slot="legal-holds">
      <h3 className="font-medium">{t("legalHold.title")}</h3>
      <p className="text-muted-foreground text-sm">{t("legalHold.description")}</p>

      <form
        className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          place();
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="legal-hold-reason" className="text-xs text-muted-foreground">
            {t("legalHold.reason")}
          </Label>
          <Textarea
            id="legal-hold-reason"
            placeholder={t("legalHold.reasonPlaceholder")}
            value={holdReason}
            onChange={(event) => setHoldReason(event.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs text-muted-foreground">{t("legalHold.scope")}</Label>
          <Select value={scope} onValueChange={setScope}>
            <SelectTrigger className="w-full" aria-label={t("legalHold.scope")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={WHOLE_TENANT}>{t("legalHold.mailboxAll")}</SelectItem>
              {mailboxes.map((mailbox) => (
                <SelectItem key={mailbox.id} value={mailbox.id}>
                  {mailbox.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="submit"
          disabled={holdReason.trim().length === 0}
          loading={createHold.isPending}
        >
          {t("actions.placeHold")}
        </Button>
      </form>

      {legalHolds.isError ? (
        <ErrorState
          title={t("legalHold.loadError")}
          error={legalHolds.error}
          onRetry={() => void legalHolds.refetch()}
          retrying={legalHolds.isFetching}
        />
      ) : legalHolds.data && items.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("legalHold.empty")}</p>
      ) : items.length > 0 ? (
        <Table className="min-w-[36rem]" scrollLabel={t("legalHold.title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("legalHold.reason")}</TableHead>
              <TableHead>{t("legalHold.scope")}</TableHead>
              <TableHead>{t("legalHold.status")}</TableHead>
              <TableHead>{t("legalHold.createdAt")}</TableHead>
              <TableHead>{t("legalHold.releasedAt")}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((hold) => (
              <TableRow key={hold.id} data-hold={hold.id}>
                <TableCell className="max-w-64 whitespace-pre-wrap break-words">
                  {hold.reason}
                </TableCell>
                <TableCell>{holdScopeLabel(hold, mailboxes, t)}</TableCell>
                <TableCell>
                  <Badge variant={hold.active ? "warning" : "secondary"}>
                    {hold.active ? t("legalHold.active") : t("legalHold.released")}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-nowrap">{date(hold.createdAt)}</TableCell>
                <TableCell className="whitespace-nowrap">{date(hold.releasedAt)}</TableCell>
                <TableCell>
                  {hold.active ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setReleaseReason("");
                        setReleasing(hold);
                      }}
                    >
                      {t("actions.release")}
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}

      <ConfirmDialog
        open={releasing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setReleasing(null);
          }
        }}
        title={t("legalHold.releaseDialog.title")}
        description={
          <>
            <p>{t("legalHold.releaseDialog.description")}</p>
            {releasing ? (
              <p className="font-medium text-foreground">
                {t("legalHold.releaseDialog.hold", {
                  reason: releasing.reason,
                  date: date(releasing.createdAt),
                })}
              </p>
            ) : null}
          </>
        }
        confirmLabel={t("legalHold.releaseDialog.confirm")}
        destructive
        confirmDisabled={releaseReason.trim().length === 0}
        onConfirm={async () => {
          if (!releasing) {
            return;
          }
          await releaseHold.mutateAsync({ id: releasing.id, reason: releaseReason.trim() });
          toast.success(t("legalHold.releaseDone"));
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="legal-hold-release-reason">
            {t("legalHold.releaseDialog.reasonLabel")}
          </Label>
          <Textarea
            id="legal-hold-release-reason"
            value={releaseReason}
            placeholder={t("legalHold.releaseDialog.reasonPlaceholder")}
            onChange={(event) => setReleaseReason(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("legalHold.releaseDialog.reasonHint")}</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}
