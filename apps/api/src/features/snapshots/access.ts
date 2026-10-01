import { protectedObjects, users } from "@restow/db";
import { type SQL, eq, or, sql } from "drizzle-orm";
import type { Role } from "../../middleware/rbac.js";
import { isTenantAdmin } from "../../middleware/rbac.js";

/**
 * Self-service scoping: an end user sees and
 * restores only their own mailbox / OneDrive, admins see everything in the
 * tenant. Ownership is decided by e-mail: the signed-in identity (better-auth
 * user) matches a protected object when the directory user behind it, or the
 * object's own external id (a mailbox address), carries the same address.
 */

export interface Viewer {
  role: Role;
  /** The better-auth user; null for an integration (API key) acting as tenant admin. */
  userId: string | null;
  email: string;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether the viewer may see every protected object of the tenant. */
export function seesAllObjects(viewer: Pick<Viewer, "role">): boolean {
  return isTenantAdmin(viewer.role);
}

export interface OwnedObject {
  externalId: string;
  ownerEmail: string | null;
}

/** True when the object belongs to the viewer's own identity. */
export function isOwnObject(viewer: Pick<Viewer, "email">, object: OwnedObject): boolean {
  const email = normalizeEmail(viewer.email);
  if (email.length === 0) {
    return false;
  }
  if (object.ownerEmail && normalizeEmail(object.ownerEmail) === email) {
    return true;
  }
  return normalizeEmail(object.externalId) === email;
}

/**
 * True when the viewer may browse and restore the object. Admins always may;
 * end users only for their own objects.
 */
export function canAccessObject(viewer: Viewer, object: OwnedObject): boolean {
  return seesAllObjects(viewer) || isOwnObject(viewer, object);
}

/**
 * Whether a restore by this viewer of this object is an impersonation (an
 * admin acting for another person), which requires a reason and is audited
 * as such.
 */
export function isImpersonation(viewer: Viewer, object: OwnedObject): boolean {
  return !isOwnObject(viewer, object);
}

/**
 * The person whose data the viewer touches when it is not their own: the
 * owner's address, else the object's external id. Null for the viewer's own
 * objects. The audit log records it as `onBehalfOf`.
 */
export function onBehalfOfOwner(viewer: Pick<Viewer, "email">, object: OwnedObject): string | null {
  return isOwnObject(viewer, object) ? null : (object.ownerEmail ?? object.externalId);
}

/**
 * SQL filter for the viewer's visible protected objects. Queries using it must
 * LEFT JOIN `users` on `protected_objects.user_id` (the owner's directory row).
 * Returns null when no filter is needed (admins).
 */
export function visibleObjectsCondition(viewer: Viewer): SQL | null {
  if (seesAllObjects(viewer)) {
    return null;
  }
  const email = normalizeEmail(viewer.email);
  return or(
    eq(sql`lower(${users.email})`, email),
    eq(sql`lower(${protectedObjects.externalId})`, email),
  ) as SQL;
}
