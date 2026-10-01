import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { AlertTriangle, RotateCw } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { AuthLayout } from "@/components/layout/auth-layout";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessageKey } from "@/lib/api";

interface StandaloneErrorPageProps {
  title: string;
  error: unknown;
  /** Clears the error boundary so the route renders again. */
  reset?: () => void;
}

/**
 * A failure outside the shell (the API is down, the profile could not be
 * read): the cause in plain words and a retry, which re-runs the route
 * guards and loaders. Nothing is hidden behind a generic message.
 */
export function StandaloneErrorPage({ title, error, reset }: StandaloneErrorPageProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [retrying, setRetrying] = React.useState(false);

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
    <AuthLayout>
      <Card role="alert">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 shrink-0 text-destructive" aria-hidden="true" />
            <h1 className="text-base font-semibold">{title}</h1>
          </CardTitle>
          <CardDescription>{t(errorMessageKey(error))}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={() => void retry()} loading={retrying}>
            <RotateCw aria-hidden="true" />
            {t("actions.retry")}
          </Button>
          {pathname === "/" ? null : (
            <Link to="/" className={buttonVariants({ variant: "outline" })}>
              {t("actions.backHome")}
            </Link>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
}
