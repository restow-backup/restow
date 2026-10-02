// Restow database schema (Drizzle ORM, PostgreSQL 16).
//
// Every tenant-scoped table carries `tenant_id` and is isolated by Row Level
// Security; the API sets `SET LOCAL app.tenant_id` per request. See sql/rls.sql
// for the RLS policies and the audit_log append-only trigger.
//
// better-auth owns its own tables — user, session, account, passkey,
// organization, member, invitation, twoFactor (two_factor), verification and
// rateLimit (rate_limit, the database-backed auth rate-limit counters).
// Those are GENERATED into ./auth.ts by the better-auth CLI (see the repo README /
// docs: `npx @better-auth/cli generate --config apps/api/dist/apps/api/src/auth.js --output
// packages/db/src/schema/auth.ts`) and re-exported here, so that both the Drizzle
// migrations (drizzle-kit) and the runtime fullSchema (createDb) cover them. Do not
// edit ./auth.ts by hand; re-generate it whenever the auth plugins change, and
// keep the one hand-kept index it documents (the user's Entra identity).
//
// Identities: whoever logs in (provider admin, tenant admin, end user via Entra
// SSO) is a better-auth `user`; a tenant is a better-auth `organization`
// (tenants.organization_id). Actor columns (audit_log.actor_user_id,
// restore_jobs.actor_user_id, legal_holds.created_by, api_keys.created_by) hold
// better-auth user ids (text). The Restow `users` table is the protection
// directory (Entra-synced people whose mailboxes/drives are protected).
//
// The tables below are Restow's domain model (tenants, secrets, sources, backup,
// manifest index, jobs, schedules, storage, audit, archive, integrations, system).

export * from "./auth.js";
export * from "./providers.js";
export * from "./provider-team.js";
export * from "./tenants.js";
export * from "./secrets.js";
export * from "./users.js";
export * from "./sources.js";
export * from "./backup.js";
export * from "./manifest.js";
export * from "./jobs.js";
export * from "./schedules.js";
export * from "./storage.js";
export * from "./audit.js";
export * from "./archive.js";
export * from "./apiKeys.js";
export * from "./webhooks.js";
export * from "./notifications.js";
export * from "./reports.js";
export * from "./imports.js";
export * from "./endpoints.js";
export * from "./backup-jobs.js";
export * from "./run-samples.js";
export * from "./system.js";
