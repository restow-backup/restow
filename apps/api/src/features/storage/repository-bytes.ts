import { endpoints, fileShares, pveGuests } from "@restow/db";
import { type AnyColumn, sql } from "drizzle-orm";
import type { Transaction } from "../../lib/tenant-context.js";

/**
 * The bytes the restic repositories of a tenant take, beside its chunk store: one per
 * machine (`endpoints.repository_bytes`), file share (`file_shares.repository_bytes`) and
 * Proxmox VE container (`pve_guests.repository_bytes`). The restic routes keep these
 * columns current with every upload and the worker measures them after a prune; a view
 * only adds them up and never lists a repository (it may live on NFS). A repository whose
 * size was never measured yet counts as zero until its next backup measures it.
 */
export interface RepositoryBytes {
  readonly endpoints: number;
  readonly fileShares: number;
  readonly pveGuests: number;
}

export const NO_REPOSITORY_BYTES: RepositoryBytes = { endpoints: 0, fileShares: 0, pveGuests: 0 };

export function totalRepositoryBytes(bytes: RepositoryBytes): number {
  return bytes.endpoints + bytes.fileShares + bytes.pveGuests;
}

const toNumber = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * The repository bytes of a tenant, inside the caller's tenant transaction. With `before`,
 * only the repositories of sources created before that moment count (a repository keeps
 * no history of its size: its current size stands for every moment).
 */
export async function loadRepositoryBytes(
  tx: Transaction,
  tenantId: string,
  before?: Date,
): Promise<RepositoryBytes> {
  const created = (column: AnyColumn) => (before ? sql`and ${column} < ${before}` : sql``);
  const result = await tx.execute(sql`
    select
      (select coalesce(sum(${endpoints.repositoryBytes}), 0)::float8 from ${endpoints}
        where ${endpoints.tenantId} = ${tenantId} ${created(endpoints.createdAt)}) as endpoints,
      (select coalesce(sum(${fileShares.repositoryBytes}), 0)::float8 from ${fileShares}
        where ${fileShares.tenantId} = ${tenantId} ${created(fileShares.createdAt)}) as file_shares,
      (select coalesce(sum(${pveGuests.repositoryBytes}), 0)::float8 from ${pveGuests}
        where ${pveGuests.tenantId} = ${tenantId} ${created(pveGuests.createdAt)}) as pve_guests`);
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;
  return {
    endpoints: toNumber(row.endpoints),
    fileShares: toNumber(row.file_shares),
    pveGuests: toNumber(row.pve_guests),
  };
}
