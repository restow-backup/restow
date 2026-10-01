import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useSignOut } from "@/components/layout/use-sign-out";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  DISCLAIMER_VERSION_PROBLEM,
  type SetupState,
  acceptInstallationDisclaimer,
  queryKeys,
  setupStateQueryOptions,
} from "@/lib/api";
import { providerMay } from "@/lib/provider-role";
import { type SessionContextValue, useSession } from "@/lib/session";

import { DisclaimerNotice } from "./disclaimer-notice";

/**
 * Whether the notice has to be shown now: the installation is set up, the
 * current version of the text is not accepted, and the person is a provider
 * admin, the operator who can accept it. Tenant admins and members are never
 * held up by it, and the server keeps every job and integration running
 * meanwhile: only the operator's own console asks.
 */
export function shouldAskForDisclaimer(
  state: Pick<SetupState, "configured" | "disclaimer"> | undefined,
  isProviderAdmin: boolean,
): boolean {
  return Boolean(state?.configured && !state.disclaimer.accepted && isProviderAdmin);
}

/**
 * Whether this provider admin may accept the notice: owners and administrators
 * of the provider team (the API answers 403 to technicians and read-only
 * members). Everyone else is told to ask one of them.
 */
export function mayAcceptDisclaimer(
  session: Pick<SessionContextValue, "isProviderAdmin" | "providerRole" | "providerAllTenants">,
): boolean {
  return providerMay(session, "administrator");
}

/**
 * The blocking dialog of an installation that was set up before the operator
 * responsibility notice existed, or whose text changed since it was accepted:
 * the provider admin reads it, ticks the box and accepts; the server records
 * who, when and from where (apps/api lib/disclaimer.ts). It cannot be
 * dismissed; signing out is the only other way out.
 */
export function DisclaimerDialog() {
  const { t } = useTranslation("setup");
  const queryClient = useQueryClient();
  const session = useSession();
  const { isProviderAdmin } = session;
  const { data: state } = useQuery(setupStateQueryOptions);
  const { signOut, signingOut } = useSignOut();
  const [checked, setChecked] = React.useState(false);

  const version = state?.disclaimer.version ?? "";
  const mutation = useMutation({
    mutationFn: () => acceptInstallationDisclaimer(version),
    onSuccess: () => {
      queryClient.setQueryData<SetupState>(queryKeys.setupState, (previous) =>
        previous
          ? { ...previous, disclaimer: { ...previous.disclaimer, accepted: true } }
          : previous,
      );
    },
  });

  const open = shouldAskForDisclaimer(state, isProviderAdmin);
  if (!open) {
    return null;
  }

  if (!mayAcceptDisclaimer(session)) {
    // A technician or read-only member cannot accept for the operator: say who
    // can, and leave signing out as the way on.
    return (
      <AlertDialog open>
        <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("disclaimer.existing.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("disclaimer.existing.needAdministrator")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button type="button" onClick={() => void signOut()} loading={signingOut}>
              {t("disclaimer.existing.signOut")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  const versionChanged =
    mutation.error instanceof ApiError &&
    mutation.error.problem?.type === DISCLAIMER_VERSION_PROBLEM;

  return (
    <AlertDialog open>
      <AlertDialogContent
        // Not dismissable: no outside click and no Escape (the dialog stays open either way).
        onEscapeKeyDown={(event) => event.preventDefault()}
        className="max-h-[90svh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl"
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("disclaimer.existing.title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("disclaimer.existing.description")}</AlertDialogDescription>
        </AlertDialogHeader>

        {/* The text scrolls, the buttons stay in reach. */}
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <DisclaimerNotice
            version={version}
            checked={checked}
            onCheckedChange={setChecked}
            disabled={mutation.isPending}
            idPrefix="existing-disclaimer"
          />

          {mutation.isError ? (
            <Alert variant={versionChanged ? "warning" : "destructive"}>
              <TriangleAlert />
              <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                <span>
                  {versionChanged ? t("disclaimer.versionChanged") : t("disclaimer.failed")}
                </span>
                {versionChanged ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => window.location.reload()}
                  >
                    {t("disclaimer.reload")}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <AlertDialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => void signOut()}
            disabled={mutation.isPending}
            loading={signingOut}
          >
            {t("disclaimer.existing.signOut")}
          </Button>
          <Button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!checked || signingOut}
            loading={mutation.isPending}
          >
            {t("disclaimer.existing.accept")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
