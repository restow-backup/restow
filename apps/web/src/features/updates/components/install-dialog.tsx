import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import type { UpdatesView } from "../api";
import { useScheduleUpdate } from "../hooks";
import {
  formatReleaseDate,
  isUnverifiableRelease,
  leadTimeLabel,
  offeredLeadTimes,
  updatesErrorKey,
} from "../presenters";
import { ChoiceOption } from "./choice-option";

/** Five minutes ahead is the default: long enough to save work, short enough not to forget it. */
export const DEFAULT_LEAD_SECONDS = 300;

/**
 * The question before an update: which version, when, and what will happen.
 * Confirming announces the maintenance (or starts at once with a lead time of
 * zero); the shell then shows the countdown to everyone signed in.
 */
export function InstallDialog({
  view,
  open,
  onOpenChange,
}: {
  view: UpdatesView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const schedule = useScheduleUpdate();
  const identity = useConfirmIdentity();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const leadTimes = offeredLeadTimes(view);
  const newest = view.releases[0]?.version ?? "";
  const defaultLead = leadTimes.includes(DEFAULT_LEAD_SECONDS)
    ? DEFAULT_LEAD_SECONDS
    : (leadTimes[0] ?? 0);

  const [version, setVersion] = React.useState(newest);
  const [lead, setLead] = React.useState(defaultLead);

  // Every opening starts from the newest version and the default lead time.
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setVersion(newest);
      setLead(defaultLead);
    }
  }
  const { reset } = schedule;
  React.useEffect(() => {
    if (open) {
      reset();
    }
  }, [open, reset]);

  const selected = view.releases.find((release) => release.version === version) ?? view.releases[0];
  const selectedVersion = selected?.version ?? "";
  const unverifiable = isUnverifiableRelease(view, selected);

  const announce = (input: { version: string; leadSeconds: number }) => {
    schedule.mutate(input, {
      onSuccess: () => onOpenChange(false),
      onError: (error) => {
        // Announcing needs a recent sign-in (apps/api lib/recent-sign-in.ts); once the
        // person confirmed it is them, the same choice is sent again.
        if (isRecentSignInRequired(error)) {
          identity.ask(() => announce(input));
        }
      },
    });
  };

  const confirm = () => {
    if (schedule.isPending || selectedVersion === "" || unverifiable) {
      return;
    }
    announce({ version: selectedVersion, leadSeconds: lead });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // The question cannot be abandoned while the request runs.
        if (!next && schedule.isPending) {
          return;
        }
        onOpenChange(next);
      }}
    >
      {/* The body scrolls on a short screen; the title and the buttons stay in reach. */}
      <AlertDialogContent
        className="max-h-[92svh] grid-rows-[auto_minmax(0,1fr)_auto]"
        onEscapeKeyDown={(event) => {
          if (schedule.isPending) {
            event.preventDefault();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("install.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("install.description")}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1 pb-1" data-slot="install-body">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm leading-none font-medium">
              {t("install.version")}
            </legend>
            <div className="grid gap-2">
              {view.releases.map((release) => {
                const date = formatReleaseDate(release.publishedAt, language);
                return (
                  <ChoiceOption
                    key={release.tag}
                    name="update-version"
                    value={release.version}
                    checked={selectedVersion === release.version}
                    onSelect={setVersion}
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium">{release.version}</span>
                      {release.version === newest ? (
                        <Badge variant="info">{t("releases.newest")}</Badge>
                      ) : null}
                      {release.prerelease ? (
                        <Badge variant="warning">{t("releases.prerelease")}</Badge>
                      ) : null}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {date ? t("releases.released", { date }) : t("releases.noDate")}
                    </span>
                  </ChoiceOption>
                );
              })}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm leading-none font-medium">{t("install.lead")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {leadTimes.map((seconds) => {
                const label = leadTimeLabel(seconds);
                return (
                  <ChoiceOption
                    key={seconds}
                    name="update-lead"
                    value={String(seconds)}
                    checked={lead === seconds}
                    onSelect={(value) => setLead(Number(value))}
                  >
                    <span className="block font-medium">{t(label.key, label.params)}</span>
                  </ChoiceOption>
                );
              })}
            </div>
          </fieldset>

          {unverifiable ? (
            <Alert variant="warning" data-slot="release-unverifiable">
              <TriangleAlert />
              <AlertDescription>{t("install.unverifiable")}</AlertDescription>
            </Alert>
          ) : null}

          {selected?.prerelease ? (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>{t("install.prerelease")}</AlertDescription>
            </Alert>
          ) : null}

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("install.effects.title")}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("install.effects.downtime")}</li>
              <li>{t("install.effects.backup")}</li>
              <li>{t("install.effects.rollback")}</li>
              <li>{t("install.effects.countdown")}</li>
              <li>
                {view.mode === "image"
                  ? t("install.effects.modeImage")
                  : t("install.effects.modeSource", { tag: selected?.tag ?? "" })}
              </li>
            </ul>
          </div>
          {schedule.isError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t(updatesErrorKey(schedule.error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={schedule.isPending}>
            {tc("actions.cancel")}
          </AlertDialogCancel>
          <Button
            type="button"
            onClick={confirm}
            loading={schedule.isPending}
            disabled={unverifiable}
          >
            {lead === 0 ? t("install.confirmNow") : t("install.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
      {identity.dialog}
    </AlertDialog>
  );
}
