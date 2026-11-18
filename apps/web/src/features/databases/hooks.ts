import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { formatBytes, formatDateTime } from "@/lib/format";
import { useSession } from "@/lib/session";

import {
  type CreateConnectionInput,
  createConnection,
  databaseKeys,
  deleteConnection,
  fetchBackups,
  fetchConnection,
  fetchConnectionHealth,
  fetchConnections,
  fetchDatabase,
  fetchDatabaseSizes,
  fetchDatabases,
  fetchProbe,
  fetchRunners,
  fetchRuns,
  fetchSuggestions,
  type RestoreInput,
  requestBackup,
  requestRestore,
  type TestConnectionInput,
  testConnection,
  testStoredConnection,
  type UpdateConnectionInput,
  updateConnection,
} from "./api.js";

/**
 * Queries and mutations of the database pages. Keys carry the tenant, so a tenant switch never
 * shows another tenant's connections. A test an agent runs is asked for every few seconds until
 * it has an answer (the agent fetches it with its next heartbeat, within five minutes).
 */

export const PROBE_POLL_MS = 3_000;
const IDLE_REFRESH_MS = 60_000;

/** Locale-bound formatters and the `databases` texts. */
export function useDbFormat() {
  const { t, i18n } = useTranslation("databases");
  const language = i18n.resolvedLanguage ?? i18n.language;
  return React.useMemo(
    () => ({
      t,
      language,
      bytes: (value: number | null) => (value === null ? null : formatBytes(value, language)),
      dateTime: (value: string | null | undefined) => formatDateTime(value, language),
    }),
    [t, language],
  );
}

export type DbFormat = ReturnType<typeof useDbFormat>;

function useTenantScope() {
  const { status, activeTenant } = useSession();
  return {
    tenantId: activeTenant?.id ?? null,
    enabled: status === "authenticated" && activeTenant !== null,
  };
}

export function useDatabases() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.list(tenantId),
    queryFn: fetchDatabases,
    enabled,
    refetchInterval: IDLE_REFRESH_MS,
  });
}

export function useDatabase(id: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.detail(tenantId, id),
    queryFn: () => fetchDatabase(id),
    enabled,
  });
}

export function useConnections() {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.connections(tenantId),
    queryFn: fetchConnections,
    enabled,
    refetchInterval: IDLE_REFRESH_MS,
  });
}

export function useConnection(id: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.connection(tenantId, id),
    queryFn: () => fetchConnection(id),
    enabled,
  });
}

/** The health history of a connection (8); refreshed with the list's rhythm. */
export function useConnectionHealth(id: string, days: number) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.connectionHealth(tenantId, id, days),
    queryFn: () => fetchConnectionHealth(id, days),
    enabled,
    refetchInterval: IDLE_REFRESH_MS,
  });
}

/** The size of a database day by day (8). */
export function useDatabaseSizes(id: string, days: number) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.sizes(tenantId, id, days),
    queryFn: () => fetchDatabaseSizes(id, days),
    enabled,
  });
}

export function useSuggestions(enabledForRole: boolean) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.suggestions(tenantId),
    queryFn: fetchSuggestions,
    enabled: enabled && enabledForRole,
  });
}

export function useRunners(open: boolean) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.runners(tenantId),
    queryFn: fetchRunners,
    enabled: enabled && open,
  });
}

/** A test that is still waiting for its agent is asked for again until it has an answer. */
export function useProbe(probeId: string | null) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.probe(tenantId, probeId ?? "none"),
    queryFn: () => fetchProbe(probeId as string),
    enabled: enabled && probeId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "pending" || status === "running" ? PROBE_POLL_MS : false;
    },
  });
}

function useInvalidate() {
  const client = useQueryClient();
  const { tenantId } = useTenantScope();
  return () => client.invalidateQueries({ queryKey: databaseKeys.all(tenantId) });
}

export function useTestConnection() {
  return useMutation({ mutationFn: (input: TestConnectionInput) => testConnection(input) });
}

export function useTestStoredConnection(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => testStoredConnection(id),
    onSuccess: () => void invalidate(),
  });
}

export function useCreateConnection() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateConnectionInput) => createConnection(input),
    onSuccess: () => void invalidate(),
  });
}

export function useUpdateConnection(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateConnectionInput) => updateConnection(id, input),
    onSuccess: () => void invalidate(),
  });
}

export function useDeleteConnection(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => deleteConnection(id),
    onSuccess: () => void invalidate(),
  });
}

export function useDatabaseBackups(id: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.backups(tenantId, id),
    queryFn: () => fetchBackups(id),
    enabled,
    refetchInterval: IDLE_REFRESH_MS,
  });
}

export function useConnectionRuns(connectionId: string) {
  const { tenantId, enabled } = useTenantScope();
  return useQuery({
    queryKey: databaseKeys.runs(tenantId, connectionId),
    queryFn: () => fetchRuns(connectionId),
    enabled,
    refetchInterval: IDLE_REFRESH_MS,
  });
}

export function useRequestBackup(id: string) {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: () => requestBackup(id), onSuccess: () => void invalidate() });
}

export function useRequestRestore(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: RestoreInput) => requestRestore(id, input),
    onSuccess: () => void invalidate(),
  });
}
