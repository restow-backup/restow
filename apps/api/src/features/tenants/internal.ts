import { type Database, type Tenant, tenants } from "@restow/db";
import { and, eq, ne, sql } from "drizzle-orm";
import { AUDIT_ACTIONS, audit } from "../../lib/audit.js";
import { featureEnabled } from "../../lib/features.js";
import { ProblemError } from "../../problem.js";
import type { CreateInternalTenantInput, MarkInternalTenantInput } from "./schemas.js";
import {
  type Actor,
  INTERNAL_TENANT_UNIQUE_INDEX,
  type TenantDto,
  createTenant,
  internalTenantExistsProblem,
  isUniqueViolation,
  notFound,
  slugTaken,
  toDto,
} from "./service.js";
import { availableSlug } from "./slug.js";

/**
 * The operator's own organisation, between the installation and the customers'
 * tenants. It is a tenant with `kind = 'internal'`: its own
 * mailboxes, servers and storage, kept apart from the customers' tenants. At
 * most one exists (`tenants_internal_uq`, packages/db schema/tenants.ts).
 *
 * It comes into being in one of three ways:
 *
 *   - the setup wizard creates it from the name the operator gives
 *     ({@link ensureOwnOrganisation});
 *   - a provider admin creates it later, or marks an existing tenant as it
 *     ({@link createInternalTenant}, {@link markTenantInternal}), which is what an
 *     installation set up before this existed does once;
 *   - on an installation that can have only one tenant, the api marks that
 *     tenant when it starts ({@link adoptSoleTenantAsInternal}).
 *
 * The core knows nothing about editions: whether the installation may have
 * more than one tenant is the feature gate's answer (`tenants.additional`,
 * lib/features.ts).
 */

/** A tenant's language: `de` or `en` (`tenants.language`, null defers to the installation default). */
type TenantLanguage = NonNullable<Tenant["language"]>;

/** Serializes everything that decides which tenant is the own organisation. */
const OWN_ORGANISATION_LOCK = "restow.own-organisation";

/** The installation's own organisation, or null. Spans tenants: the installation pool. */
export async function findInternalTenant(providerDb: Database): Promise<Tenant | null> {
  const [row] = await providerDb
    .select()
    .from(tenants)
    .where(eq(tenants.kind, "internal"))
    .limit(1);
  return row ?? null;
}

/**
 * Create the own organisation: a tenant of kind `internal` named `input.name`
 * (the slug follows the name unless one is given), with the key, the alert
 * rules and the audit entry every tenant gets (`createTenant`). `alertEmail`,
 * when given, receives the alerts for failed jobs and for data that is not
 * proven restorable. `language`, when given, is the tenant's language, which its
 * mails and reports follow and the alert rules' names are written in; without it
 * the tenant defers to the installation default. Refused with 409 while another tenant is the own
 * organisation. Like every first tenant it needs no `tenants.additional`; a
 * further tenant, this one included, does.
 */
export async function createInternalTenant(
  db: Database,
  providerDb: Database,
  input: CreateInternalTenantInput,
  actor: Actor,
  options: { alertEmail?: string; language?: TenantLanguage } = {},
): Promise<TenantDto> {
  const slug =
    input.slug ?? (await availableSlug(input.name, (slug) => slugTaken(providerDb, slug)));
  return createTenant(
    db,
    providerDb,
    {
      name: input.name,
      slug,
      ...(options.language ? { customer: { language: options.language } } : {}),
      ...(options.alertEmail
        ? {
            notificationRecipients: [
              { email: options.alertEmail, categories: ["jobFailures", "readinessRed"] },
            ],
          }
        : {}),
    },
    actor,
    { kind: "internal" },
  );
}

/** Calls of {@link ensureOwnOrganisation} wait for each other. */
let ownOrganisationQueue: Promise<void> = Promise.resolve();

/**
 * What the setup wizard does after its transaction committed: make sure the
 * installation has its own organisation, named after the operator's
 * organisation and in the language the operator chose. Idempotent: an
 * installation that has one already (a repeated call, a concurrent one) keeps
 * it and gets no second.
 */
export async function ensureOwnOrganisation(
  db: Database,
  providerDb: Database,
  input: { name: string; alertEmail: string; language?: TenantLanguage },
  actor: Actor,
): Promise<{ tenant: TenantDto; created: boolean }> {
  // One at a time in this process: the organization behind the tenant is created
  // before its row, so a second caller could otherwise fail on the first one's
  // slug before the first one's tenant exists. (The setup itself is serialized
  // across processes, routes/setup.ts; the database's unique index backs the rest.)
  const run = ownOrganisationQueue.then(async () => {
    const existing = await findInternalTenant(providerDb);
    if (existing) {
      return { tenant: toDto(existing), created: false };
    }
    const tenant = await createInternalTenant(db, providerDb, { name: input.name }, actor, {
      alertEmail: input.alertEmail,
      ...(input.language ? { language: input.language } : {}),
    });
    return { tenant, created: true };
  });
  ownOrganisationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Make an existing tenant the own organisation. Without one, that is all it
 * does. While another tenant is it, `confirmSwitch` moves the mark: the other
 * becomes a customer again, both changes in one transaction and both audited.
 * Marking the tenant that already is the own organisation changes nothing.
 * The installation pool: the switch spans two tenants.
 */
export async function markTenantInternal(
  providerDb: Database,
  id: string,
  input: MarkInternalTenantInput,
  actor: Actor,
): Promise<TenantDto> {
  return providerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${OWN_ORGANISATION_LOCK}))`);
    const [target] = await tx.select().from(tenants).where(eq(tenants.id, id)).limit(1);
    if (!target) {
      throw notFound();
    }
    if (target.status === "deleting") {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    if (target.kind === "internal") {
      return toDto(target);
    }
    const [current] = await tx.select().from(tenants).where(eq(tenants.kind, "internal")).limit(1);
    if (current && !input.confirmSwitch) {
      throw internalTenantExistsProblem(current);
    }
    if (current) {
      await tx.update(tenants).set({ kind: "customer" }).where(eq(tenants.id, current.id));
      await audit(tx, {
        tenantId: current.id,
        actor: actor.email,
        actorUserId: actor.id,
        action: AUDIT_ACTIONS.tenantInternalUnmarked,
        target: current.id,
        targetType: "tenant",
        ip: actor.ip,
        details: { replacedBy: target.id },
      });
    }
    let row: Tenant | undefined;
    try {
      // Not a tenant that is being deleted, checked by the update itself: a deletion
      // that committed between the read above and this statement still wins.
      [row] = await tx
        .update(tenants)
        .set({ kind: "internal" })
        .where(and(eq(tenants.id, id), ne(tenants.status, "deleting")))
        .returning();
    } catch (error) {
      if (isUniqueViolation(error, INTERNAL_TENANT_UNIQUE_INDEX)) {
        throw internalTenantExistsProblem(null);
      }
      throw error;
    }
    if (!row) {
      throw new ProblemError(409, "Tenant is being deleted");
    }
    await audit(tx, {
      tenantId: id,
      actor: actor.email,
      actorUserId: actor.id,
      action: AUDIT_ACTIONS.tenantInternalMarked,
      target: id,
      targetType: "tenant",
      ip: actor.ip,
      details: { via: "api", previousTenantId: current?.id ?? null },
    });
    return toDto(row);
  });
}

/**
 * The step an installation takes once after it was updated from a release
 * that knew no own organisation: when it can have only one tenant
 * (`tenants.additional` off) and has exactly one that is not being deleted,
 * that tenant is the operator's own organisation, so it is marked as such. An
 * installation that can have several tenants is left alone: which of them, if
 * any, is the operator's own is the provider admin's decision (the dashboard
 * asks, `markTenantInternal`). Nothing happens when an own organisation
 * exists already, so running it again, at every start, changes nothing.
 *
 * Returns the tenant it marked, or null when it did nothing. The entry in the
 * tenant's audit log names the step ("system", `via: "update"`).
 */
export async function adoptSoleTenantAsInternal(
  db: Database,
  providerDb: Database,
): Promise<TenantDto | null> {
  if (await featureEnabled(db, "tenants.additional")) {
    return null;
  }
  return providerDb.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${OWN_ORGANISATION_LOCK}))`);
    const candidates = await tx.select().from(tenants).where(ne(tenants.status, "deleting"));
    const [only] = candidates;
    if (candidates.length !== 1 || !only || only.kind === "internal") {
      return null;
    }
    // A tenant that is being deleted never was the own organisation (that is refused), but
    // the unique index decides on every row: look at all of them.
    const [internal] = await tx
      .select({ id: tenants.id })
      .from(tenants)
      .where(and(eq(tenants.kind, "internal"), ne(tenants.id, only.id)))
      .limit(1);
    if (internal) {
      return null;
    }
    const [row] = await tx
      .update(tenants)
      .set({ kind: "internal" })
      .where(eq(tenants.id, only.id))
      .returning();
    if (!row) {
      return null;
    }
    await audit(tx, {
      tenantId: row.id,
      actor: "system",
      action: AUDIT_ACTIONS.tenantInternalMarked,
      target: row.id,
      targetType: "tenant",
      details: { via: "update", reason: "single_tenant_installation" },
    });
    return toDto(row);
  });
}
