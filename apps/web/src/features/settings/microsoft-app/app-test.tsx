import {
  CircleCheck,
  CircleMinus,
  CircleX,
  KeyRound,
  PlugZap,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { RelativeTime, StatusBadge, type StatusTone } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { problemFieldIssues } from "../forms";
import type { AppTestResult, MicrosoftAppView, PermissionCheck } from "./api";
import type { SetupVariant } from "./components";
import { isTenantReference } from "./forms";
import { useTestMicrosoftApp } from "./hooks";
import { fieldReasonKey, microsoftAppErrorKey, testReasonKey } from "./presenters";

/**
 * "Test connection": a Graph token as the app in the admin's own directory,
 * and the granted application permissions against the ones Restow needs. The
 * outcome is a green or red checklist with Entra's refusal explained in the
 * operator's language (the AADSTS code stays visible for support).
 */

interface TestPanelProps {
  view: MicrosoftAppView;
  variant: SetupVariant;
  /** The form above holds unsaved changes; the test still uses the saved values. */
  unsaved: boolean;
}

export function TestPanel({ view, variant, unsaved }: TestPanelProps) {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation();
  const test = useTestMicrosoftApp();
  const inputId = `${variant}-msapp-test-tenant`;
  const [tenant, setTenant] = React.useState(view.homeTenantId ?? view.lastTest?.tenantId ?? "");
  const [tenantError, setTenantError] = React.useState<string | null>(null);
  const available = view.source !== "none" && view.problem === null;
  const result = test.data ?? view.lastTest;

  // A saved home tenant becomes the default as long as nothing else was typed.
  const homeTenant = view.homeTenantId;
  React.useEffect(() => {
    if (homeTenant) {
      setTenant((current) => (current.length === 0 ? homeTenant : current));
    }
  }, [homeTenant]);

  const run = () => {
    const value = tenant.trim();
    if (value.length > 0 && !isTenantReference(value)) {
      setTenantError("tenantId");
      return;
    }
    setTenantError(null);
    test.mutate(value.length > 0 ? value : null, {
      onError: (error) => {
        const issue = problemFieldIssues(error).find((entry) => entry.field === "tenantId");
        if (issue) {
          setTenantError(issue.reason);
        }
      },
    });
  };

  const requestError = test.error && !tenantError ? test.error : null;
  const tenantMessage = fieldReasonKey(tenantError ?? undefined);

  const body = (
    <div className="space-y-4">
      {!available ? (
        <p className="text-sm text-muted-foreground">{t("microsoftApp.test.needsSave")}</p>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <Field
              id={inputId}
              label={t("microsoftApp.test.tenantId")}
              error={tenantMessage ? tc(tenantMessage) : undefined}
              className="flex-1 sm:max-w-md"
            >
              <Input
                id={inputId}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                value={tenant}
                placeholder={t("microsoftApp.form.tenantIdPlaceholder")}
                aria-invalid={tenantError !== null}
                aria-describedby={messageId(inputId)}
                onChange={(event) => {
                  setTenant(event.target.value);
                  setTenantError(null);
                }}
              />
            </Field>
            <Button className="sm:mt-6" onClick={run} loading={test.isPending}>
              <PlugZap />
              {t("microsoftApp.test.run")}
            </Button>
          </div>
          {unsaved ? (
            <p className="text-xs text-muted-foreground">{t("microsoftApp.test.unsaved")}</p>
          ) : null}
        </>
      )}

      {requestError ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{tc(microsoftAppErrorKey(requestError))}</AlertDescription>
        </Alert>
      ) : null}

      {available && result ? <TestOutcome result={result} /> : null}
    </div>
  );

  if (variant === "inline") {
    return (
      <section className="space-y-4 rounded-lg border border-border p-4">
        <div className="space-y-1.5">
          <h4 className="text-sm font-semibold">{t("microsoftApp.test.title")}</h4>
          <p className="text-sm text-muted-foreground">{t("microsoftApp.test.description")}</p>
        </div>
        {body}
      </section>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("microsoftApp.test.title")}</CardTitle>
        <CardDescription>{t("microsoftApp.test.description")}</CardDescription>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/** The last result: a verdict, Entra's reason when it refused, and the permission checklist. */
export function TestOutcome({ result }: { result: AppTestResult }) {
  const { t } = useTranslation("settings");
  const permissions = result.permissions;

  return (
    <div className="space-y-4" aria-live="polite">
      {result.ok ? (
        <Alert variant="info">
          <CircleCheck />
          <AlertTitle>{t("microsoftApp.test.success")}</AlertTitle>
          <AlertDescription>
            {t("microsoftApp.test.tokenOk", { tenant: result.tenantId })}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          {result.tokenAcquired ? <ShieldAlert /> : <KeyRound />}
          <AlertTitle>{t("microsoftApp.test.failed")}</AlertTitle>
          <AlertDescription className="gap-2">
            {result.reason ? <p>{t(testReasonKey(result.reason))}</p> : null}
            {result.aadsts ? (
              <p className="font-mono text-xs text-muted-foreground">
                {t("microsoftApp.test.code", { code: result.aadsts })}
              </p>
            ) : null}
            {result.detail ? (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{t("microsoftApp.test.details")}</p>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {result.detail}
                </pre>
              </div>
            ) : null}
            {result.tokenAcquired ? (
              <p className="text-xs text-muted-foreground">
                {t("microsoftApp.test.tokenOk", { tenant: result.tenantId })}
              </p>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      {permissions ? (
        <div className="space-y-3">
          {permissions.missing.length > 0 ? (
            <p className="text-sm font-medium text-destructive-text">
              {t("microsoftApp.test.missing", { count: permissions.missing.length })}
            </p>
          ) : null}
          <ul className="grid gap-2 sm:grid-cols-2">
            {permissions.checks.map((check) => (
              <PermissionLine key={check.permission} check={check} />
            ))}
          </ul>
          {permissions.unexpected.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("microsoftApp.test.unexpected", { list: permissions.unexpected.join(", ") })}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">
        {t("microsoftApp.test.checkedAt")} <RelativeTime value={result.checkedAt} />
      </p>
    </div>
  );
}

function PermissionLine({ check }: { check: PermissionCheck }) {
  const { t } = useTranslation("settings");
  const optionalGap = !check.required && check.state !== "granted";
  const Icon =
    check.state === "granted"
      ? CircleCheck
      : optionalGap
        ? CircleMinus
        : check.state === "read_only"
          ? ShieldAlert
          : CircleX;
  const tone: StatusTone =
    check.state === "granted" ? "neutral" : optionalGap ? "muted" : "destructive";
  const iconClass =
    tone === "neutral"
      ? "text-foreground"
      : tone === "muted"
        ? "text-muted-foreground"
        : "text-destructive-text";
  return (
    <li className="flex items-start gap-2 rounded-md border border-border px-3 py-2">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-xs font-medium">{check.permission}</span>
          <StatusBadge tone={tone}>{t(`microsoftApp.test.states.${check.state}`)}</StatusBadge>
        </div>
        {check.state === "read_only" && check.grantedInstead ? (
          <p className="text-xs text-destructive-text">
            {t("microsoftApp.test.readOnly", {
              granted: check.grantedInstead,
              expected: check.permission,
            })}
          </p>
        ) : null}
      </div>
    </li>
  );
}
