import * as React from "react";
import { useTranslation } from "react-i18next";

import { Field, messageId } from "@/components/forms/field";
import { PasswordInput } from "@/components/forms/password-input";
import { CopyButton } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { isGuid } from "../forms";
import { OWN_APP_PERMISSIONS, ownAppTokenHint } from "../own-app-permissions";
import { sourceErrorKey } from "../presenters";
import type { SourceDto } from "../types";
import { useConnectOwnApp } from "../use-sources";

type CredentialKind = "secret" | "certificate";

interface OwnAppFormProps {
  source: SourceDto;
  /** Called after the app connected the tenant. */
  onConnected: () => void;
  onCancel?: () => void;
}

/**
 * Connect a source through a Graph app the customer created by hand in their own
 * tenant: no consent link, no shared app. The credential goes to the server once and
 * is sealed there; the page never gets it back.
 */
export function OwnAppForm({ source, onConnected, onCancel }: OwnAppFormProps) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const connect = useConnectOwnApp(source.id);
  const m365 = source.m365;
  const knownTenant = m365?.entraTenantId ?? "";
  const hint = (m365?.entraTenantHint ?? "").trim();
  const [tenantId, setTenantId] = React.useState(knownTenant || (isGuid(hint) ? hint : ""));
  const [clientId, setClientId] = React.useState(m365?.ownApp?.clientId ?? "");
  const [kind, setKind] = React.useState<CredentialKind>(m365?.ownApp?.credentialKind ?? "secret");
  const [secret, setSecret] = React.useState("");
  const [pem, setPem] = React.useState("");
  const [invalid, setInvalid] = React.useState<"tenantId" | "clientId" | "credential" | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!isGuid(tenantId.trim())) {
      return setInvalid("tenantId");
    }
    if (!isGuid(clientId.trim())) {
      return setInvalid("clientId");
    }
    if ((kind === "secret" ? secret : pem).trim().length === 0) {
      return setInvalid("credential");
    }
    setInvalid(null);
    connect.mutate(
      {
        tenantId: tenantId.trim(),
        clientId: clientId.trim(),
        credentialKind: kind,
        ...(kind === "secret" ? { clientSecret: secret } : { certificatePem: pem }),
      },
      {
        onSuccess: () => {
          setSecret("");
          setPem("");
          toast.success(t("toasts.ownAppConnected"));
          onConnected();
        },
      },
    );
  };

  const problem = connect.error instanceof ApiError ? connect.error.problem : null;
  const detail = problem?.detail ?? null;
  const tokenHint = ownAppTokenHint(problem?.hint);
  const permissionList = OWN_APP_PERMISSIONS.map((entry) => entry.permission).join("\n");

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <p className="text-sm text-muted-foreground">{t("m365.ownApp.description")}</p>
      <ol className="list-decimal space-y-1 pl-5 text-sm">
        {(["one", "two", "three", "four"] as const).map((step) => (
          <li key={step}>{t(`m365.ownApp.steps.${step}`)}</li>
        ))}
      </ol>
      <Alert>
        <AlertDescription>{t("m365.ownApp.noRedirect")}</AlertDescription>
      </Alert>

      <section aria-labelledby="own-app-permissions" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 id="own-app-permissions" className="text-sm font-medium">
            {t("m365.ownApp.permissionsTitle")}
          </h3>
          <CopyButton
            value={permissionList}
            label={t("m365.ownApp.copyPermissions")}
            onCopied={() => toast.success(t("m365.ownApp.permissionsCopied"))}
          />
        </div>
        <ul className="divide-y rounded-md border text-sm">
          {OWN_APP_PERMISSIONS.map((entry) => (
            <li
              key={entry.permission}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2"
            >
              <span className="font-mono">{entry.permission}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {t(`m365.permissions.purpose.${entry.purpose}`)}
                <Badge variant={entry.required ? "secondary" : "outline"}>
                  {entry.required ? t("m365.permissions.required") : t("m365.permissions.optional")}
                </Badge>
                <CopyButton
                  value={entry.permission}
                  label={t("m365.ownApp.copyPermission", { permission: entry.permission })}
                />
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">{t("m365.ownApp.permissionsReadWrite")}</p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="own-app-tenant"
          label={t("m365.ownApp.tenantId")}
          hint={t("m365.ownApp.tenantIdHint")}
          error={invalid === "tenantId" ? t("m365.ownApp.invalidGuid") : undefined}
        >
          <Input
            id="own-app-tenant"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={tenantId}
            readOnly={knownTenant.length > 0}
            aria-invalid={invalid === "tenantId"}
            aria-describedby={messageId("own-app-tenant")}
            onChange={(event) => setTenantId(event.target.value)}
          />
        </Field>
        <Field
          id="own-app-client"
          label={t("m365.ownApp.clientId")}
          hint={t("m365.ownApp.clientIdHint")}
          error={invalid === "clientId" ? t("m365.ownApp.invalidGuid") : undefined}
        >
          <Input
            id="own-app-client"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            value={clientId}
            aria-invalid={invalid === "clientId"}
            aria-describedby={messageId("own-app-client")}
            onChange={(event) => setClientId(event.target.value)}
          />
        </Field>
      </div>

      <div className="space-y-1.5">
        <fieldset className="flex gap-2 min-w-0 border-0 p-0">
          <legend className="sr-only">{t("m365.ownApp.credentialKind")}</legend>
          {(["secret", "certificate"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={kind === option ? "default" : "outline"}
              aria-pressed={kind === option}
              onClick={() => setKind(option)}
            >
              {t(`m365.ownApp.kinds.${option}`)}
            </Button>
          ))}
        </fieldset>
        {kind === "secret" ? (
          <Field
            id="own-app-secret"
            label={t("m365.ownApp.clientSecret")}
            hint={m365?.ownApp ? t("m365.ownApp.replaceHint") : t("m365.ownApp.secretHint")}
            error={invalid === "credential" ? t("m365.ownApp.credentialRequired") : undefined}
          >
            <PasswordInput
              id="own-app-secret"
              autoComplete="off"
              value={secret}
              aria-invalid={invalid === "credential"}
              aria-describedby={messageId("own-app-secret")}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        ) : (
          <Field
            id="own-app-pem"
            label={t("m365.ownApp.certificate")}
            hint={t("m365.ownApp.certificateHint")}
            error={invalid === "credential" ? t("m365.ownApp.credentialRequired") : undefined}
          >
            <Textarea
              id="own-app-pem"
              autoComplete="off"
              spellCheck={false}
              rows={6}
              className={cn("font-mono text-xs")}
              value={pem}
              aria-invalid={invalid === "credential"}
              aria-describedby={messageId("own-app-pem")}
              onChange={(event) => setPem(event.target.value)}
            />
          </Field>
        )}
      </div>

      {connect.error ? (
        <div role="alert" className="space-y-1 text-sm text-destructive">
          <p>{tc(sourceErrorKey(connect.error))}</p>
          {tokenHint ? <p>{t(`m365.ownApp.hints.${tokenHint}`)}</p> : null}
          {detail ? <p className="break-words font-mono text-xs">{detail}</p> : null}
        </div>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" loading={connect.isPending}>
          {m365?.ownApp ? t("actions.replaceOwnApp") : t("actions.connectOwnApp")}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            {tc("actions.cancel")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
