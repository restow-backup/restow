import { type ApiKeyContext, apiKeyActorLabel } from "../../middleware/apiKey.js";

/**
 * Who acts when an integration calls `/api/v1`: the API key, not a person.
 * The audit log names it `api-key:<id>` with the caller's IP; there is no
 * better-auth user behind it (`userId` null).
 *
 * The shape matches the actor of the jobs, directory and webhooks features
 * (`{ userId: string | null, label, ip }`), so their services take it as is.
 */
export interface KeyActor {
  userId: null;
  /** Audit label, `api-key:<id>`. */
  label: string;
  ip: string | null;
  keyId: string;
}

export function keyActor(key: Pick<ApiKeyContext, "keyId">, ip: string | null): KeyActor {
  return { userId: null, label: apiKeyActorLabel(key.keyId), ip, keyId: key.keyId };
}

/** The actor shape of the restore and verify features. */
export interface PersonActor {
  role: "tenant_admin";
  userId: string | null;
  email: string;
  ip: string | null;
}

/**
 * Hand a key actor to the restore and verify services. An API key is no
 * person: its restores and checks are stored without a better-auth user
 * (`restore_jobs.actor_user_id` and `audit_log.actor_user_id` stay null) and
 * with the key as the audit label (`email` is only used as that label and to
 * decide ownership, which a key never has, so every integration restore is
 * treated as one on the owner's behalf and needs a reason).
 */
export function asPersonActor(actor: KeyActor): PersonActor {
  return {
    role: "tenant_admin",
    userId: actor.userId,
    email: actor.label,
    ip: actor.ip,
  };
}
