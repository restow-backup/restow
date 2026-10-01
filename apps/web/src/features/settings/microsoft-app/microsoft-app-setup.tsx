import { Link } from "@tanstack/react-router";
import { Info, Server, Settings as SettingsIcon, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import "@/features/settings/i18n";
import { ConfirmDialog, ErrorState, RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { settingsTo } from "../paths";
import { sectionSearch } from "../presenters";
import type { MicrosoftAppView } from "./api";
import { EnterStep } from "./app-form";
import { TestPanel } from "./app-test";
import { ExpiryBadge, type SetupVariant } from "./components";
import { useMicrosoftApp, useRemoveMicrosoftApp } from "./hooks";
import { expiryState, microsoftAppErrorKey, registrationStatus } from "./presenters";
import { CredentialsStep, PermissionsStep, RegisterStep } from "./setup-steps";

/**
 * The guided setup of the Microsoft 365 app registration (docs/ENTRA-SETUP.md,
 * part 1 to 3 and 6), for provider admins: where the registration stands,
 * four steps from registering the app in Entra to entering it here, and a
 * connection test. Shown as a settings section and, inline, on a Microsoft
 * 365 source that cannot be connected yet.
 */

export interface MicrosoftAppSetupProps {
  variant?: SetupVariant;
}

/** Loads the registration and renders the guide, with honest loading and error states. */
export function MicrosoftAppSetup({ variant = "page" }: MicrosoftAppSetupProps) {
  const { t } = useTranslation("settings");
  const query = useMicrosoftApp();
  if (query.isPending) {
    return <MicrosoftAppSkeleton />;
  }
  if (query.isError) {
    return (
      <ErrorState
        title={t("microsoftApp.loadError")}
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  return <MicrosoftAppGuide view={query.data} variant={variant} />;
}

export function MicrosoftAppGuide({
  view,
  variant = "page",
}: {
  view: MicrosoftAppView;
  variant?: SetupVariant;
}) {
  const { t } = useTranslation("settings");
  const [unsaved, setUnsaved] = React.useState(false);
  return (
    <div className="space-y-6">
      {variant === "inline" ? <InlineIntro /> : null}
      <StatusCard view={view} variant={variant} />
      <ol aria-label={t("microsoftApp.steps.label")} className="space-y-6">
        <li>
          <RegisterStep view={view} variant={variant} />
        </li>
        <li>
          <PermissionsStep view={view} variant={variant} />
        </li>
        <li>
          <CredentialsStep variant={variant} />
        </li>
        <li>
          <EnterStep view={view} variant={variant} onDirtyChange={setUnsaved} />
        </li>
      </ol>
      <TestPanel view={view} variant={variant} unsaved={unsaved} />
      {variant === "page" && view.source === "database" ? <RemoveCard /> : null}
    </div>
  );
}

function InlineIntro() {
  const { t } = useTranslation("settings");
  return (
    <Alert variant="info">
      <Info />
      <AlertTitle>{t("microsoftApp.inline.title")}</AlertTitle>
      <AlertDescription className="gap-3">
        <p>{t("microsoftApp.inline.description")}</p>
        <Link
          to={settingsTo()}
          search={sectionSearch("microsoft365") as never}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "w-fit")}
        >
          <SettingsIcon aria-hidden="true" />
          {t("microsoftApp.inline.openSettings")}
        </Link>
      </AlertDescription>
    </Alert>
  );
}

function StatusCard({ view, variant }: { view: MicrosoftAppView; variant: SetupVariant }) {
  const { t } = useTranslation("settings");
  const status = registrationStatus(view);
  const expiry = expiryState(view.credential.expiresAt);
  const credentialKind = view.credential.kind;

  const content = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge tone={status.tone} icon>
          {t(`microsoftApp.status.badge.${status.key}`)}
        </StatusBadge>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          {view.source === "environment" ? <Server aria-hidden="true" className="size-4" /> : null}
          {t(`microsoftApp.status.source.${view.source}`)}
        </span>
      </div>

      {view.problem ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(`microsoftApp.status.problems.${view.problem}`)}</AlertDescription>
        </Alert>
      ) : null}
      {view.source === "environment" ? (
        <Alert variant="info">
          <Server />
          <AlertDescription>{t("microsoftApp.status.environmentNote")}</AlertDescription>
        </Alert>
      ) : null}
      {view.environmentPartial ? (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>{t("microsoftApp.status.environmentPartial")}</AlertDescription>
        </Alert>
      ) : null}

      {/* A registration that cannot be opened has no facts worth showing. */}
      {view.source !== "none" && (view.problem === null || view.clientId !== null) ? (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <Fact label={t("microsoftApp.status.clientId")}>
            <Identifier value={view.clientId} />
          </Fact>
          <Fact label={t("microsoftApp.status.tenantId")}>
            <Identifier value={view.homeTenantId} />
          </Fact>
          <Fact label={t("microsoftApp.status.credential")}>
            {credentialKind ? (
              t(`microsoftApp.status.kinds.${credentialKind}`)
            ) : (
              <span className="text-destructive-text">
                {t("microsoftApp.status.badge.unusable")}
              </span>
            )}
          </Fact>
          <Fact label={t("microsoftApp.status.expires")}>
            <ExpiryBadge expiresAt={view.credential.expiresAt} />
          </Fact>
          {view.credential.certificate ? (
            <Fact label={t("microsoftApp.status.thumbprint")} className="sm:col-span-2">
              <span className="break-all font-mono text-xs">
                {view.credential.certificate.thumbprint}
              </span>
            </Fact>
          ) : null}
          {view.authorityHost ? (
            <Fact label={t("microsoftApp.status.authorityHost")}>
              <span className="font-mono text-xs">{view.authorityHost}</span>
            </Fact>
          ) : null}
          {view.updatedAt ? (
            <Fact label={t("microsoftApp.status.updated")}>
              <RelativeTime value={view.updatedAt} />
              {view.updatedBy ? (
                <span className="text-muted-foreground">
                  {" "}
                  {t("microsoftApp.status.updatedBy", { who: view.updatedBy })}
                </span>
              ) : null}
            </Fact>
          ) : null}
        </dl>
      ) : null}

      {expiry.kind === "expired" || expiry.kind === "soon" ? (
        <Alert variant={expiry.kind === "expired" ? "destructive" : "warning"}>
          <TriangleAlert />
          <AlertDescription>{t("microsoftApp.expiry.warning")}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );

  if (variant === "inline") {
    return content;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("microsoftApp.title")}</CardTitle>
        <CardDescription>{t("microsoftApp.description")}</CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}

/** An id in monospace, or a plain "Not set". */
function Identifier({ value }: { value: string | null }) {
  const { t } = useTranslation("settings");
  return value ? (
    <span className="break-all font-mono text-xs">{value}</span>
  ) : (
    <span className="text-muted-foreground">{t("microsoftApp.status.notSet")}</span>
  );
}

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 space-y-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function RemoveCard() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const remove = useRemoveMicrosoftApp();

  // A rejection keeps the dialog open with the cause; success closes it.
  const confirm = async () => {
    await remove.mutateAsync();
    toast.success(t("microsoftApp.toasts.removed"));
  };

  return (
    <Card className="border-destructive/50">
      <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("microsoftApp.remove.title")}</p>
          <p className="text-sm text-muted-foreground">{t("microsoftApp.remove.description")}</p>
        </div>
        <ConfirmDialog
          trigger={
            <Button variant="destructive" className="shrink-0" onClick={() => remove.reset()}>
              {t("microsoftApp.remove.action")}
            </Button>
          }
          title={t("microsoftApp.remove.confirmTitle")}
          description={t("microsoftApp.remove.confirmDescription")}
          confirmLabel={t("microsoftApp.remove.confirm")}
          destructive
          error={remove.isError ? tc(microsoftAppErrorKey(remove.error)) : undefined}
          onConfirm={confirm}
        />
      </CardContent>
    </Card>
  );
}

function MicrosoftAppSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true">
      {[0, 1, 2].map((index) => (
        <Card key={index}>
          <CardHeader>
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-4 w-2/3" />
          </CardHeader>
          <CardContent className="space-y-3">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-9 w-1/2" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
