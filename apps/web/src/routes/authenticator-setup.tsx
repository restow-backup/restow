import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { LogOut, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { AuthLayout } from "@/components/layout/auth-layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { AuthenticatorSetup } from "@/features/settings/components/authenticator-setup";
import { errorMessageKey, queryKeys } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { HOME_PATH, LOGIN_PATH, safeRedirectTarget } from "@/lib/entry";
import { useSession } from "@/lib/session";

/**
 * Mandatory enrolment of the authenticator app. An account that signed in
 * with its emergency password alone lands here before anything else: the API
 * lets such a session enrol and nothing more (docs/ARCHITECTURE.md,
 * "Sicherheit"). Once the first code is confirmed the session is a full one
 * and the person continues where they wanted to go.
 */
export function AuthenticatorSetupPage() {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { redirect?: string };
  const { signOut } = useSession();
  const email = authClient.useSession().data?.user.email ?? null;
  const [signingOut, setSigningOut] = React.useState(false);

  const finish = async () => {
    // Confirming the code replaced the session; the guards read the new one.
    queryClient.removeQueries({ queryKey: queryKeys.authSession });
    queryClient.removeQueries({ queryKey: queryKeys.me });
    await navigate({ to: safeRedirectTarget(search.redirect) ?? HOME_PATH, replace: true });
  };

  const leave = async () => {
    setSigningOut(true);
    try {
      await signOut();
      await navigate({ to: LOGIN_PATH, replace: true });
    } catch (error) {
      toast.error(tc(errorMessageKey(error)));
      setSigningOut(false);
    }
  };

  return (
    <AuthLayout width="md">
      <Card>
        <CardHeader className="gap-3">
          <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">
              {t("authenticatorSetup.title")}
            </h1>
            <p className="text-sm text-muted-foreground">{t("authenticatorSetup.lead")}</p>
          </div>
        </CardHeader>
        <CardContent>
          <AuthenticatorSetup mode="enroll" onComplete={() => void finish()} />
        </CardContent>
        <CardFooter className="flex flex-col items-start gap-2 border-t border-border [.border-t]:pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="min-w-0 truncate text-xs text-muted-foreground">
            {email ? t("authenticatorSetup.signedInAs", { email }) : null}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void leave()}
            loading={signingOut}
            className="shrink-0"
          >
            {signingOut ? null : <LogOut />}
            {t("authenticatorSetup.signOut")}
          </Button>
        </CardFooter>
      </Card>
    </AuthLayout>
  );
}
