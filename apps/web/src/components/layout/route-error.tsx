import { Link, useRouter } from "@tanstack/react-router";
import { AlertTriangle, ChevronDown, LayoutDashboard, RotateCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { usePublishedTitle } from "@/components/kit/page-context";
import { Button, buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ApiError, NetworkError, errorMessageKey } from "@/lib/api";

interface RouteErrorPageProps {
  error: unknown;
  /** Clears the error boundary so the page renders again. */
  reset?: () => void;
}

/**
 * The technical message of an unexpected error, for the details disclosure.
 * API and network failures are already explained by the mapped cause, so
 * they add nothing here.
 */
export function technicalDetail(error: unknown): string | null {
  if (error instanceof ApiError || error instanceof NetworkError) {
    return null;
  }
  if (error instanceof Error) {
    return error.message ? `${error.name}: ${error.message}` : error.name;
  }
  return typeof error === "string" && error.length > 0 ? error : null;
}

/**
 * A page that crashed, rendered inside the shell: sidebar and top bar stay
 * usable. It names the cause, offers a retry (which reloads the route's data
 * and renders the page again) and a way back to the overview; unexpected
 * errors show their technical message on request, for a bug report.
 */
export function RouteErrorPage({ error, reset }: RouteErrorPageProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [retrying, setRetrying] = React.useState(false);
  const detail = technicalDetail(error);
  usePublishedTitle(t("errors.pageTitle"), t("app.name"));

  const retry = async () => {
    setRetrying(true);
    try {
      await router.invalidate();
      reset?.();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <section
      aria-labelledby="route-error-title"
      className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/15 text-destructive-text">
        <AlertTriangle className="size-6" aria-hidden="true" />
      </span>
      {/* Announced when a page crashes in place, where focus does not move. */}
      <div role="alert" className="space-y-1">
        <h1
          id="route-error-title"
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight outline-none"
        >
          {t("errors.pageTitle")}
        </h1>
        <p className="text-sm text-muted-foreground">{t(errorMessageKey(error))}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => void retry()} loading={retrying}>
          <RotateCw aria-hidden="true" />
          {t("actions.retry")}
        </Button>
        <Link to="/" className={buttonVariants({ variant: "outline" })}>
          <LayoutDashboard aria-hidden="true" />
          {t("actions.backHome")}
        </Link>
      </div>
      {detail ? (
        <Collapsible className="w-full text-left">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group mx-auto flex text-muted-foreground">
              {t("errors.details")}
              <ChevronDown
                className="transition-transform duration-150 group-data-[state=open]:rotate-180"
                aria-hidden="true"
              />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <pre className="mt-2 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words text-muted-foreground">
              {detail}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </section>
  );
}
