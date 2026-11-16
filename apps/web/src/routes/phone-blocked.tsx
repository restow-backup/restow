import { useRouterState } from "@tanstack/react-router";
import { Check, Copy, Laptop } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { copyToClipboard } from "@/components/kit/clipboard";
import { AuthLayout } from "@/components/layout/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { linkForComputer, type PhoneGate } from "@/lib/device";

/** How long the check mark stays after a successful copy. */
const CONFIRMATION_MS = 2000;

/**
 * What replaces every page on a phone (lib/device.ts says which devices and
 * which pages): why, and the one thing to do, which is to take the address to
 * a computer. Not a modal and not a redirect, so the address stays and the
 * language and theme switch of the frame keep working. The reason is a design
 * decision about a sensitive tool, not an access control, and there is no way
 * past it.
 */
export function PhoneBlockPage({ gate }: { gate: PhoneGate }) {
  const { t } = useTranslation();
  const href = useRouterState({ select: (state) => state.location.href });
  const link = linkForComputer(href, window.location.origin);
  const [copy, setCopy] = React.useState<"idle" | "copied" | "failed">("idle");
  const heading = React.useRef<HTMLHeadingElement>(null);
  const prefix = gate === "invitation" ? "phoneBlock.invitation" : "phoneBlock";

  // One h1, focused when the page appears, so a screen reader starts on it.
  React.useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  React.useEffect(() => {
    if (copy !== "copied") {
      return;
    }
    const timer = window.setTimeout(() => setCopy("idle"), CONFIRMATION_MS);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const copyLink = async (button: HTMLElement) => {
    try {
      await copyToClipboard(link, button);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };

  return (
    <AuthLayout width="sm" touchTargets>
      <Card data-slot="phone-block">
        <CardHeader className="flex flex-col items-center text-center">
          <div className="mb-2 flex size-12 items-center justify-center rounded-full bg-muted text-foreground">
            <Laptop aria-hidden="true" className="size-5" />
          </div>
          <h1
            ref={heading}
            tabIndex={-1}
            className="text-xl leading-tight font-semibold outline-none"
          >
            {t(`${prefix}.title`)}
          </h1>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>{t(`${prefix}.why`)}</p>
          <p>{t(`${prefix}.what`)}</p>
          <p className="rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs break-all text-foreground select-all">
            {link}
          </p>
          {copy === "failed" ? (
            <p role="alert" className="text-destructive">
              {t("phoneBlock.copyFailed")}
            </p>
          ) : null}
          <span className="sr-only" aria-live="polite">
            {copy === "copied" ? t("phoneBlock.copied") : ""}
          </span>
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button
            className="min-h-11 w-full"
            onClick={(event) => void copyLink(event.currentTarget)}
          >
            {copy === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copy === "copied" ? t("phoneBlock.copied") : t("phoneBlock.copyLink")}
          </Button>
          <p className="text-center text-xs text-muted-foreground">{t("phoneBlock.mailLinks")}</p>
        </CardFooter>
      </Card>
    </AuthLayout>
  );
}
