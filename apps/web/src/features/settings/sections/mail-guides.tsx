import { BookOpen, ChevronDown, ExternalLink, ShieldAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  ENTRA_ADMIN_CENTER_URL,
  GMAIL_SEND_SCOPE,
  GOOGLE_ADMIN_CONSOLE_URL,
  GOOGLE_CLOUD_CONSOLE_URL,
  accessPolicyCommands,
  rbacCommands,
} from "../mail-guide";
import {
  CopyField,
  CopyTextButton,
  PortalLabel,
  PortalPath,
  StepFrame,
} from "../microsoft-app/components";

/**
 * The in-page guides of the notification mail: how to register an own
 * Microsoft Entra app with only Mail.Send (and restrict it to the sender
 * mailbox), and how to set up a Google Workspace service account with
 * domain-wide delegation for gmail.send. Values the operator copies come with
 * copy buttons; commands carry what the form already knows.
 */

function ExternalButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        buttonVariants({ variant: "outline", size: "sm" }),
        "h-auto min-h-8 w-fit whitespace-normal py-1.5 text-left",
      )}
    >
      <ExternalLink aria-hidden="true" />
      {children}
    </a>
  );
}

/** A block of commands to copy as a whole. */
function CommandBlock({ commands, label }: { commands: string; label: string }) {
  return (
    <div className="space-y-2">
      <pre
        aria-label={label}
        className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {commands}
      </pre>
      <CopyTextButton value={commands}>{label}</CopyTextButton>
    </div>
  );
}

/** A guide that folds away once the operator knows it. */
function GuideFrame({
  id,
  title,
  description,
  defaultOpen,
  children,
}: {
  id: string;
  title: string;
  description: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border">
      <div className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <BookOpen aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="space-y-1">
            <p id={`${id}-title`} className="text-sm font-medium">
              {title}
            </p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="w-fit shrink-0" aria-controls={id}>
            <ChevronDown
              aria-hidden="true"
              className={cn("transition-transform", open && "rotate-180")}
            />
            {open ? t("mail.guide.hide") : t("mail.guide.show")}
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent id={id} className="space-y-4 border-t border-border p-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}

// --- Microsoft 365 ------------------------------------------------------------------------

export interface GraphMailGuideProps {
  /** What the form holds, so the commands carry it. */
  clientId: string;
  sender: string;
  defaultOpen: boolean;
}

export function GraphMailGuide({ clientId, sender, defaultOpen }: GraphMailGuideProps) {
  const { t } = useTranslation("settings");
  const path = (["identity", "applications", "appRegistrations", "newRegistration"] as const).map(
    (item) => t(`mail.guide.graph.register.pathItems.${item}`),
  );
  const placeholders = {
    clientId: t("mail.guide.graph.restrict.placeholders.clientId"),
    objectId: t("mail.guide.graph.restrict.placeholders.objectId"),
    sender: t("mail.guide.graph.restrict.placeholders.sender"),
    group: t("mail.guide.graph.restrict.placeholders.group"),
  };
  const values = { clientId, sender, placeholders };

  return (
    <GuideFrame
      id="settings-mail-graph-guide"
      title={t("mail.guide.graph.title")}
      description={t("mail.guide.graph.description")}
      defaultOpen={defaultOpen}
    >
      <StepFrame
        number={1}
        title={t("mail.guide.graph.register.title")}
        description={t("mail.guide.graph.register.path")}
        variant="inline"
      >
        <PortalPath items={path} />
        <ul className="list-disc space-y-2 pl-5 text-sm marker:text-muted-foreground">
          <li>{t("mail.guide.graph.register.name")}</li>
          <li>
            <span>{t("mail.guide.graph.register.accountTypes")}</span>{" "}
            <PortalLabel>{t("mail.guide.graph.register.accountTypesValue")}</PortalLabel>
          </li>
          <li>{t("mail.guide.graph.register.redirect")}</li>
        </ul>
        <div className="space-y-2 text-sm">
          <p>{t("mail.guide.graph.register.values")}</p>
          <div className="flex flex-wrap gap-2">
            <PortalLabel>{t("mail.graph.clientId")}</PortalLabel>
            <PortalLabel>{t("mail.graph.directoryId")}</PortalLabel>
          </div>
        </div>
        <ExternalButton href={ENTRA_ADMIN_CENTER_URL}>
          {t("mail.guide.graph.openAdminCenter")}
        </ExternalButton>
      </StepFrame>

      <StepFrame
        number={2}
        title={t("mail.guide.graph.permission.title")}
        description={t("mail.guide.graph.permission.path")}
        variant="inline"
      >
        <div className="flex flex-wrap items-center gap-2">
          <PortalLabel>Mail.Send</PortalLabel>
        </div>
        <p className="text-sm text-muted-foreground">{t("mail.guide.graph.permission.noOther")}</p>
        <div className="space-y-1.5 text-sm">
          <p>{t("mail.guide.graph.permission.consent")}</p>
          <PortalLabel>{t("mail.guide.graph.permission.consentLabel")}</PortalLabel>
        </div>
      </StepFrame>

      <StepFrame
        number={3}
        title={t("mail.guide.graph.credential.title")}
        description={t("mail.guide.graph.credential.create")}
        variant="inline"
      >
        <ul className="list-disc space-y-2 pl-5 text-sm marker:text-muted-foreground">
          <li>{t("mail.guide.graph.credential.value")}</li>
          <li>{t("mail.guide.graph.credential.expiry")}</li>
          <li className="text-muted-foreground">{t("mail.guide.graph.credential.certificate")}</li>
        </ul>
      </StepFrame>

      <StepFrame
        number={4}
        title={t("mail.guide.graph.restrict.title")}
        description={t("mail.guide.graph.restrict.description")}
        variant="inline"
      >
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("mail.guide.graph.restrict.rbacTitle")}</p>
          <p className="text-sm text-muted-foreground">
            {t("mail.guide.graph.restrict.rbacIntro")}
          </p>
          <CommandBlock commands={rbacCommands(values)} label={t("mail.guide.copyCommands")} />
          <Alert variant="warning">
            <ShieldAlert />
            <AlertDescription>{t("mail.guide.graph.restrict.rbacConsent")}</AlertDescription>
          </Alert>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("mail.guide.graph.restrict.policyTitle")}</p>
          <p className="text-sm text-muted-foreground">
            {t("mail.guide.graph.restrict.policyIntro")}
          </p>
          <CommandBlock
            commands={accessPolicyCommands(values)}
            label={t("mail.guide.copyCommands")}
          />
        </div>
        <p className="text-xs text-muted-foreground">{t("mail.guide.graph.restrict.delay")}</p>
      </StepFrame>

      <StepFrame
        number={5}
        title={t("mail.guide.graph.enter.title")}
        description={t("mail.guide.graph.enter.description")}
        variant="inline"
      >
        {null}
      </StepFrame>
    </GuideFrame>
  );
}

// --- Google Workspace ------------------------------------------------------------------------

export interface GoogleMailGuideProps {
  /** The service account's client ID (stored, or read from the pasted key); null before. */
  clientId: string | null;
  defaultOpen: boolean;
}

export function GoogleMailGuide({ clientId, defaultOpen }: GoogleMailGuideProps) {
  const { t } = useTranslation("settings");
  const apiPath = (["apis", "library", "gmail", "enable"] as const).map((item) =>
    t(`mail.guide.google.api.pathItems.${item}`),
  );
  const delegationPath = (["security", "access", "apiControls", "delegation", "add"] as const).map(
    (item) => t(`mail.guide.google.delegation.pathItems.${item}`),
  );

  return (
    <GuideFrame
      id="settings-mail-google-guide"
      title={t("mail.guide.google.title")}
      description={t("mail.guide.google.description")}
      defaultOpen={defaultOpen}
    >
      <StepFrame
        number={1}
        title={t("mail.guide.google.api.title")}
        description={t("mail.guide.google.api.path")}
        variant="inline"
      >
        <PortalPath items={apiPath} />
        <ExternalButton href={GOOGLE_CLOUD_CONSOLE_URL}>
          {t("mail.guide.google.openCloudConsole")}
        </ExternalButton>
      </StepFrame>

      <StepFrame
        number={2}
        title={t("mail.guide.google.account.title")}
        description={t("mail.guide.google.account.create")}
        variant="inline"
      >
        <ul className="list-disc space-y-2 pl-5 text-sm marker:text-muted-foreground">
          <li>{t("mail.guide.google.account.key")}</li>
          <li className="text-muted-foreground">{t("mail.guide.google.account.policy")}</li>
        </ul>
        <Alert variant="warning">
          <ShieldAlert />
          <AlertDescription>{t("mail.guide.google.account.keep")}</AlertDescription>
        </Alert>
      </StepFrame>

      <StepFrame
        number={3}
        title={t("mail.guide.google.delegation.title")}
        description={t("mail.guide.google.delegation.path")}
        variant="inline"
      >
        <PortalPath items={delegationPath} />
        <div className="space-y-1.5">
          <Label htmlFor="settings-google-client-id" className="text-xs text-muted-foreground">
            {t("mail.guide.google.delegation.clientId")}
          </Label>
          {clientId ? (
            <CopyField
              id="settings-google-client-id"
              value={clientId}
              label={t("mail.guide.google.delegation.clientId")}
            />
          ) : (
            <p id="settings-google-client-id" className="text-sm text-muted-foreground">
              {t("mail.guide.google.delegation.clientIdMissing")}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="settings-google-scope" className="text-xs text-muted-foreground">
            {t("mail.guide.google.delegation.scope")}
          </Label>
          <CopyField
            id="settings-google-scope"
            value={GMAIL_SEND_SCOPE}
            label={t("mail.guide.google.delegation.scope")}
          />
          <p className="text-xs text-muted-foreground">
            {t("mail.guide.google.delegation.onlyScope")}
          </p>
        </div>
        <Alert variant="info">
          <AlertTitle className="sr-only">{t("mail.guide.google.delegation.title")}</AlertTitle>
          <AlertDescription>{t("mail.guide.google.delegation.delay")}</AlertDescription>
        </Alert>
        <ExternalButton href={GOOGLE_ADMIN_CONSOLE_URL}>
          {t("mail.guide.google.openAdminConsole")}
        </ExternalButton>
      </StepFrame>

      <StepFrame
        number={4}
        title={t("mail.guide.google.enter.title")}
        description={t("mail.guide.google.enter.description")}
        variant="inline"
      >
        {null}
      </StepFrame>
    </GuideFrame>
  );
}
