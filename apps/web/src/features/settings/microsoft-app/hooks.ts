import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type AppTestResult,
  type MicrosoftAppView,
  type SaveMicrosoftAppInput,
  fetchMicrosoftApp,
  removeMicrosoftApp,
  saveMicrosoftApp,
  testMicrosoftApp,
} from "./api";

/**
 * TanStack Query wiring for the Microsoft 365 app registration. It is shared
 * by the settings page and the Microsoft 365 source page; a change also makes
 * the sources' Entra status and the mail settings (Graph sendMail) re-read.
 */

export const microsoftAppKey = ["settings", "microsoft-app"] as const;

/** Only provider admins may read it; pass `enabled: false` for everybody else. */
export function useMicrosoftApp(options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: microsoftAppKey,
    queryFn: fetchMicrosoftApp,
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}

/** Everything derived from the registration: source readiness per tenant, Graph mail. */
function invalidateDependents(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (query) => query.queryKey[2] === "sources" && query.queryKey[3] === "entra",
  });
  void queryClient.invalidateQueries({ queryKey: ["settings", "installation"] });
}

function useWriter() {
  const queryClient = useQueryClient();
  return (view: MicrosoftAppView) => {
    queryClient.setQueryData(microsoftAppKey, view);
    invalidateDependents(queryClient);
  };
}

export function useSaveMicrosoftApp() {
  const write = useWriter();
  return useMutation({
    mutationFn: (input: SaveMicrosoftAppInput) => saveMicrosoftApp(input),
    onSuccess: write,
  });
}

export function useRemoveMicrosoftApp() {
  const write = useWriter();
  return useMutation({ mutationFn: removeMicrosoftApp, onSuccess: write });
}

export function useTestMicrosoftApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tenantId: string | null) => testMicrosoftApp(tenantId),
    onSuccess: (result: AppTestResult) => {
      queryClient.setQueryData<MicrosoftAppView>(microsoftAppKey, (view) =>
        view ? { ...view, lastTest: result } : view,
      );
    },
  });
}
