import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiFetch } from "@/lib/api";

/**
 * Client for Installation › Cluster (`apps/api/src/features/cluster`, docs/SIZING.md "Several
 * hosts: worker nodes"): the worker nodes, the requirements, one-time join tokens. The types
 * mirror the api's service by hand. Installation level: no tenant header. Owner only.
 */

export interface ClusterProcess {
  role: string;
  instanceId: string;
  version: string;
  alive: boolean;
  state: string | null;
  beatAt: string;
  startedAt: string;
}

export interface ClusterNode {
  /** null: the main host. */
  id: string | null;
  name: string;
  hostname: string | null;
  address: string | null;
  status: "main" | "active" | "removed";
  joinedAt: string | null;
  version: string | null;
  outdated: boolean;
  versionMismatch: boolean;
  processes: ClusterProcess[];
}

export interface ClusterTarget {
  tenantId: string | null;
  tenantName: string | null;
  targetId: string;
  kind: "s3" | "directory" | "volume";
  path: string | null;
}

export interface ClusterJoinToken {
  id: string;
  prefix: string;
  nodeName: string;
  expectedAddress: string | null;
  standbyScheduler: boolean;
  expiresAt: string;
  createdBy: { userId: string | null; email: string | null; ip: string | null };
}

export interface ClusterView {
  version: string;
  nodes: ClusterNode[];
  tokens: ClusterJoinToken[];
  targets: ClusterTarget[];
  joinBlocked: boolean;
  database: {
    address: string | null;
    ssl: boolean | null;
    nodeRules: { address: string | null; method: string | null; type: string }[];
    error: string | null;
  };
}

export interface CreatedJoinToken {
  id: string;
  /** Shown once: it is not stored, only its hash. */
  token: string;
  prefix: string;
  expiresAt: string;
}

export interface CreateJoinTokenInput {
  nodeName: string;
  expectedAddress?: string | null;
  ttlMinutes: number;
  standbyScheduler: boolean;
}

const BASE = "/cluster";
export const CLUSTER_QUERY_KEY = ["installation", "cluster"] as const;

/** Letters, digits and '-', what the node reports as its host name. */
export const NODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const JOIN_TOKEN_TTLS = [15, 60, 240, 1440] as const;

export function fetchCluster(): Promise<ClusterView> {
  return apiFetch<ClusterView>(BASE, { tenantId: null });
}

export function useCluster(enabled = true) {
  return useQuery({
    queryKey: CLUSTER_QUERY_KEY,
    queryFn: fetchCluster,
    enabled,
    refetchInterval: 30_000,
  });
}

export function useCreateJoinToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateJoinTokenInput) =>
      apiFetch<CreatedJoinToken>(`${BASE}/join-tokens`, {
        method: "POST",
        tenantId: null,
        body: {
          nodeName: input.nodeName,
          ttlMinutes: input.ttlMinutes,
          standbyScheduler: input.standbyScheduler,
          ...(input.expectedAddress ? { expectedAddress: input.expectedAddress } : {}),
        },
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: CLUSTER_QUERY_KEY }),
  });
}

export function useRevokeJoinToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${BASE}/join-tokens/${encodeURIComponent(id)}`, {
        method: "DELETE",
        tenantId: null,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: CLUSTER_QUERY_KEY }),
  });
}

export function useRemoveNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`${BASE}/nodes/${encodeURIComponent(id)}`, {
        method: "DELETE",
        tenantId: null,
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: CLUSTER_QUERY_KEY }),
  });
}

/** The command that makes another host a worker node with a join token. */
export function joinCommand(origin: string, token: string, nodeName: string): string {
  return `sudo bash install.sh --join ${origin} --join-token ${token} --node-name ${nodeName}`;
}
