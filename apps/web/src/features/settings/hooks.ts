import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { signInMethodsQueryOptions } from "@/lib/second-factor";
import {
  type InstallationSettings,
  type MailTestRequest,
  type SettingsPatch,
  deleteMailConfiguration,
  fetchPasskeyImpact,
  fetchPasskeyReadiness,
  fetchSettings,
  patchSettings,
  sendTestMail,
} from "./api";
import { type AuthClientError, type PasskeyRow, toPasskeyRows } from "./presenters";

/**
 * TanStack Query wiring for the settings page. Installation settings are not
 * tenant-scoped; the user's own passkeys live under the `auth` prefix so a
 * tenant switch does not refetch them.
 */

export const settingsKeys = {
  installation: ["settings", "installation"] as const,
  passkeyReadiness: ["settings", "passkey-readiness"] as const,
  passkeyImpact: ["settings", "passkey-impact"] as const,
  passkeys: ["auth", "passkeys"] as const,
};

export function useInstallationSettings() {
  return useQuery({
    queryKey: settingsKeys.installation,
    queryFn: fetchSettings,
    staleTime: 30_000,
  });
}

/** Store the fresh settings and let everything derived from them (setup state, gate) re-read. */
function useSettingsWriter() {
  const queryClient = useQueryClient();
  return (settings: InstallationSettings) => {
    queryClient.setQueryData(settingsKeys.installation, settings);
    void queryClient.invalidateQueries({ queryKey: queryKeys.setupState });
    void queryClient.invalidateQueries({ queryKey: settingsKeys.passkeyReadiness });
  };
}

export function useUpdateSettings() {
  const write = useSettingsWriter();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => patchSettings(patch),
    onSuccess: write,
  });
}

export function useRemoveMailConfiguration() {
  const write = useSettingsWriter();
  return useMutation({ mutationFn: deleteMailConfiguration, onSuccess: write });
}

export function useMailTest() {
  return useMutation({ mutationFn: (request: MailTestRequest) => sendTestMail(request) });
}

/** The passkey gate plus the server-side HTTPS probe; "check again" is a refetch. */
export function usePasskeyReadiness() {
  return useQuery({
    queryKey: settingsKeys.passkeyReadiness,
    queryFn: fetchPasskeyReadiness,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Asked only while the confirmation before switching passkeys off is open. */
export function usePasskeyImpact(enabled: boolean) {
  return useQuery({
    queryKey: settingsKeys.passkeyImpact,
    queryFn: fetchPasskeyImpact,
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/** A better-auth client failure carried through TanStack Query. */
export class AuthRequestError extends Error {
  readonly detail: AuthClientError;

  constructor(detail: AuthClientError) {
    super(detail.message ?? `Request failed with status ${detail.status}`);
    this.name = "AuthRequestError";
    this.detail = detail;
  }
}

export function usePasskeys() {
  return useQuery({
    queryKey: settingsKeys.passkeys,
    queryFn: async (): Promise<PasskeyRow[]> => {
      const { data, error } = await authClient.passkey.listUserPasskeys();
      if (error) {
        throw new AuthRequestError(error);
      }
      return toPasskeyRows(data ?? []);
    },
    staleTime: 60_000,
  });
}

export function useAddPasskey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const result = await authClient.passkey.addPasskey({ name });
      if (result.error) {
        throw new AuthRequestError(result.error);
      }
      return result.data;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKeys.passkeys }),
  });
}

export function useDeletePasskey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await authClient.passkey.deletePasskey({ id });
      if (error) {
        throw new AuthRequestError(error);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: settingsKeys.passkeys }),
  });
}

export function useRevokeOtherSessions() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await authClient.revokeOtherSessions();
      if (error) {
        throw new AuthRequestError(error);
      }
    },
  });
}

// --- Authenticator (TOTP) ---------------------------------------------------------------

/** How the signed-in account can sign in (whether it has an emergency password). */
export function useSignInMethods() {
  return useQuery(signInMethodsQueryOptions);
}

/** A started enrolment: the key for the authenticator app and the recovery codes. */
export interface AuthenticatorEnrollment {
  totpUri: string;
  backupCodes: string[];
}

async function enableAuthenticator(password: string): Promise<AuthenticatorEnrollment> {
  const { data, error } = await authClient.twoFactor.enable({ password });
  if (error) {
    throw new AuthRequestError(error);
  }
  if (!data || !("totpURI" in data) || !data.totpURI || !data.backupCodes) {
    throw new AuthRequestError({ status: 500, code: "TOTP_NOT_CONFIGURED" });
  }
  return { totpUri: data.totpURI, backupCodes: data.backupCodes };
}

/**
 * A new phone (apps/api lib/authenticator-replace.ts): the server keeps the
 * new key aside and the current authenticator keeps working until the first
 * code of the new one is confirmed.
 */
async function startReplacement(password: string): Promise<AuthenticatorEnrollment> {
  const { data, error } = await authClient.$fetch<{ totpURI: string; backupCodes: string[] }>(
    "/two-factor/replace",
    { method: "POST", body: { password } },
  );
  if (error) {
    throw new AuthRequestError(error);
  }
  if (!data?.totpURI || !data.backupCodes) {
    throw new AuthRequestError({ status: 500, code: "TOTP_NOT_CONFIGURED" });
  }
  return { totpUri: data.totpURI, backupCodes: data.backupCodes };
}

/** Start the enrolment, or with `replace` the move to a new phone. */
export function useStartAuthenticatorEnrollment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ password, replace }: { password: string; replace: boolean }) =>
      replace ? startReplacement(password) : enableAuthenticator(password),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.authSession }),
  });
}

/**
 * Confirm with the first code from the app: this switches the second factor
 * on, or with `replace` swaps the old key for the new one.
 */
export function useConfirmAuthenticator() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ code, replace }: { code: string; replace: boolean }) => {
      const { error } = replace
        ? await authClient.$fetch("/two-factor/replace/confirm", {
            method: "POST",
            body: { code },
          })
        : await authClient.twoFactor.verifyTotp({ code });
      if (error) {
        throw new AuthRequestError(error);
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.authSession }),
  });
}

/** Replace the recovery codes; the previous ones stop working. */
export function useRegenerateBackupCodes() {
  return useMutation({
    mutationFn: async (password: string): Promise<string[]> => {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
      if (error) {
        throw new AuthRequestError(error);
      }
      return data?.backupCodes ?? [];
    },
  });
}
