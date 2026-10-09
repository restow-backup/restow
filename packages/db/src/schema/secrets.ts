import { index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared.js";
import { tenants } from "./tenants.js";

/**
 * Well-known secret kinds. The column is plain text so a new kind never needs a
 * migration; the union documents the values Restow writes today and still
 * accepts any other string (`string & {}` keeps autocomplete without closing it).
 */
export type SecretKind =
  // The backup app registration entered in the web UI (installation level, one
  // sealed JSON document) and the result of its last connection test.
  | "entra_app"
  | "entra_app_test"
  // The installation default storage saved in the web UI (installation level, one
  // sealed JSON document with the addressing and, for S3, the key pair).
  | "default_storage"
  | "entra_client_secret"
  // A customer's own Graph app for one Microsoft 365 source (tenant level, one sealed JSON document).
  | "m365_app"
  | "imap_password"
  | "oauth_refresh_token"
  | "smtp_password"
  // The notification mail's own Microsoft 365 app registration (installation level,
  // one sealed JSON document like `m365_app`) and the Google Workspace service
  // account key (installation level, the key file's JSON).
  | "mail_graph_app"
  | "mail_google_key"
  // The access token for a private update source (installation level, one row).
  | "update_source_token"
  | "s3_credentials"
  | "webhook_signing_secret"
  // Proxmox VE (tenant level): a container's restic repository password, and an
  // existing PVE API token an admin handed to one enrollment (sealed JSON
  // {id, secret}; deleted once the node enrolled or the enrollment token ended).
  | "pve_ct_repository"
  | "pve_api_token"
  | (string & {});

/**
 * The encrypted secret store. Every `secret_ref` column elsewhere (sources,
 * protected_objects, storage_targets, webhooks) points here; the referencing row never carries the
 * secret itself. `ciphertext` is base64 of an AES-256-GCM blob produced by
 * @restow/core crypto:
 *   - tenant-scoped secrets (tenant_id set) are encrypted with the tenant DEK of
 *     `key_version` (see tenant_keys), so rotating a tenant key re-wraps them;
 *   - installation-level secrets (tenant_id null, e.g. the SMTP password) are
 *     encrypted with the master key (KEK) from the environment/KMS.
 * Plaintext never lands in this table or in logs.
 */
export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: "cascade" }),
    kind: text("kind").$type<SecretKind>().notNull(),
    ciphertext: text("ciphertext").notNull(),
    // Version of the DEK (tenant) or KEK (installation) that encrypted `ciphertext`.
    keyVersion: integer("key_version").notNull().default(1),
    ...timestamps(),
  },
  (t) => [index("secrets_tenant_kind_idx").on(t.tenantId, t.kind)],
);

export type Secret = typeof secrets.$inferSelect;
export type NewSecret = typeof secrets.$inferInsert;
