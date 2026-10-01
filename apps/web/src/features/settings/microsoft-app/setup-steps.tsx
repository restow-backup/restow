import { CircleCheck, CircleX, ExternalLink, Info, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CopyButton, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { MicrosoftAppView } from "./api";
import {
  CopyField,
  CopyTextButton,
  PortalLabel,
  PortalPath,
  type SetupVariant,
  StepFrame,
} from "./components";
import { ENTRA_ADMIN_CENTER_URL, opensslCommands, permissionsCopyText } from "./presenters";

/**
 * Steps 1 to 3 of the guide, mirroring docs/ENTRA-SETUP.md (part 1 to 3):
 * register the multi-tenant app, add the Graph permissions, create the
 * credential. Portal labels are shown the way the portal names them in the
 * UI language, so an admin can follow along click by click.
 */

interface StepProps {
  view: MicrosoftAppView;
  variant: SetupVariant;
}

export function RegisterStep({ view, variant }: StepProps) {
  const { t } = useTranslation("settings");
  const redirectUri = view.redirectUris.adminConsent;
  const path = (["identity", "applications", "appRegistrations", "newRegistration"] as const).map(
    (item) => t(`microsoftApp.steps.register.pathItems.${item}`),
  );
  return (
    <StepFrame
      number={1}
      title={t("microsoftApp.steps.register.title")}
      description={t("microsoftApp.steps.register.description")}
      variant={variant}
    >
      <div className="space-y-2">
        <p className="text-sm">{t("microsoftApp.steps.register.path")}</p>
        <PortalPath items={path} />
      </div>
      <ul className="list-disc space-y-2 pl-5 text-sm marker:text-muted-foreground">
        <li>{t("microsoftApp.steps.register.name")}</li>
        <li className="space-y-1">
          <span>{t("microsoftApp.steps.register.accountTypes")}</span>{" "}
          <PortalLabel>{t("microsoftApp.steps.register.accountTypesValue")}</PortalLabel>
        </li>
        <li>{t("microsoftApp.steps.register.redirect")}</li>
      </ul>
      {redirectUri ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${variant}-msapp-redirect`} className="text-xs text-muted-foreground">
            {t("microsoftApp.steps.register.redirectLabel")}
          </Label>
          <CopyField
            id={`${variant}-msapp-redirect`}
            value={redirectUri}
            label={t("microsoftApp.steps.register.redirectLabel")}
          />
        </div>
      ) : (
        <Alert variant="warning">
          <Info />
          <AlertDescription>{t("microsoftApp.steps.register.redirectMissing")}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2 text-sm">
        <p>{t("microsoftApp.steps.register.register")}</p>
        <div className="flex flex-wrap gap-2">
          <PortalLabel>{t("microsoftApp.status.clientId")}</PortalLabel>
          <PortalLabel>{t("microsoftApp.status.tenantId")}</PortalLabel>
        </div>
      </div>
      <a
        href={ENTRA_ADMIN_CENTER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "h-auto min-h-8 w-fit whitespace-normal py-1.5 text-left",
        )}
      >
        <ExternalLink aria-hidden="true" />
        {t("microsoftApp.steps.register.openAdminCenter")}
      </a>
    </StepFrame>
  );
}

export function PermissionsStep({ view, variant }: StepProps) {
  const { t } = useTranslation("settings");
  const { t: ts } = useTranslation("sources");
  return (
    <StepFrame
      number={2}
      title={t("microsoftApp.steps.permissions.title")}
      description={t("microsoftApp.steps.permissions.description")}
      variant={variant}
    >
      <CopyTextButton value={permissionsCopyText(view.permissions)}>
        {t("microsoftApp.steps.permissions.copyList")}
      </CopyTextButton>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("microsoftApp.steps.permissions.columns.permission")}</TableHead>
            <TableHead className="hidden sm:table-cell">
              {t("microsoftApp.steps.permissions.columns.type")}
            </TableHead>
            <TableHead className="hidden md:table-cell">
              {t("microsoftApp.steps.permissions.columns.purpose")}
            </TableHead>
            <TableHead className="text-right whitespace-nowrap">
              {t("microsoftApp.steps.permissions.columns.requirement")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.permissions.map((entry) => (
            <TableRow key={`${entry.type}:${entry.permission}`}>
              <TableCell className="align-top">
                <span className="font-mono text-xs font-medium">{entry.permission}</span>
                <p className="mt-1 text-xs text-muted-foreground sm:hidden">
                  {t(`microsoftApp.steps.permissions.types.${entry.type}`)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground md:hidden">
                  {ts(`m365.permissions.purpose.${entry.purpose}`)}
                </p>
              </TableCell>
              <TableCell className="hidden align-top text-muted-foreground sm:table-cell">
                {t(`microsoftApp.steps.permissions.types.${entry.type}`)}
              </TableCell>
              <TableCell className="hidden align-top text-muted-foreground md:table-cell">
                {ts(`m365.permissions.purpose.${entry.purpose}`)}
              </TableCell>
              <TableCell className="text-right align-top whitespace-nowrap">
                <Badge variant={entry.required ? "outline" : "muted"}>
                  {entry.required
                    ? t("microsoftApp.steps.permissions.required")
                    : t("microsoftApp.steps.permissions.optional")}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground marker:text-muted-foreground">
        <li>{t("microsoftApp.steps.permissions.delegated")}</li>
        <li>{t("microsoftApp.steps.permissions.mailSend")}</li>
        <li>{t("microsoftApp.steps.permissions.sites")}</li>
      </ul>
      <Alert variant="warning">
        <ShieldAlert />
        <AlertTitle>{t("microsoftApp.steps.permissions.pitfallTitle")}</AlertTitle>
        <AlertDescription>{t("microsoftApp.steps.permissions.pitfall")}</AlertDescription>
      </Alert>
      <div className="space-y-2 text-sm">
        <p>{t("microsoftApp.steps.permissions.consent")}</p>
        <PortalLabel>{t("microsoftApp.steps.permissions.consentLabel")}</PortalLabel>
        <p className="text-xs text-muted-foreground">
          {t("microsoftApp.steps.permissions.consentHint")}
        </p>
      </div>
    </StepFrame>
  );
}

export function CredentialsStep({ variant }: { variant: SetupVariant }) {
  const { t } = useTranslation("settings");
  const portal = (key: string) => t(`microsoftApp.steps.credentials.portal.${key}`);
  const commands = opensslCommands(t("common:app.name"));
  return (
    <StepFrame
      number={3}
      title={t("microsoftApp.steps.credentials.title")}
      description={t("microsoftApp.steps.credentials.description")}
      variant={variant}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-sm font-semibold">
              {t("microsoftApp.steps.credentials.certificate.title")}
            </h4>
            <StatusBadge tone="info">
              {t("microsoftApp.steps.credentials.certificate.recommended")}
            </StatusBadge>
          </div>
          <p className="text-sm">{t("microsoftApp.steps.credentials.certificate.create")}</p>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
              <code>{commands}</code>
            </pre>
            <CopyButton
              value={commands}
              label={t("microsoftApp.steps.credentials.certificate.copyCommand")}
              variant="outline"
              size="icon"
            />
          </div>
          <PortalPath
            items={[
              portal("certificatesAndSecrets"),
              portal("certificates"),
              portal("uploadCertificate"),
            ]}
          />
          <p className="text-sm">{t("microsoftApp.steps.credentials.certificate.upload")}</p>
          <p className="text-sm">{t("microsoftApp.steps.credentials.certificate.enter")}</p>
          <p className="text-xs text-muted-foreground">
            {t("microsoftApp.steps.credentials.certificate.benefit")}
          </p>
        </section>

        <section className="space-y-3 rounded-lg border border-border p-4">
          <h4 className="text-sm font-semibold">
            {t("microsoftApp.steps.credentials.secret.title")}
          </h4>
          <PortalPath
            items={[
              portal("certificatesAndSecrets"),
              portal("clientSecrets"),
              portal("newClientSecret"),
            ]}
          />
          <p className="text-sm">{t("microsoftApp.steps.credentials.secret.create")}</p>
          <Alert variant="warning">
            <ShieldAlert />
            <AlertTitle>{t("microsoftApp.steps.credentials.secret.valueTitle")}</AlertTitle>
            <AlertDescription className="gap-2">
              <p>{t("microsoftApp.steps.credentials.secret.value")}</p>
              <div className="flex flex-wrap gap-3">
                <span className="inline-flex items-center gap-1.5">
                  <CircleCheck aria-hidden="true" className="size-4 text-foreground" />
                  <PortalLabel>{portal("value")}</PortalLabel>
                </span>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <CircleX aria-hidden="true" className="size-4 text-destructive-text" />
                  <PortalLabel>{portal("secretId")}</PortalLabel>
                </span>
              </div>
            </AlertDescription>
          </Alert>
          <p className="text-xs text-muted-foreground">
            {t("microsoftApp.steps.credentials.secret.rotate")}
          </p>
        </section>
      </div>
    </StepFrame>
  );
}
