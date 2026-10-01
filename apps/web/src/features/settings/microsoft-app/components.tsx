import {
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  type LucideIcon,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import {
  CopyButton,
  StatusBadge,
  type StatusTone,
  UI_NAMESPACE,
  copyToClipboard,
} from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { type ExpiryState, expiryState } from "./presenters";

/**
 * Small building blocks of the app-registration guide: copy controls, portal
 * paths and labels rendered the way the Entra portal names them, the step
 * frame and the expiry badge.
 */

/** Where the guide is shown: the settings section, or embedded in a source page. */
export type SetupVariant = "page" | "inline";

/** How long the check mark stays after a successful copy (the kit's CopyButton does the same). */
const COPIED_MS = 2000;

/**
 * A labelled button that copies `value`, for copies that deserve words ("Copy
 * list") rather than the kit's icon-only CopyButton. It behaves like the
 * kit's: the clipboard fallback for plain-HTTP installations, a check mark
 * announced to screen readers on success, a toast when copying failed.
 */
export function CopyTextButton({ value, children }: { value: string; children: React.ReactNode }) {
  // The kit's own copy strings (namespace `ui`), shared with its CopyButton.
  const { t: tu } = useTranslation(UI_NAMESPACE);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async (button: HTMLElement) => {
    try {
      await copyToClipboard(value, button);
      setCopied(true);
    } catch {
      toast.error(tu("copy.failed"));
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={(event) => void copy(event.currentTarget)}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {children}
      </Button>
      <span className="sr-only" aria-live="polite">
        {copied ? tu("copy.copied") : ""}
      </span>
    </>
  );
}

/** A read-only value (redirect URI) with a copy button. */
export function CopyField({ id, value, label }: { id: string; value: string; label: string }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        readOnly
        value={value}
        className="font-mono text-xs"
        onFocus={(event) => event.currentTarget.select()}
      />
      <CopyButton
        value={value}
        label={t("microsoftApp.copy", { label })}
        variant="outline"
        size="icon"
      />
    </div>
  );
}

/** A label exactly as the Entra portal shows it (button, menu entry, column). */
export function PortalLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded border border-border bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-foreground">
      {children}
    </span>
  );
}

/** A click path through the portal, e.g. Identity › Applications › App registrations. */
export function PortalPath({ items }: { items: readonly string[] }) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5">
      {items.map((item, index) => (
        <li key={item} className="flex items-center gap-1.5">
          {index > 0 ? (
            <ChevronRight aria-hidden="true" className="size-3.5 text-muted-foreground" />
          ) : null}
          <PortalLabel>{item}</PortalLabel>
        </li>
      ))}
    </ol>
  );
}

/** One numbered step of the guide: a card on the settings page, a bordered section inline. */
export function StepFrame({
  number,
  title,
  description,
  variant,
  children,
}: {
  number: number;
  title: string;
  description: string;
  variant: SetupVariant;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("settings");
  const heading = (
    <div className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold tabular-nums text-primary"
      >
        {number}
      </span>
      <div className="min-w-0 space-y-1.5">
        <CardTitle className={cn(variant === "inline" && "text-sm")}>
          <span className="sr-only">{t("microsoftApp.steps.step", { number })}: </span>
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </div>
    </div>
  );
  if (variant === "inline") {
    return (
      <section className="space-y-4 rounded-lg border border-border p-4">
        {heading}
        <div className="space-y-4 sm:pl-10">{children}</div>
      </section>
    );
  }
  return (
    <Card>
      <CardHeader>{heading}</CardHeader>
      <CardContent className="space-y-4 sm:pl-16">{children}</CardContent>
    </Card>
  );
}

/** The badge text for an expiry state, as an i18n key and its values. */
function expiryText(
  state: ExpiryState,
  language: string,
): { key: string; values?: Record<string, string | number> } {
  switch (state.kind) {
    case "expired":
      return { key: "microsoftApp.expiry.expired" };
    case "soon":
      return state.days === 0
        ? { key: "microsoftApp.expiry.today" }
        : { key: "microsoftApp.expiry.soon", values: { days: state.days } };
    case "valid":
      return {
        key: "microsoftApp.expiry.valid",
        values: { date: formatDay(state.date, language) },
      };
    case "unknown":
      return { key: "microsoftApp.status.expiryUnknown" };
  }
}

/** A calendar date in the UI language (expiry dates are whole days in UTC). */
export function formatDay(iso: string, language: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

const EXPIRY_BADGE: Record<
  Exclude<ExpiryState["kind"], "unknown">,
  { tone: StatusTone; icon: LucideIcon }
> = {
  valid: { tone: "neutral", icon: CircleCheck },
  soon: { tone: "warning", icon: Clock },
  expired: { tone: "destructive", icon: CircleAlert },
};

/** Expiry of the credential: neutral while valid, amber within 60 days, red once expired. */
export function ExpiryBadge({ expiresAt, now }: { expiresAt: string | null; now?: number }) {
  const { t, i18n } = useTranslation("settings");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const state = expiryState(expiresAt, now);
  const { key, values } = expiryText(state, language);
  const text = t(key, values);
  if (state.kind === "unknown") {
    return <span className="text-sm text-muted-foreground">{text}</span>;
  }
  const { tone, icon } = EXPIRY_BADGE[state.kind];
  return (
    <StatusBadge tone={tone} icon={icon}>
      {text}
    </StatusBadge>
  );
}
