import { CircleX, LoaderCircle, Power } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";

import "../i18n";
import {
  type MountsView,
  mounterStarting,
  mountsErrorDetail,
  mountsErrorKey,
  useEnableMounter,
  useMounts,
} from "./mounts-api";

/** Whether the opt-in updater can start the mounter for this view ("Enable network shares"). */
export function canEnableThroughUpdater(view: MountsView | undefined): boolean {
  return Boolean(view && !view.available && !view.demo && view.enable?.via === "updater");
}

/**
 * "Enable network shares" (docs/FILESHARES.md 3.9): while the mounter is off and the opt-in
 * updater can start it, the provider owner starts it here; the api forwards the request to
 * the updater, which runs `docker compose --profile mounts up -d mounter` through its helper
 * container. Renders nothing without such an updater (the callers show the command then),
 * for everyone but the owner, and while the mounter runs. A missing recent sign-in opens the
 * identity dialog, which repeats the request.
 *
 * `view` is the Network shares view when the caller has it; otherwise the component reads it
 * (provider admins only: `enabled`).
 */
export function EnableMounterButton({
  view: given,
  mayEnable,
  enabled = true,
}: {
  view?: MountsView;
  mayEnable: boolean;
  enabled?: boolean;
}) {
  const { t, i18n } = useTranslation("installation");
  const query = useMounts(enabled && mayEnable && given === undefined);
  const view = given ?? query.data;
  const enable = useEnableMounter();
  const identity = useConfirmIdentity();
  if (!mayEnable || !canEnableThroughUpdater(view)) {
    return null;
  }
  const info = view?.enable;
  const attempt = info?.lastAttempt ?? null;
  const starting = mounterStarting(view) || enable.isPending;
  const language = i18n.resolvedLanguage ?? i18n.language;

  const submit = () => {
    enable.mutate(undefined, {
      onError: (error) => {
        if (isRecentSignInRequired(error)) {
          identity.ask(submit);
        }
      },
    });
  };
  const errorDetail = enable.isError ? mountsErrorDetail(enable.error) : null;

  return (
    <div className="space-y-2" data-slot="enable-mounter">
      <p className="text-sm">{t("mounts.enable.description")}</p>
      <Button
        type="button"
        size="sm"
        onClick={submit}
        loading={starting}
        disabled={starting}
        data-action="enable-mounter"
      >
        <Power aria-hidden="true" />
        {t("mounts.enable.button")}
      </Button>
      {starting ? (
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-slot="enable-mounter-starting"
        >
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          {attempt?.status === "started" && attempt.finishedAt
            ? t("mounts.enable.started", {
                when: formatRelative(attempt.finishedAt, language),
              })
            : t("mounts.enable.starting")}
        </p>
      ) : null}
      {!enable.isPending && attempt?.status === "failed" ? (
        <Alert variant="destructive" data-slot="enable-mounter-failed">
          <CircleX />
          <AlertTitle>{t("mounts.enable.failed.title")}</AlertTitle>
          <AlertDescription>
            <p>{t(`mounts.enable.failed.${attempt.reason ?? "generic"}`)}</p>
            {attempt.detail ? (
              <p className="mt-1 break-words font-mono text-xs">{attempt.detail}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}
      {enable.isError && !isRecentSignInRequired(enable.error) ? (
        <Alert variant="destructive" data-slot="enable-mounter-error">
          <CircleX />
          <AlertDescription>
            <p>{t(mountsErrorKey(enable.error))}</p>
            {errorDetail ? <p className="mt-1 text-xs">{errorDetail}</p> : null}
          </AlertDescription>
        </Alert>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t("mounts.enable.disable", { command: info?.disableCommand ?? "" })}
      </p>
      {identity.dialog}
    </div>
  );
}
