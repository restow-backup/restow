import {
  deleteProviderSecrets,
  findProviderSecret,
  readSecret,
  upsertProviderSecret,
} from "../../lib/secrets.js";
import type { DbExecutor } from "../../lib/tenant-context.js";

/**
 * The access token for a private update source, kept in the encrypted secret
 * store (lib/secrets.ts, installation level, kind `update_source_token`): never
 * in a table column, a log line, an audit entry or an API response. It is sealed
 * together with the origin it was issued for, and it is only ever sent to that
 * origin: pointing the source at another host does not leak it there.
 */

export const UPDATE_TOKEN_KIND = "update_source_token";

interface SealedToken {
  origin: string;
  token: string;
}

/** Store or replace the token, bound to the origin of the source it is for. */
export async function storeToken(db: DbExecutor, origin: string, token: string): Promise<void> {
  const sealed: SealedToken = { origin, token };
  await upsertProviderSecret(db, UPDATE_TOKEN_KIND, JSON.stringify(sealed));
}

export async function removeToken(db: DbExecutor): Promise<boolean> {
  return (await deleteProviderSecrets(db, UPDATE_TOKEN_KIND)) > 0;
}

/** Whether a token is stored (its value stays sealed). */
export async function hasToken(db: DbExecutor): Promise<boolean> {
  return (await findProviderSecret(db, UPDATE_TOKEN_KIND)) !== null;
}

async function readSealed(db: DbExecutor): Promise<SealedToken | null> {
  const ref = await findProviderSecret(db, UPDATE_TOKEN_KIND);
  if (!ref) {
    return null;
  }
  const plaintext = await readSecret(db, ref);
  if (!plaintext) {
    return null;
  }
  try {
    const parsed = JSON.parse(plaintext) as Partial<SealedToken>;
    return typeof parsed.token === "string" && typeof parsed.origin === "string"
      ? { origin: parsed.origin, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

/** The token when one is stored for exactly this origin, else null. */
export async function tokenFor(db: DbExecutor, origin: string): Promise<string | null> {
  const sealed = await readSealed(db);
  return sealed && sealed.origin === origin ? sealed.token : null;
}

/** The origin the stored token is bound to, without opening more than needed. */
export async function tokenOrigin(db: DbExecutor): Promise<string | null> {
  return (await readSealed(db))?.origin ?? null;
}
