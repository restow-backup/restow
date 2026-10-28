import { Check, ChevronRight, Copy } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { CopyButton, copyToClipboard, UI_NAMESPACE } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";

/**
 * Small building blocks of the app-registration guide: copy controls, portal
 * paths and labels rendered the way the Entra portal names them, the step
 * frame (the expiry badge is shared: features/shared/credential-expiry-badge.tsx).
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
