import { type ErrorComponentProps, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { StandaloneErrorPage } from "@/components/layout/standalone-error";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { Wordmark } from "@/components/wordmark";

/** Root layout: the outermost frame shared by every route. */
export function RootLayout() {
  return (
    <div className="min-h-svh bg-background text-foreground antialiased">
      <Outlet />
      <Toaster />
    </div>
  );
}

/** Shown while the root guard fetches the installation state (before any layout is known). */
export function RootPendingPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4 bg-muted/40">
      <Wordmark className="text-lg" />
      <Spinner label={t("loading.label")} />
    </div>
  );
}

/**
 * Shown when the root guard fails, typically because the API is down. Retry
 * re-runs the loaders; nothing is hidden behind a generic message.
 */
export function RootErrorPage({ error, reset }: ErrorComponentProps) {
  const { t } = useTranslation();
  return <StandaloneErrorPage title={t("errors.shellTitle")} error={error} reset={reset} />;
}
