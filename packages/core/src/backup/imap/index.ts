/**
 * IMAP backup engine: incremental, byte-exact mailbox backups over imapflow
 * (docs/IMAP.md). Restore reads the same manifest layout (./paths.ts).
 */
export * from "./types.js";
export * from "./paths.js";
export * from "./planning.js";
export * from "./oauth2.js";
export * from "./connections.js";
export * from "./dedup.js";
export * from "./gate.js";
export * from "./imapflow-connector.js";
export * from "./engine.js";
