/**
 * @restow/core — the open storage format and the engines built on it.
 *
 * Content-defined chunking, per-tenant crypto, the encrypted pack store, snapshot
 * manifests, storage backends and the Microsoft Graph client form the integrity
 * core of Restow; the format they define is documented in docs/ARCHITECTURE.md and
 * must be readable by the standalone restore in packages/cli.
 *
 * On top of it sit the engine framework (job contract, chunk writer/reader,
 * snapshot assembly), the Entra and directory layers, the backup and restore
 * engines per source kind, the recovery-readiness proof (verify, scrub), the
 * schedule model (cron, cadence, presets, recommended set) and the usage
 * figures. Each area keeps its public surface in its own index.ts.
 */

// Storage format
export * from "./crypto.js";
export * from "./keyprovider.js";
export * from "./chunker.js";
export * from "./chunkId.js";
export * from "./pack.js";
export * from "./manifest.js";

// Sealing of the encrypted secret store (installation key, row binding)
export * from "./secret-seal.js";

// Audit log hash chain (the math; each app owns its own storage)
export * from "./audit-chain.js";

// Storage targets
export * from "./storage/backend.js";
export * from "./storage/local.js";
export * from "./storage/s3.js";
export * from "./storage/factory.js";
export * from "./storage/installation-default.js";
export * from "./storage/copy.js";

// Engine framework
export * from "./engine/index.js";

// Outbound connections to tenant-configured hosts
export * from "./net/index.js";

// Microsoft Graph, Entra and the directory
export * from "./graph/index.js";
export * from "./entra/index.js";
export * from "./directory/index.js";

// Backup engines
export * from "./backup/exchange/index.js";
export * from "./backup/onedrive/index.js";
export * from "./backup/imap/index.js";

// Restore engines
export * from "./restore/index.js";

// Recovery readiness
export * from "./verify/index.js";

// Endpoint backup: the agent contract, the restic REST endpoint, restic on the server
export * from "./endpoints/index.js";

// Failure explanations: classified causes, redaction, what to do
export * from "./failures/index.js";

// Schedules
export * from "./schedule/index.js";
export * from "./reports/index.js";

// Backup snapshot retention (tiered keep rule, presets, run planning)
export * from "./retention/index.js";

// Backup jobs: schedules, the configuration written to machines, the migration, job retention
export * from "./backup-jobs/index.js";

// Archive: journal parsing, write-once item store, hash chain, retention math
export * as archive from "./archive/index.js";

// Mail file import and export: readers, staging store, import engine, export writers
export * as mailfiles from "./mailfiles/index.js";

// Usage figures: the rule for counting protected mailboxes
export * from "./usage/mailboxes.js";
