import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, Compass, LayoutDashboard } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePublishedTitle } from "@/components/kit/page-context";
import { AuthLayout } from "@/components/layout/auth-layout";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * Unknown address inside the shell (the catch-all route): what happened, the
 * address that was asked for, and the ways on. The title reaches the
 * breadcrumbs and the browser tab like any page header.
 */
export function NotFoundPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  usePublishedTitle(t("notFound.title"), t("app.name"));

  return (
    <section
      aria-labelledby="not-found-title"
      className="mx-auto flex max-w-xl flex-col items-center gap-4 py-12 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Compass className="size-6" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <h1
          id="not-found-title"
          tabIndex={-1}
          className="text-xl font-semibold tracking-tight outline-none"
        >
          {t("notFound.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("notFound.description")}</p>
        <p className="font-mono text-xs break-all text-muted-foreground">{pathname}</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {router.history.canGoBack() ? (
          <Button variant="outline" onClick={() => router.history.back()}>
            <ArrowLeft aria-hidden="true" />
            {t("actions.goBack")}
          </Button>
        ) : null}
        <Link to="/" className={buttonVariants()}>
          <LayoutDashboard aria-hidden="true" />
          {t("actions.backHome")}
        </Link>
      </div>
    </section>
  );
}

/** Not-found outside the shell (rendered by the root route), in the auth frame. */
export function RootNotFoundPage() {
  return (
    <AuthLayout>
      <NotFoundPage />
    </AuthLayout>
  );
}
