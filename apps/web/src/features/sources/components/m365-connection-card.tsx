import { CircleCheck, ExternalLink, Info, Link2, RefreshCw, TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/error-state";
import { Field, messageId } from "@/components/forms/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatRelative } from "@/lib/format";
import { useSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { isValidTenantHint } from "../forms";
import { consentErrorMessage, isCurrentConsentError, sourceErrorKey } from "../presenters";
import type { ConsentLinkDto, SourceDto } from "../types";
import { useConnectOwnTenant, useConsentLink, useEntraStatus } from "../use-sources";
import { CopyField } from "./copy-field";
import { DetailsItem, DetailsList } from "./details-list";
import { EntraNotConfigured } from "./entra-not-configured";

/** A consent link together with the source state it was issued against. */
interface IssuedLink {
  link: ConsentLinkDto;
  grantedAt: string | null;
  errorAt: string | null;
}

/** The current time, re-read every `intervalMs` while an interval is given. */
function useNow(intervalMs: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (intervalMs === null) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

interface M365ConnectionCardProps {
  source: SourceDto;
  /** Tells the page to poll while an issued link waits for the consent outcome. */
  onWaitingChange: (waiting: boolean) => void;
}

/**
 * Admin consent for a Microsoft 365 source: create the signed link, hand it
 * to the customer's Global Admin, and wait (polling) until the callback
 * recorded a result — the connection, or an honest reason why not.
 */
export function M365ConnectionCard({ source, onWaitingChange }: M365ConnectionCardProps) {
  const { t, i18n } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const m365 = source.m365;
  const connected = Boolean(m365?.entraTenantId);
  const grantedAt = m365?.consentGrantedAt ?? null;
  const consentError = m365?.consentError ?? null;

  const entra = useEntraStatus(true);
  const consentLink = useConsentLink(source.id);
  const ownTenant = useConnectOwnTenant(source.id);
  const { isProviderAdmin } = useSession();
  const [issued, setIssued] = React.useState<IssuedLink | null>(null);
  const [reconsent, setReconsent] = React.useState(false);
  const [tenantHint, setTenantHint] = React.useState(m365?.entraTenantHint ?? "");
  const [hintInvalid, setHintInvalid] = React.useState(false);

  const now = useNow(issued ? 15_000 : null);
  const expired = issued !== null && Date.parse(issued.link.expiresAt) <= now;
  const newConsent = issued !== null && grantedAt !== issued.grantedAt;
  const newError = issued !== null && (consentError?.at ?? null) !== issued.errorAt;
  const waiting = issued !== null && !expired && !newConsent && !newError;

  React.useEffect(() => onWaitingChange(waiting), [waiting, onWaitingChange]);

  // The consent came back: the link has done its job.
  React.useEffect(() => {
    if (newConsent) {
      toast.success(t("m365.consentResult.granted"));
      setIssued(null);
      setReconsent(false);
    }
  }, [newConsent, t]);

  const createLink = () => {
    let tenant: string | null | undefined;
    if (!connected) {
      const hint = tenantHint.trim();
      if (!isValidTenantHint(hint)) {
        setHintInvalid(true);
        return;
      }
      tenant = hint.length > 0 ? hint : null;
    }
    setHintInvalid(false);
    consentLink.mutate(tenant, {
      onSuccess: (link) => {
        setIssued({ link, grantedAt, errorAt: consentError?.at ?? null });
        toast.success(t("toasts.linkCreated"));
      },
    });
  };

  const shownError = isCurrentConsentError(consentError, grantedAt) ? consentError : null;
  const errorMessage = shownError ? consentErrorMessage(shownError) : null;
  const canCreateLink = entra.data?.configured === true;
  // The app lives in this tenant already: nothing to consent to, a working token is the proof.
  const homeTenantId = entra.data?.homeTenantId?.toLowerCase() ?? null;
  const hint = tenantHint.trim().toLowerCase();
  const canConnectOwnTenant =
    isProviderAdmin &&
    !connected &&
    homeTenantId !== null &&
    (hint === "" || hint === homeTenantId);
  const connectOwn = () =>
    ownTenant.mutate(undefined, {
      onSuccess: () => toast.success(t("toasts.ownTenantConnected")),
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("m365.connection.title")}</CardTitle>
        <CardDescription>{t("m365.connection.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {connected ? (
          <DetailsList>
            <DetailsItem label={t("m365.connect.tenantId")}>
              <span className="font-mono text-xs">{m365?.entraTenantId}</span>
            </DetailsItem>
            <DetailsItem label={t("m365.connect.consent")}>
              <span className="inline-flex items-center gap-1.5">
                <CircleCheck aria-hidden="true" className="size-4" />
                <span title={formatDateTime(grantedAt, language) ?? undefined}>
                  {t("m365.connect.consented", { when: formatRelative(grantedAt, language) ?? "" })}
                </span>
              </span>
            </DetailsItem>
          </DetailsList>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">{t("m365.connect.description")}</p>
              <ol className="space-y-1.5 text-sm">
                {(["one", "two", "three"] as const).map((step, index) => (
                  <li key={step} className="flex gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium tabular-nums text-muted-foreground">
                      {index + 1}
                    </span>
                    <span>{t(`m365.connect.steps.${step}`)}</span>
                  </li>
                ))}
              </ol>
            </div>

            <Alert variant="info">
              <Info />
              <AlertTitle>{t("m365.connect.consentExplainer.title")}</AlertTitle>
              <AlertDescription className="space-y-1.5">
                <p>{t("m365.connect.consentExplainer.sharedApp")}</p>
                <p>{t("m365.connect.consentExplainer.secondSignIn")}</p>
                <p>{t("m365.connect.consentExplainer.portalConsent")}</p>
              </AlertDescription>
            </Alert>
          </div>
        )}

        {shownError && errorMessage ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{t("m365.consentError.title")}</AlertTitle>
            <AlertDescription className="space-y-1">
              <p>{t(errorMessage.key, errorMessage.values)}</p>
              {shownError.description ? (
                <p className="break-words font-mono text-xs text-muted-foreground">
                  {t("m365.consentError.details", { description: shownError.description })}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("m365.consentError.at", {
                  when: formatDateTime(shownError.at, language) ?? shownError.at,
                })}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {entra.isPending ? (
          <Skeleton className="h-9 w-48" />
        ) : entra.isError ? (
          <ErrorState
            error={entra.error}
            onRetry={() => void entra.refetch()}
            retrying={entra.isFetching}
          />
        ) : !canCreateLink && entra.data ? (
          <EntraNotConfigured status={entra.data} />
        ) : connected && !reconsent ? (
          <Button variant="outline" size="sm" onClick={() => setReconsent(true)}>
            <RefreshCw />
            {t("actions.reconnect")}
          </Button>
        ) : (
          <div className="space-y-3">
            {connected ? (
              <p className="text-sm text-muted-foreground">{t("m365.connect.reconsentHint")}</p>
            ) : (
              <Field
                id="consent-tenant"
                label={t("form.m365.tenantHint")}
                hint={t("form.m365.tenantHintHelp")}
                error={hintInvalid ? tc("sources:validation.tenantHint") : undefined}
                className="max-w-md"
              >
                <Input
                  id="consent-tenant"
                  autoComplete="off"
                  spellCheck={false}
                  value={tenantHint}
                  placeholder={t("form.m365.tenantHintPlaceholder")}
                  aria-invalid={hintInvalid}
                  aria-describedby={messageId("consent-tenant")}
                  onChange={(event) => {
                    setTenantHint(event.target.value);
                    setHintInvalid(false);
                  }}
                />
              </Field>
            )}
            {canConnectOwnTenant ? (
              <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-3">
                <p className="text-sm">{t("m365.connect.ownTenant.hint")}</p>
                <Button onClick={connectOwn} loading={ownTenant.isPending}>
                  {t("actions.connectOwnTenant")}
                </Button>
                {ownTenant.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {tc(sourceErrorKey(ownTenant.error))}
                  </p>
                ) : null}
              </div>
            ) : null}
            <Button
              variant={canConnectOwnTenant ? "outline" : "default"}
              onClick={createLink}
              loading={consentLink.isPending}
            >
              {consentLink.isPending ? null : <Link2 />}
              {issued ? t("actions.reconnect") : t("actions.createLink")}
            </Button>
            {consentLink.error ? (
              <p role="alert" className="text-sm text-destructive">
                {tc(sourceErrorKey(consentLink.error))}
              </p>
            ) : null}
          </div>
        )}

        {issued ? (
          <IssuedLinkPanel issued={issued.link} expired={expired} waiting={waiting} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function IssuedLinkPanel({
  issued,
  expired,
  waiting,
}: {
  issued: ConsentLinkDto;
  expired: boolean;
  waiting: boolean;
}) {
  const { t, i18n } = useTranslation("sources");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="consent-link">{t("m365.connect.linkLabel")}</Label>
        <CopyField id="consent-link" value={issued.url} label={t("m365.connect.linkLabel")} />
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {issued.tenant
              ? t("m365.connect.audience", { tenant: issued.tenant })
              : t("m365.connect.audienceAny")}
          </span>
          <span className={cn(expired && "font-medium text-destructive")}>
            {expired
              ? t("m365.connect.linkExpired")
              : t("m365.connect.linkExpires", {
                  when: formatDateTime(issued.expiresAt, language) ?? issued.expiresAt,
                })}
          </span>
        </div>
      </div>

      {expired ? null : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <a
            href={issued.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ size: "sm" }), "w-fit")}
          >
            <ExternalLink />
            {t("actions.openConsent")}
          </a>
          {waiting ? <Spinner label={t("m365.connect.waiting")} /> : null}
        </div>
      )}

      <div className="space-y-1.5 border-t border-border pt-3">
        <Label htmlFor="consent-redirect" className="text-xs text-muted-foreground">
          {t("m365.connect.redirectUri")}
        </Label>
        <CopyField
          id="consent-redirect"
          value={issued.redirectUri}
          label={t("m365.connect.redirectUri")}
        />
        <p className="text-xs text-muted-foreground">{t("m365.connect.redirectHint")}</p>
      </div>
    </div>
  );
}
