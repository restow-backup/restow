import { type Database, apiKeys, tenants, user } from "@restow/db";
import { type SQL, and, count, desc, eq, gt, isNull, or } from "drizzle-orm";
import { audit } from "../../lib/audit.js";
import { featureEnabled, requireFeature } from "../../lib/features.js";
import { type Transaction, withTenantTx } from "../../lib/tenant-context.js";
import { ProblemError } from "../../problem.js";
import type { CreateApiKeyInput } from "./schemas.js";
import { type ApiScope, normalizeScopes } from "./scopes.js";
import { type GeneratedApiKey, PROVIDER_KEY_TAG, generateApiKey, tenantKeyTag } from "./tokens.js";

/**
 * API key management: tenant keys (tenant admins, per tenant) and provider
 * keys (provider admins, while `apiKeys.provider` is on). A key's token is returned
 * once, on creation; afterwards only its prefix, scopes and usage are visible.
 * Revocation is soft so the audit trail keeps the key's identity. Every change
 * is audited in the same transaction.
 */

export const API_KEY_AUDIT_ACTIONS = {
  created: "api_key.created",
  revoked: "api_key.revoked",
} as const;

/** Active keys allowed per tenant, and provider keys per installation. */
export const MAX_ACTIVE_KEYS = 50;

const DAY_MS = 24 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";
const KEY_GENERATION_ATTEMPTS = 3;

export type ApiKeyKind = "tenant" | "provider";
export type ApiKeyStatus = "active" | "expired" | "revoked";

/** Where keys live: one tenant, or the installation (provider keys). */
export type KeyScope = { kind: "tenant"; tenantId: string } | { kind: "provider" };

/** A signed-in person managing keys (keys cannot manage keys). */
export interface KeyActor {
  userId: string;
  label: string;
  ip: string | null;
}

export interface ApiKeyDto {
  id: string;
  kind: ApiKeyKind;
  tenantId: string | null;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  status: ApiKeyStatus;
  createdAt: string;
  createdBy: { id: string; name: string; email: string } | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** The creation response: the key plus its token, shown this one time. */
export interface CreatedApiKeyDto extends ApiKeyDto {
  token: string;
}

export interface ProviderKeysDto {
  items: ApiKeyDto[];
  /** Provider keys can be created (`apiKeys.provider` is on). */
  available: boolean;
}

interface KeyRow {
  id: string;
  tenantId: string | null;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  creatorId: string | null;
  creatorName: string | null;
  creatorEmail: string | null;
}

// ---------------------------------------------------------------------------
// Pure mapping
// ---------------------------------------------------------------------------

export function keyStatus(row: Pick<KeyRow, "revokedAt" | "expiresAt">, now: Date): ApiKeyStatus {
  if (row.revokedAt !== null) {
    return "revoked";
  }
  if (row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime()) {
    return "expired";
  }
  return "active";
}

/** The expiry for a key created at `now` that lives `days` days (null: never). */
export function expiryFrom(days: number | null, now: Date): Date | null {
  return days === null ? null : new Date(now.getTime() + days * DAY_MS);
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function toApiKeyDto(row: KeyRow, now: Date): ApiKeyDto {
  return {
    id: row.id,
    kind: row.tenantId === null ? "provider" : "tenant",
    tenantId: row.tenantId,
    name: row.name,
    prefix: row.prefix,
    scopes: normalizeScopes(row.scopes),
    status: keyStatus(row, now),
    createdAt: row.createdAt.toISOString(),
    createdBy:
      row.creatorId !== null
        ? { id: row.creatorId, name: row.creatorName ?? "", email: row.creatorEmail ?? "" }
        : null,
    expiresAt: iso(row.expiresAt),
    lastUsedAt: iso(row.lastUsedAt),
    revokedAt: iso(row.revokedAt),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Run `fn` in the scope's transaction: tenant-pinned for tenant keys (RLS). */
function inScope<T>(db: Database, scope: KeyScope, fn: (tx: Transaction) => Promise<T>) {
  return scope.kind === "tenant" ? withTenantTx(db, scope.tenantId, fn) : db.transaction(fn);
}

function ownedBy(scope: KeyScope): SQL {
  return scope.kind === "tenant" ? eq(apiKeys.tenantId, scope.tenantId) : isNull(apiKeys.tenantId);
}

const keyColumns = {
  id: apiKeys.id,
  tenantId: apiKeys.tenantId,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  scopes: apiKeys.scopes,
  createdAt: apiKeys.createdAt,
  expiresAt: apiKeys.expiresAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
  creatorId: user.id,
  creatorName: user.name,
  creatorEmail: user.email,
};

async function selectKeys(tx: Transaction, where: SQL | undefined): Promise<KeyRow[]> {
  return tx
    .select(keyColumns)
    .from(apiKeys)
    .leftJoin(user, eq(user.id, apiKeys.createdBy))
    .where(where)
    .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
}

async function findKey(tx: Transaction, scope: KeyScope, id: string): Promise<KeyRow> {
  const [row] = await selectKeys(tx, and(ownedBy(scope), eq(apiKeys.id, id)));
  if (!row) {
    throw new ProblemError(404, "API key not found");
  }
  return row;
}

async function activeKeyCount(tx: Transaction, scope: KeyScope, now: Date): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(apiKeys)
    .where(
      and(
        ownedBy(scope),
        isNull(apiKeys.revokedAt),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now)),
      ),
    );
  return Number(row?.n ?? 0);
}

async function tagFor(tx: Transaction, scope: KeyScope): Promise<string> {
  if (scope.kind === "provider") {
    return PROVIDER_KEY_TAG;
  }
  const [tenant] = await tx
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, scope.tenantId))
    .limit(1);
  if (!tenant) {
    throw new ProblemError(404, "Tenant not found");
  }
  return tenantKeyTag(tenant.slug);
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } } | null;
  return (candidate?.code ?? candidate?.cause?.code) === UNIQUE_VIOLATION;
}

/**
 * Insert a fresh key. A prefix collision (8 base62 characters) is
 * astronomically unlikely but not impossible; each try runs in a savepoint so
 * a collision leaves the surrounding transaction usable.
 */
async function insertKey(
  tx: Transaction,
  tag: string,
  values: Omit<typeof apiKeys.$inferInsert, "prefix" | "keyHash">,
): Promise<{ id: string; generated: GeneratedApiKey }> {
  for (let attempt = 1; ; attempt++) {
    const generated = generateApiKey(tag);
    try {
      const [row] = await tx.transaction((savepoint) =>
        savepoint
          .insert(apiKeys)
          .values({ ...values, prefix: generated.prefix, keyHash: generated.hash })
          .returning({ id: apiKeys.id }),
      );
      if (!row) {
        throw new Error("api key insert returned no row");
      }
      return { id: row.id, generated };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= KEY_GENERATION_ATTEMPTS) {
        throw error;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function listKeys(
  db: Database,
  scope: KeyScope,
  now: Date = new Date(),
): Promise<ApiKeyDto[]> {
  const rows = await inScope(db, scope, (tx) => selectKeys(tx, ownedBy(scope)));
  return rows.map((row) => toApiKeyDto(row, now));
}

export async function listProviderKeys(
  db: Database,
  now: Date = new Date(),
): Promise<ProviderKeysDto> {
  return {
    items: await listKeys(db, { kind: "provider" }, now),
    available: await featureEnabled(db, "apiKeys.provider"),
  };
}

export async function createKey(
  db: Database,
  scope: KeyScope,
  input: CreateApiKeyInput,
  actor: KeyActor,
  now: Date = new Date(),
): Promise<CreatedApiKeyDto> {
  if (scope.kind === "provider") {
    await requireFeature(db, "apiKeys.provider");
  }
  return inScope(db, scope, async (tx) => {
    if ((await activeKeyCount(tx, scope, now)) >= MAX_ACTIVE_KEYS) {
      throw new ProblemError(409, "API key limit reached", {
        type: "urn:restow:problem:api-key-limit",
        detail: `At most ${MAX_ACTIVE_KEYS} active API keys are allowed. Revoke unused keys first.`,
        extensions: { limit: MAX_ACTIVE_KEYS },
      });
    }
    const tenantId = scope.kind === "tenant" ? scope.tenantId : null;
    const scopes = normalizeScopes(input.scopes);
    const expiresAt = expiryFrom(input.expiresInDays, now);
    const { id, generated } = await insertKey(tx, await tagFor(tx, scope), {
      tenantId,
      name: input.name,
      scopes,
      createdBy: actor.userId,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, {
      tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: API_KEY_AUDIT_ACTIONS.created,
      target: id,
      targetType: "api_key",
      ip: actor.ip,
      details: {
        name: input.name,
        prefix: generated.prefix,
        kind: scope.kind,
        scopes,
        expiresAt: iso(expiresAt),
      },
    });
    const row = await findKey(tx, scope, id);
    return { ...toApiKeyDto(row, now), token: generated.token };
  });
}

/** Revoke a key. Revoking an already revoked key changes nothing and is not audited again. */
export async function revokeKey(
  db: Database,
  scope: KeyScope,
  id: string,
  actor: KeyActor,
  now: Date = new Date(),
): Promise<ApiKeyDto> {
  return inScope(db, scope, async (tx) => {
    const existing = await findKey(tx, scope, id);
    if (existing.revokedAt !== null) {
      return toApiKeyDto(existing, now);
    }
    await tx
      .update(apiKeys)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(ownedBy(scope), eq(apiKeys.id, id)));
    await audit(tx, {
      tenantId: existing.tenantId,
      actor: actor.label,
      actorUserId: actor.userId,
      action: API_KEY_AUDIT_ACTIONS.revoked,
      target: id,
      targetType: "api_key",
      ip: actor.ip,
      details: { name: existing.name, prefix: existing.prefix, kind: scope.kind },
    });
    return toApiKeyDto({ ...existing, revokedAt: now }, now);
  });
}
