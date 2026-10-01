import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { queryKeys } from "@/lib/api";
import { useSession } from "@/lib/session";

import { fetchLicenseState, installLicenseKey, licenseKeys, removeLicenseKey } from "./api";
import type { LicenseState } from "./types";

/** The license state; only provider admins may read it. */
export function useLicenseState() {
  const { status, isProviderAdmin } = useSession();
  return useQuery({
    queryKey: licenseKeys.state,
    queryFn: fetchLicenseState,
    enabled: status === "authenticated" && isProviderAdmin,
    staleTime: 30_000,
  });
}

/**
 * Store a state the API returned and re-read what depends on the edition:
 * the profile (`/me` carries the edition and the enabled features, so menu
 * locks and gates follow) and every other cached answer that may differ now
 * (the tenant list and mailbox usage, provider keys, report catalog, ...).
 * Only the sign-in session and the public setup state stay as they are.
 */
function useApplyLicenseState() {
  const queryClient = useQueryClient();
  return React.useCallback(
    (state: LicenseState) => {
      queryClient.setQueryData(licenseKeys.state, state);
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const [head] = query.queryKey;
          return head !== "auth" && head !== "setup" && head !== licenseKeys.state[0];
        },
      });
    },
    [queryClient],
  );
}

export function useInstallLicense() {
  const apply = useApplyLicenseState();
  return useMutation({ mutationFn: installLicenseKey, onSuccess: apply });
}

export function useRemoveLicense() {
  const apply = useApplyLicenseState();
  return useMutation({ mutationFn: removeLicenseKey, onSuccess: apply });
}
