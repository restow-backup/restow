import { and, desc, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "./schema/index.js";
import { type SecretKind, secrets } from "./schema/secrets.js";

/**
 * Lookup of installation-level secrets (`secrets.tenant_id IS NULL`), shared by
 * the API and the worker. Those rows are hidden from tenant-pinned sessions by
 * Row Level Security, so the lookup runs on the installation pool
 * (DATABASE_PROVIDER_URL). Only the sealed ciphertext is returned; opening it is
 * @restow/core's job (secret-seal.ts).
 */

export interface InstallationSecretRow {
  id: string;
  kind: SecretKind;
  ciphertext: string;
  keyVersion: number;
  updatedAt: Date;
}

/** Anything that can run a select: the installation pool or a transaction on it. */
type Reader = Pick<NodePgDatabase<typeof schema>, "select">;

/** The newest installation-level secret of a kind, or null when there is none. */
export async function findInstallationSecret(
  db: Reader,
  kind: SecretKind,
): Promise<InstallationSecretRow | null> {
  const [row] = await db
    .select({
      id: secrets.id,
      kind: secrets.kind,
      ciphertext: secrets.ciphertext,
      keyVersion: secrets.keyVersion,
      updatedAt: secrets.updatedAt,
    })
    .from(secrets)
    .where(and(isNull(secrets.tenantId), eq(secrets.kind, kind)))
    .orderBy(desc(secrets.updatedAt))
    .limit(1);
  return row ?? null;
}
