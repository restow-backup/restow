/**
 * Archive core: journal report parsing, the write-once encrypted item store
 * and its per-tenant hash chain, and pure retention math. Storage-independent
 * (docs/ARCHIVE.md, docs/ARCHITECTURE.md) — the SMTP journal receiver and
 * IMAP archiving (apps/worker, ARCHIVE-JOURNAL) build on this. See FORMAT.md
 * for the on-disk layout.
 */

export * from "./append.js";
export * from "./chain.js";
export * from "./format.js";
export * from "./identity.js";
export * from "./imap-capture.js";
export * from "./journal.js";
export * from "./journal-isolated.js";
export * from "./layout.js";
export * from "./memory.js";
export * from "./reader.js";
export * from "./retention.js";
export * from "./types.js";
export * from "./writer.js";
