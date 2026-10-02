import { Link, type LinkProps } from "@tanstack/react-router";
import {
  Apple,
  ChevronDown,
  CircleCheck,
  Clock,
  Hourglass,
  Monitor,
  ShieldAlert,
  Terminal,
  TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { CopyButton, RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

import {
  type CreatedToken,
  type EndpointOs,
  type EnrollOs,
  LIMITS,
  type TokenState,
} from "../api.js";
import { useCreateToken, useEndpointFormat, useEnrollmentTokens } from "../hooks.js";
import { type EndpointProfile, endpointDetailTo } from "../paths.js";
import { endpointErrorKey } from "../presenters.js";

/** The public URL, which the agents enrol against, is set under Installation, Server. */
const SETTINGS_TO = "/installation/server" as LinkProps["to"];

/** How often the dialog asks whether the machine has connected. */
export const CONNECT_POLL_MS = 4_000;

const OS_OPTIONS: readonly { os: EndpointOs; icon: LucideIcon }[] = [
  { os: "linux", icon: Terminal },
  { os: "darwin", icon: Apple },
  { os: "windows", icon: Monitor },
];

/** Whether the operating system can be chosen; Windows is planned, not offered. */
export function isSelectableOs(os: EndpointOs): os is EnrollOs {
  return os === "linux" || os === "darwin";
}

/** The system a new machine of this profile most likely runs; the admin still chooses. */
export function defaultOs(profile: EndpointProfile): EnrollOs {
  return profile === "server" ? "linux" : "darwin";
}

/** How the wizard reads a token's state: still waiting, connected, or over. */
export type EnrollStatus = "waiting" | "connected" | "expired" | "revoked";

export function enrollStatusOf(state: TokenState): EnrollStatus {
  switch (state) {
    case "used":
      return "connected";
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    default:
      return "waiting";
  }
}

// --- View ---------------------------------------------------------------------------

export interface EnrollViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: EndpointProfile;
  os: EnrollOs;
  onOsChange: (os: EnrollOs) => void;
  label: string;
  onLabelChange: (label: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  error: unknown;
  /** The token that was created; its command is shown until the dialog closes. */
  created: CreatedToken | null;
  /** The token's live state; the state it was created in until the first poll. */
  tokenState: TokenState | null;
  /** The machine that used the token, once it did. */
  connectedEndpointId: string | null;
  onCreateAnother: () => void;
  /**
   * Whether the viewer may open the installation settings, where the public URL is set
   * (provider admins only); without it the warning says whom to ask instead of linking.
   */
  canOpenInstallation?: boolean;
}

function OsChoice({
  os,
  icon: Icon,
  selected,
}: { os: EndpointOs; icon: LucideIcon; selected: boolean }) {
  const { t } = useTranslation("endpoints");
  const planned = !isSelectableOs(os);
  const id = `enroll-os-${os}`;
  return (
    <Label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors",
        selected && "border-primary bg-primary/5",
        planned && "cursor-not-allowed bg-muted/40 text-muted-foreground",
      )}
    >
      <RadioGroupItem value={os} id={id} disabled={planned} className="mt-1" />
      <span className="min-w-0 space-y-0.5">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {t(`os.${os}`)}
          {planned ? (
            <StatusBadge tone="muted" className="whitespace-nowrap">
              {t("enroll.os.planned")}
            </StatusBadge>
          ) : null}
        </span>
        <span className="block text-xs text-muted-foreground">{t(`enroll.os.hint.${os}`)}</span>
      </span>
    </Label>
  );
}

function ChooseStep(props: EnrollViewProps) {
  const { t } = useTranslation("endpoints");
  const { profile } = props;
  return (
    <form
      className="grid gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t("enroll.os.legend")}</legend>
        <RadioGroup
          value={props.os}
          onValueChange={(value) => {
            if (value === "linux" || value === "darwin") props.onOsChange(value);
          }}
          className="grid gap-2 sm:grid-cols-3"
          aria-label={t("enroll.os.legend")}
        >
          {OS_OPTIONS.map(({ os, icon }) => (
            <OsChoice key={os} os={os} icon={icon} selected={props.os === os} />
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">{t("enroll.os.windowsNote")}</p>
      </fieldset>

      <div className="grid gap-1.5">
        <Label htmlFor="enroll-label">{t("enroll.label.field")}</Label>
        <Input
          id="enroll-label"
          value={props.label}
          maxLength={LIMITS.displayName}
          onChange={(event) => props.onLabelChange(event.target.value)}
          placeholder={t(`enroll.label.placeholder.${profile}`)}
          autoComplete="off"
          aria-describedby="enroll-label-hint"
        />
        <p id="enroll-label-hint" className="text-xs text-muted-foreground">
          {t("enroll.label.hint")}
        </p>
      </div>

      <p className="text-sm text-muted-foreground">{t("enroll.honesty")}</p>

      {props.error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>{t(endpointErrorKey(props.error))}</AlertDescription>
        </Alert>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
          {t("enroll.cancel")}
        </Button>
        <Button type="submit" loading={props.submitting}>
          {t("enroll.create")}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Warnings({
  created,
  canOpenInstallation,
}: {
  created: CreatedToken;
  canOpenInstallation: boolean;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <>
      {created.warnings.includes("insecure_transport") ? (
        <Alert variant="destructive" data-warning="insecure_transport">
          <ShieldAlert />
          <AlertTitle>{t("enroll.warnings.insecure.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("enroll.warnings.insecure.description", { url: created.instanceUrl })}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {created.warnings.includes("instance_url_not_configured") ? (
        <Alert variant="warning" data-warning="instance_url_not_configured">
          <TriangleAlert />
          <AlertTitle>{t("enroll.warnings.notConfigured.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("enroll.warnings.notConfigured.description", { url: created.instanceUrl })}</p>
            {canOpenInstallation ? (
              <Link
                to={SETTINGS_TO}
                className="font-medium text-foreground underline underline-offset-4 hover:no-underline"
              >
                {t("enroll.warnings.notConfigured.link")}
              </Link>
            ) : (
              <p>{t("enroll.warnings.notConfigured.elsewhere")}</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

function CommandBox({
  command,
  label,
  className,
}: { command: string; label: string; className?: string }) {
  return (
    <div
      data-slot="command-box"
      className={cn("flex items-start gap-2 rounded-md border bg-muted/50 p-3", className)}
    >
      <code
        className="min-w-0 flex-1 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] select-all"
        tabIndex={0}
        aria-label={label}
      >
        {command}
      </code>
      <CopyButton value={command} label={label} className="shrink-0" />
    </div>
  );
}

function ConnectionStatus({
  connection,
  created,
  endpointId,
  onCreateAnother,
}: {
  connection: EnrollStatus;
  created: CreatedToken;
  endpointId: string | null;
  onCreateAnother: () => void;
}) {
  const { t } = useTranslation("endpoints");
  if (connection === "connected") {
    return (
      <Alert variant="info" data-connection="connected">
        <CircleCheck />
        <AlertTitle>{t("enroll.status.connected.title")}</AlertTitle>
        <AlertDescription>
          <p>{t(`enroll.status.connected.description.${created.profile}`)}</p>
          {endpointId ? (
            <Link
              to={endpointDetailTo(endpointId)}
              className={buttonVariants({ size: "sm", className: "mt-1" })}
            >
              {t(`enroll.status.connected.open.${created.profile}`)}
            </Link>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  if (connection === "expired" || connection === "revoked") {
    return (
      <Alert variant="warning" data-connection={connection}>
        <Clock />
        <AlertTitle>{t(`enroll.status.${connection}.title`)}</AlertTitle>
        <AlertDescription>
          <p>{t(`enroll.status.${connection}.description`)}</p>
          <Button size="sm" variant="outline" className="mt-1" onClick={onCreateAnother}>
            {t("enroll.createAnother")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <div
      data-connection="waiting"
      className="flex items-start gap-3 rounded-md border border-dashed p-3 text-sm"
      aria-live="polite"
    >
      <Hourglass aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="space-y-0.5">
        <p className="font-medium">{t("enroll.status.waiting.title")}</p>
        <p className="text-muted-foreground">{t("enroll.status.waiting.description")}</p>
      </div>
    </div>
  );
}

function CommandStep(props: EnrollViewProps & { created: CreatedToken }) {
  const { t } = useTranslation("endpoints");
  const { created } = props;
  const connection = enrollStatusOf(props.tokenState ?? created.state);
  const format = useEndpointFormat();
  const expires = format.dateTime(created.expiresAt);
  const steps = ["download", "verify", "service", "enroll"] as const;
  const inactive = connection !== "waiting";
  return (
    <div className="grid gap-4">
      <Warnings created={created} canOpenInstallation={props.canOpenInstallation ?? true} />

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">{t(`enroll.command.heading.${created.os}`)}</h3>
        <p className="text-sm text-muted-foreground">
          {t(`enroll.command.intro.${created.os}`, {
            kind: t(`enroll.command.kind.${created.profile}`),
          })}
        </p>
        <div className={cn(inactive && "opacity-60")}>
          <CommandBox command={created.commands.install} label={t("enroll.command.copy")} />
        </div>
        <p className="text-sm text-muted-foreground">{t("enroll.command.tokenIntro")}</p>
        <div className={cn(inactive && "opacity-60")} data-slot="enroll-token">
          <CommandBox command={created.token} label={t("enroll.command.copyToken")} />
        </div>
        <p className="text-xs text-muted-foreground">
          {t("enroll.command.validity")}
          {expires ? (
            <>
              {" "}
              {t("enroll.command.expiresAt", { time: expires })}{" "}
              <span className="whitespace-nowrap">
                (<RelativeTime value={created.expiresAt} focusable={false} />)
              </span>
              .
            </>
          ) : null}
        </p>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t("enroll.command.secretNote")}
        </p>
      </section>

      <ConnectionStatus
        connection={connection}
        created={created}
        endpointId={props.connectedEndpointId}
        onCreateAnother={props.onCreateAnother}
      />

      <section className="grid gap-2">
        <h3 className="text-sm font-medium">{t("enroll.script.heading")}</h3>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {steps.map((step) => (
            <li key={step}>{t(`enroll.script.steps.${step}.${created.os}`)}</li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{t("enroll.script.repair")}</p>
        <p className="text-sm text-muted-foreground" data-slot="enroll-hooks">
          {t("enroll.script.hooks")}
        </p>
      </section>

      <Collapsible className="rounded-md border">
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {t("enroll.unattended.heading")}
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-3 border-t px-3 py-3">
          <p className="text-sm text-muted-foreground">
            {t("enroll.unattended.intro", { tokenFile: created.commands.tokenFile })}
          </p>
          <CommandBox
            command={created.commands.installUnattended}
            label={t("enroll.unattended.copy")}
          />
          <p className="text-xs text-muted-foreground">{t("enroll.unattended.cleanup")}</p>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible className="rounded-md border">
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {t("enroll.uninstall.heading")}
          <ChevronDown
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-3 border-t px-3 py-3">
          <p className="text-sm text-muted-foreground">{t("enroll.uninstall.intro")}</p>
          <div className="grid gap-1.5">
            <p className="text-xs font-medium">{t("enroll.uninstall.agent")}</p>
            <CommandBox
              command={created.commands.uninstallAgent}
              label={t("enroll.uninstall.copyAgent")}
            />
          </div>
          <div className="grid gap-1.5">
            <p className="text-xs font-medium">{t("enroll.uninstall.script")}</p>
            <CommandBox
              command={created.commands.uninstallScript}
              label={t("enroll.uninstall.copyScript")}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("enroll.uninstall.remote")}</p>
        </CollapsibleContent>
      </Collapsible>

      <DialogFooter>
        {connection === "waiting" ? (
          <Button type="button" variant="outline" onClick={props.onCreateAnother}>
            {t("enroll.createAnother")}
          </Button>
        ) : null}
        <Button type="button" onClick={() => props.onOpenChange(false)}>
          {t("enroll.done")}
        </Button>
      </DialogFooter>
    </div>
  );
}

/**
 * The install wizard as a dialog: first the system (Linux and macOS; Windows
 * is shown as planned), then the one-time command with everything an admin
 * should know before running it, then the live state of the enrollment.
 *
 * The command holds a secret shown once, so it lives only in this component's
 * state: it is never put in a URL or written to storage, and closing the
 * dialog drops it.
 */
export function EnrollDialogView(props: EnrollViewProps) {
  const { t } = useTranslation("endpoints");
  const { created, profile } = props;
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        className="max-h-[92dvh] max-w-2xl overflow-y-auto"
        // A click beside the dialog must not throw the one-time command away.
        onInteractOutside={(event) => {
          if (created) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t(`enroll.title.${profile}`)}</DialogTitle>
          <DialogDescription>
            {created ? t("enroll.description.command") : t(`enroll.description.choose.${profile}`)}
          </DialogDescription>
        </DialogHeader>
        {created ? <CommandStep {...props} created={created} /> : <ChooseStep {...props} />}
      </DialogContent>
    </Dialog>
  );
}

// --- Container -------------------------------------------------------------------------

export interface EnrollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: EndpointProfile;
  /** See {@link EnrollViewProps.canOpenInstallation}. */
  canOpenInstallation?: boolean;
}

export function EnrollDialog({
  open,
  onOpenChange,
  profile,
  canOpenInstallation = true,
}: EnrollDialogProps) {
  const [os, setOs] = React.useState<EnrollOs>(() => defaultOs(profile));
  const [label, setLabel] = React.useState("");
  const create = useCreateToken();
  const created = create.data ?? null;

  // The state the token was created in is "valid"; the poll finds out when a machine used it.
  const waitingFor = created?.id ?? null;
  const tokens = useEnrollmentTokens({
    state: "all",
    enabled: open && waitingFor !== null,
    pollMs: open && created ? CONNECT_POLL_MS : false,
  });
  const live = tokens.data?.find((token) => token.id === waitingFor) ?? null;

  const reset = () => {
    create.reset();
    setLabel("");
    setOs(defaultOs(profile));
  };
  const resetRef = React.useRef(reset);
  resetRef.current = reset;

  // Every opening starts clean, and the command is dropped when the dialog goes away.
  React.useEffect(() => {
    if (!open) {
      resetRef.current();
    }
  }, [open]);

  return (
    <EnrollDialogView
      open={open}
      onOpenChange={onOpenChange}
      profile={profile}
      os={os}
      onOsChange={setOs}
      label={label}
      onLabelChange={setLabel}
      onSubmit={() => {
        const displayName = label.trim();
        create.mutate({ profile, os, ...(displayName ? { displayName } : {}) });
      }}
      submitting={create.isPending}
      error={create.error}
      created={created}
      tokenState={live?.state ?? null}
      connectedEndpointId={live?.usedByEndpointId ?? null}
      canOpenInstallation={canOpenInstallation}
      onCreateAnother={() => {
        create.reset();
        setLabel("");
      }}
    />
  );
}
