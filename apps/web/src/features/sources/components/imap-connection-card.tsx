import { Lock, LockOpen, Pencil, PlugZap, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { sourceErrorKey } from "../presenters";
import type { SourceDto } from "../types";
import { DetailsItem, DetailsList } from "./details-list";
import { ProbeResult } from "./probe-result";

interface ImapConnectionCardProps {
  source: SourceDto;
  onEdit: () => void;
  onTest: () => void;
  testing: boolean;
  testError: unknown;
}

/** Stored IMAP connection and the result of its last test. */
export function ImapConnectionCard({
  source,
  onEdit,
  onTest,
  testing,
  testError,
}: ImapConnectionCardProps) {
  const { t } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const imap = source.imap;
  if (!imap) {
    return null;
  }
  const encrypted = imap.security !== "none";

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("imap.connection.title")}</CardTitle>
            <CardDescription>{t("imap.connection.description")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onEdit} className="shrink-0">
            <Pencil />
            {t("actions.editConnection")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <DetailsList>
            <DetailsItem label={t("imap.server")}>
              <span className="font-mono text-xs">
                {imap.host}:{imap.port}
              </span>
            </DetailsItem>
            <DetailsItem label={t("imap.security")}>
              <Badge variant={encrypted ? "outline" : "warning"}>
                {encrypted ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
                {t(`form.imap.securityOptions.${imap.security}`)}
              </Badge>
            </DetailsItem>
            <DetailsItem label={t("imap.username")}>
              <span className="font-mono text-xs">{imap.username}</span>
            </DetailsItem>
            <DetailsItem label={t("form.imap.authMode.label")}>
              {t(`form.imap.authMode.options.${imap.imapAuthMode}`)}
            </DetailsItem>
            {imap.imapAuthMode === "master_user" && imap.masterUser ? (
              <DetailsItem label={t("form.imap.authMode.masterUsername")}>
                <span className="font-mono text-xs">{imap.masterUser.username}</span>
              </DetailsItem>
            ) : null}
            {imap.imapAuthMode === "per_mailbox" ? (
              <DetailsItem label={t("imap.password")}>{t("imap.passwordPerMailbox")}</DetailsItem>
            ) : (
              <DetailsItem label={t("imap.password")}>
                {imap.hasPassword ? t("imap.passwordStored") : t("imap.passwordMissing")}
              </DetailsItem>
            )}
          </DetailsList>
          {encrypted ? null : (
            <Alert variant="warning">
              <TriangleAlert />
              <AlertDescription>{t("form.imap.securityNoneWarning")}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <CardTitle className="text-base">{t("imap.probe.title")}</CardTitle>
          {imap.imapAuthMode !== "per_mailbox" ? (
            <Button
              variant={imap.lastProbe?.ok ? "outline" : "default"}
              size="sm"
              onClick={onTest}
              loading={testing}
              disabled={!imap.hasPassword}
              className="shrink-0"
            >
              {testing ? null : <PlugZap />}
              {t("actions.test")}
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3">
          {imap.imapAuthMode === "per_mailbox" ? (
            <p className="text-sm text-muted-foreground">
              {t("form.imap.authMode.perMailboxTestHint")}
            </p>
          ) : testing ? (
            <Spinner label={t("imap.probe.running")} />
          ) : imap.lastProbe ? (
            <ProbeResult probe={imap.lastProbe} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("imap.probe.none")}</p>
          )}
          {testError ? (
            <p role="alert" className="text-sm text-destructive">
              {tc(sourceErrorKey(testError))}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
