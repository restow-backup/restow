import { type ErrorComponentProps, Outlet, useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { StandaloneErrorPage } from "@/components/layout/standalone-error";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { Wordmark } from "@/components/wordmark";
import { phoneGateFor } from "@/lib/device";
import { useIsDemo, useIsPhone } from "@/lib/use-phone";
import { PhoneBlockPage } from "@/routes/phone-blocked";

/**
 * Root layout: the outermost frame shared by every route. On a phone the
 * block page takes the place of the route (lib/device.ts): here and not as a
 * redirect, so the address stays for the computer it is copied to, and one
 * place covers the sign-in, the setup and the app alike.
 */
export function RootLayout() {
  const phone = useIsPhone();
  const demo = useIsDemo();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const redirect = useRouterState({
    select: (state) => (state.location.search as { redirect?: unknown }).redirect,
  });
  const gate = phoneGateFor({
    pathname,
    redirect: typeof redirect === "string" ? redirect : null,
    phone,
    demo,
  });
  return (
    <div className="min-h-svh bg-background text-foreground antialiased">
      {gate ? <PhoneBlockPage gate={gate} /> : <Outlet />}
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
