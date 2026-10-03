import { Info, KeyRound, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useConfirmIdentity } from "@/components/confirm-identity-dialog";
import { ErrorState } from "@/components/error-state";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import type { UpdatesView } from "@/features/updates/api";
import { ChoiceOption } from "@/features/updates/components/choice-option";
import { CommandList } from "@/features/updates/components/command-block";
import { DEFAULT_LEAD_SECONDS } from "@/features/updates/components/install-dialog";
import {
  useRemovePendingLicenseKey,
  useStorePendingLicenseKey,
  useSwitchToFullBuild,
  useUpdates,
} from "@/features/updates/hooks";
import "@/features/updates/i18n";
import {
  ENABLE_UPDATER_COMMAND,
  editionSwitchPath,
  leadTimeLabel,
  manualSwitchLines,
  offeredLeadTimes,
  updatesErrorKey,
} from "@/features/updates/presenters";
import { providerMay } from "@/lib/provider-role";
import { isRecentSignInRequired } from "@/lib/recent-sign-in";
import { useSession } from "@/lib/session";

/**
 * Installation, Edition: shown on the Community build only (sections.tsx). It says which
 * build runs, what the full build adds, and switches to it: through the updater when it
 * runs (the full images of the same version, signature-checked, with a backup and a
 * rollback), else with the two `.env` lines to copy. A license key can be stored here
 * already; the Community build keeps it unread, and the full build checks and applies it
 * after the switch.
 */
export function EditionSection() {
  const { t } = useTranslation("updates");
  const session = useSession();
  const query = useUpdates();
  if (query.isPending) {
    return <Skeleton className="h-40 w-full" />;
  }
  if (query.isError && !query.data) {
    return (
      <ErrorState
        title={t("loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const view = query.data;
  if (!view) {
    return <Skeleton className="h-40 w-full" />;
  }
  return <EditionContent view={view} canManage={providerMay(session, "owner")} />;
}

export function EditionContent({ view, canManage }: { view: UpdatesView; canManage: boolean }) {
  const { t } = useTranslation("updates");
  const canChange = canManage && !view.demo;
  const edition = view.edition;

  if (edition?.build === "full") {
    // The api runs the full build already, this page not yet (the web edge is replaced last).
    return (
      <Alert variant="info" data-slot="edition-switched">
        <Info />
        <AlertDescription>{t("edition.switched")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6" data-slot="edition">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            {t("edition.title")}
            <Badge variant="secondary">{t("edition.badge")}</Badge>
          </CardTitle>
          <CardDescription>{t("edition.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="font-medium">{t("edition.adds.title")}</p>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground" data-slot="edition-adds">
            <li>{t("edition.adds.business")}</li>
            <li>{t("edition.adds.serviceProvider")}</li>
          </ul>
          <p className="text-muted-foreground">{t("edition.adds.license")}</p>
        </CardContent>
      </Card>
      <SwitchCard view={view} canChange={canChange} />
      <LicenseKeyCard view={view} canChange={canChange} />
    </div>
  );
}

function SwitchCard({ view, canChange }: { view: UpdatesView; canChange: boolean }) {
  const { t } = useTranslation("updates");
  const [open, setOpen] = React.useState(false);
  const path = editionSwitchPath(view);
  const lines = manualSwitchLines(view);
  return (
    <Card data-slot="edition-switch" data-path={path}>
      <CardHeader>
        <CardTitle>{t("edition.switch.title")}</CardTitle>
        <CardDescription>{t("edition.switch.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {path === "updater" ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              {t("edition.switch.updater", { version: view.running ?? "" })}
            </p>
            <Button className="shrink-0" onClick={() => setOpen(true)} disabled={!canChange}>
              {t("edition.switch.button")}
            </Button>
          </div>
        ) : null}
        {path === "busy" ? (
          <Alert variant="info">
            <Info />
            <AlertDescription>{t("edition.switch.busy")}</AlertDescription>
          </Alert>
        ) : null}
        {path === "manual" ? (
          <div className="space-y-3" data-slot="edition-manual">
            <p className="text-sm text-muted-foreground">{t("edition.switch.manual")}</p>
            {lines ? (
              <CommandList commands={lines} copyLabel={t("commands.copy")} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("edition.switch.manualUnknown")}</p>
            )}
            <CommandList
              commands={["docker compose pull && docker compose up -d"]}
              copyLabel={t("commands.copy")}
            />
            {view.updater.state === "unavailable" && !view.demo ? (
              <p className="text-sm text-muted-foreground" data-slot="edition-enable-updater">
                {t("edition.switch.enableUpdater", { command: ENABLE_UPDATER_COMMAND })}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{t("edition.switch.oneWay")}</p>
      </CardContent>
      {path === "updater" ? <SwitchDialog view={view} open={open} onOpenChange={setOpen} /> : null}
    </Card>
  );
}

function SwitchDialog({
  view,
  open,
  onOpenChange,
}: {
  view: UpdatesView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("updates");
  const { t: tc } = useTranslation();
  const mutation = useSwitchToFullBuild();
  const identity = useConfirmIdentity();
  const leadTimes = offeredLeadTimes(view);
  const defaultLead = leadTimes.includes(DEFAULT_LEAD_SECONDS)
    ? DEFAULT_LEAD_SECONDS
    : (leadTimes[0] ?? 0);
  const [lead, setLead] = React.useState(defaultLead);

  const announce = (leadSeconds: number) => {
    mutation.mutate(
      { leadSeconds },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(t("edition.switch.announced"));
        },
        onError: (error) => {
          // Like an update, the switch needs a recent sign-in; then the same choice is sent again.
          if (isRecentSignInRequired(error)) {
            identity.ask(() => announce(leadSeconds));
          }
        },
      },
    );
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && mutation.isPending) {
          return;
        }
        onOpenChange(next);
      }}
    >
      <AlertDialogContent className="max-h-[92svh] grid-rows-[auto_minmax(0,1fr)_auto]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("edition.dialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("edition.dialog.description", { version: view.running ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="-mx-1 min-h-0 space-y-5 overflow-y-auto px-1 pb-1">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm leading-none font-medium">{t("install.lead")}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {leadTimes.map((seconds) => {
                const label = leadTimeLabel(seconds);
                return (
                  <ChoiceOption
                    key={seconds}
                    name="switch-lead"
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
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t("edition.dialog.verify")}</li>
            <li>{t("install.effects.backup")}</li>
            <li>{t("install.effects.rollback")}</li>
            <li>{t("edition.dialog.updater")}</li>
            <li>{t("edition.dialog.oneWay")}</li>
          </ul>
          {mutation.isError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t(updatesErrorKey(mutation.error))}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>
            {tc("actions.cancel")}
          </AlertDialogCancel>
          <Button
            type="button"
            loading={mutation.isPending}
            onClick={() => {
              if (!mutation.isPending) {
                announce(lead);
              }
            }}
          >
            {lead === 0 ? t("edition.dialog.confirmNow") : t("edition.dialog.confirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
      {identity.dialog}
    </AlertDialog>
  );
}

function LicenseKeyCard({ view, canChange }: { view: UpdatesView; canChange: boolean }) {
  const { t } = useTranslation("updates");
  const store = useStorePendingLicenseKey();
  const remove = useRemovePendingLicenseKey();
  const [key, setKey] = React.useState("");
  const pending = view.edition?.pendingLicenseKey === true;
  const fieldId = React.useId();

  return (
    <Card data-slot="edition-license-key">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden="true" />
          {t("edition.key.title")}
        </CardTitle>
        <CardDescription>{t("edition.key.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pending ? (
          <Alert variant="info" data-slot="edition-key-stored">
            <Info />
            <AlertTitle>{t("edition.key.storedTitle")}</AlertTitle>
            <AlertDescription>{t("edition.key.stored")}</AlertDescription>
          </Alert>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim() === "" || store.isPending) {
              return;
            }
            store.mutate(key, {
              onSuccess: () => {
                setKey("");
                toast.success(t("edition.key.saved"));
              },
            });
          }}
        >
          <Label htmlFor={fieldId}>
            {pending ? t("edition.key.replace") : t("edition.key.label")}
          </Label>
          <Textarea
            id={fieldId}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-xs"
            disabled={!canChange}
          />
          {store.isError ? (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{t(updatesErrorKey(store.error))}</AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              loading={store.isPending}
              disabled={!canChange || key.trim() === ""}
            >
              {t("edition.key.save")}
            </Button>
            {pending ? (
              <Button
                type="button"
                variant="outline"
                loading={remove.isPending}
                disabled={!canChange}
                onClick={() => remove.mutate()}
              >
                {t("edition.key.remove")}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
