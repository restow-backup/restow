import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { toast } from "@/components/ui/sonner";
import { errorMessageKey } from "@/lib/api";
import { LOGIN_PATH } from "@/lib/entry";
import { useSession } from "@/lib/session";

/**
 * Sign out and land on the login page; a failure stays on the page with a
 * toast naming the cause. Shared by the user menu and the command palette.
 */
export function useSignOut(): { signOut: () => Promise<void>; signingOut: boolean } {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { signOut: endSession } = useSession();
  const [signingOut, setSigningOut] = React.useState(false);

  const signOut = React.useCallback(async () => {
    setSigningOut(true);
    try {
      await endSession();
      await navigate({ to: LOGIN_PATH });
    } catch (error) {
      toast.error(t(errorMessageKey(error)));
      setSigningOut(false);
    }
  }, [endSession, navigate, t]);

  return { signOut, signingOut };
}
