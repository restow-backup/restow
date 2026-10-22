import { Lock } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { useSession } from "@/lib/session";

import { sourceErrorKey } from "../presenters";
import type { ArchiveIdle, SourceDto } from "../types";
import { useUpdateSource } from "../use-sources";

const OPTIONS: readonly ArchiveIdle[] = ["auto", "off"];

/**
 * How the archive capture watches the accounts of an IMAP source (docs/IMAP.md
 * "Archivierung"): `auto` keeps one IMAP IDLE connection per account where the server offers
 * it, `off` only checks at intervals, for providers that allow few connections per account.
 * Saved at once (PATCH `archiveIdle`); the workers pick it up within a minute. Without the
 * edition that archives from the mailbox the choice is shown locked.
 */
export function ImapArchiveCard({ source }: { source: SourceDto }) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const session = useSession();
  const update = useUpdateSource(source.id);
  const id = React.useId();
  const current = source.imap?.archiveIdle ?? "auto";
  const available = session.features?.includes("archive.mailboxCapture") ?? false;

  if (!source.imap) {
    return null;
  }

  const choose = (value: string) => {
    if (value !== "auto" && value !== "off") return;
    if (value === current) return;
    update.mutate(
      { archiveIdle: value },
      {
        onSuccess: () => toast.success(t("toasts.archiveIdleSaved")),
        onError: (error) => toast.error(tc(sourceErrorKey(error))),
      },
    );
  };

  return (
    <Card data-slot="imap-archive">
      <CardHeader className="space-y-1.5">
        <CardTitle className="text-base">{t("imap.archive.title")}</CardTitle>
        <CardDescription>{t("imap.archive.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <RadioGroup
          value={current}
          onValueChange={choose}
          disabled={!available || update.isPending}
          aria-label={t("imap.archive.idle.label")}
        >
          {OPTIONS.map((option) => (
            <div
              key={option}
              className="flex items-start gap-2"
              data-slot={`archive-idle-${option}`}
            >
              <RadioGroupItem
                id={`${id}-${option}`}
                value={option}
                className="mt-0.5"
                aria-describedby={`${id}-${option}-hint`}
              />
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={`${id}-${option}`} className="font-normal">
                  {t(`imap.archive.idle.options.${option}`)}
                </Label>
                <p id={`${id}-${option}-hint`} className="text-xs text-muted-foreground">
                  {t(`imap.archive.idle.hints.${option}`)}
                </p>
              </div>
            </div>
          ))}
        </RadioGroup>
        {available ? null : (
          <p
            className="flex items-center gap-1 text-xs text-muted-foreground"
            data-slot="archive-idle-edition"
          >
            <Lock aria-hidden="true" className="size-3 shrink-0" />
            {t("imap.archive.edition")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
