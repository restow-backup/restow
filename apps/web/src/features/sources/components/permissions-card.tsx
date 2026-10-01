import {
  CircleCheck,
  CircleMinus,
  CircleX,
  KeyRound,
  ListChecks,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatRelative } from "@/lib/format";
import { describeSourceProblem, sourceErrorKey } from "../presenters";
import type { ConnectionVerification, PermissionCheck, SourceDto } from "../types";
import { ToneLine } from "./status";

interface PermissionsCardProps {
  source: SourceDto;
  /** The result of a verification run in this session (carries the user sample). */
  fresh: ConnectionVerification | null;
  onVerify: () => void;
  verifying: boolean;
  verifyError: unknown;
}

/**
 * The permission checklist: can Restow sign in as the backup app in this
 * tenant, which application permissions are granted (the Mail.Read pitfall
 * named explicitly), and does a first Graph call answer.
 */
export function PermissionsCard({
  source,
  fresh,
  onVerify,
  verifying,
  verifyError,
}: PermissionsCardProps) {
  const { t, i18n } = useTranslation("sources");
  const { t: tc } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const connected = Boolean(source.m365?.entraTenantId);
  const stored = source.m365?.verification ?? null;
  // Prefer this session's run when it is the one stored (it still has the sample).
  const verification = fresh && stored && fresh.checkedAt === stored.checkedAt ? fresh : stored;
  // The page explains a classified cause once, above the cards; the sign-in
  // hint below then stays as a detail of this check instead of a second red box.
  const explained = describeSourceProblem(source)?.kind === "classified";

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle className="text-base">{t("m365.permissions.title")}</CardTitle>
          <CardDescription>{t("m365.permissions.description")}</CardDescription>
        </div>
        {connected ? (
          <Button
            variant={verification?.ok ? "outline" : "default"}
            size="sm"
            onClick={onVerify}
            loading={verifying}
            className="shrink-0"
          >
            {verifying ? null : <ListChecks />}
            {verification ? t("actions.verifyAgain") : t("actions.verify")}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-5">
        {verifyError ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{tc(sourceErrorKey(verifyError))}</AlertDescription>
          </Alert>
        ) : null}

        {!connected ? (
          <p className="text-sm text-muted-foreground">{t("m365.permissions.awaitingConsent")}</p>
        ) : !verification ? (
          <p className="text-sm text-muted-foreground">{t("m365.permissions.notChecked")}</p>
        ) : (
          <VerificationDetails
            verification={verification}
            entraTenantId={source.m365?.entraTenantId ?? ""}
            explained={explained}
          />
        )}

        {verification ? (
          <p
            className="text-xs text-muted-foreground"
            title={formatDateTime(verification.checkedAt, language) ?? undefined}
          >
            {t("m365.permissions.checkedAt", {
              when: formatRelative(verification.checkedAt, language) ?? "",
            })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function VerificationDetails({
  verification,
  entraTenantId,
  explained,
}: {
  verification: ConnectionVerification;
  entraTenantId: string;
  /** The source's failure is already explained on the page: no second loud box for the same cause. */
  explained: boolean;
}) {
  const { t } = useTranslation("sources");

  if (!verification.tokenAcquired || !verification.permissions) {
    const error = verification.tokenError;
    return (
      <Alert variant={explained ? "default" : "destructive"}>
        <KeyRound />
        <AlertTitle>{t("m365.token.failed")}</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>{t(`m365.token.hints.${error?.hint ?? "unknown"}`)}</p>
          {error?.aadsts || error?.code ? (
            <p className="font-mono text-xs text-muted-foreground">
              {t("m365.token.code", { code: error.aadsts ?? error.code ?? "" })}
            </p>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  const permissions = verification.permissions;
  const missingRequired = permissions.missing.length;

  return (
    <div className="space-y-5">
      <ToneLine tone="ok" className="text-muted-foreground">
        {t("m365.token.ok", { tenant: entraTenantId })}
      </ToneLine>

      {permissions.readOnlyInstead.map((entry) => (
        <Alert key={entry.expected} variant="destructive">
          <ShieldAlert />
          <AlertTitle>{t("m365.permissions.pitfall.title")}</AlertTitle>
          <AlertDescription>
            {t("m365.permissions.pitfall.description", {
              granted: entry.granted,
              expected: entry.expected,
            })}
          </AlertDescription>
        </Alert>
      ))}

      {permissions.complete ? (
        <ToneLine tone="ok" className="font-medium">
          {t("m365.permissions.complete")}
        </ToneLine>
      ) : (
        <ToneLine tone="destructive" className="font-medium">
          {t("m365.permissions.incomplete", { count: missingRequired })}
        </ToneLine>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("m365.permissions.columns.permission")}</TableHead>
            <TableHead className="hidden md:table-cell">
              {t("m365.permissions.columns.purpose")}
            </TableHead>
            <TableHead className="text-right">{t("m365.permissions.columns.state")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {permissions.checks.map((check) => (
            <PermissionRow key={check.permission} check={check} />
          ))}
        </TableBody>
      </Table>

      {permissions.checks.some((check) => !check.required && check.state !== "granted") ? (
        <p className="text-xs text-muted-foreground">{t("m365.permissions.optionalMissing")}</p>
      ) : null}
      {permissions.unexpected.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("m365.permissions.unexpected", { list: permissions.unexpected.join(", ") })}
        </p>
      ) : null}

      <TestCallResult verification={verification} />
    </div>
  );
}

const STATE_BADGE = {
  granted: { variant: "outline", icon: CircleCheck },
  read_only: { variant: "destructive", icon: ShieldAlert },
  missing: { variant: "destructive", icon: CircleX },
} as const;

function PermissionRow({ check }: { check: PermissionCheck }) {
  const { t } = useTranslation("sources");
  const optionalGap = !check.required && check.state !== "granted";
  const badge = STATE_BADGE[check.state];
  const Icon = optionalGap ? CircleMinus : badge.icon;
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs font-medium">{check.permission}</span>
          <Badge variant="outline" className="font-normal">
            {check.required ? t("m365.permissions.required") : t("m365.permissions.optional")}
          </Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground md:hidden">
          {t(`m365.permissions.purpose.${check.purpose}`)}
        </p>
        {check.state === "read_only" && check.grantedInstead ? (
          <p className="mt-1 text-xs text-destructive">
            {t("m365.permissions.readOnlyDetail", {
              granted: check.grantedInstead,
              expected: check.permission,
            })}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="hidden align-top text-muted-foreground md:table-cell">
        {t(`m365.permissions.purpose.${check.purpose}`)}
      </TableCell>
      <TableCell className="text-right align-top">
        <Badge variant={optionalGap ? "muted" : badge.variant}>
          <Icon aria-hidden="true" />
          {t(`m365.permissions.state.${check.state}`)}
        </Badge>
      </TableCell>
    </TableRow>
  );
}

function TestCallResult({ verification }: { verification: ConnectionVerification }) {
  const { t } = useTranslation("sources");
  const testCall = verification.testCall;
  if (!testCall) {
    return null;
  }
  return (
    <div className="space-y-2 border-t border-border pt-4">
      <p className="text-sm font-medium">{t("m365.testCall.title")}</p>
      {testCall.ok ? (
        <>
          <ToneLine tone="ok">{t("m365.testCall.ok", { count: testCall.usersSampled })}</ToneLine>
          {testCall.sample.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("m365.testCall.sample")}</p>
              <ul className="space-y-0.5 text-sm">
                {testCall.sample.map((user) => (
                  <li key={user.id} className="flex flex-wrap gap-x-2">
                    <span>{user.displayName ?? user.id}</span>
                    {user.userPrincipalName ? (
                      <span className="text-muted-foreground">{user.userPrincipalName}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <ToneLine tone="destructive">
            {t("m365.testCall.failed", {
              code: testCall.code ?? (testCall.status !== null ? String(testCall.status) : "–"),
            })}
          </ToneLine>
          {testCall.message ? (
            <p className="break-words pl-5.5 font-mono text-xs text-muted-foreground">
              {testCall.message}
            </p>
          ) : null}
          {testCall.status === 403 ? (
            <p className="flex items-start gap-1.5 pl-5.5 text-xs text-muted-foreground">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
              {t("m365.testCall.forbiddenHint")}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
