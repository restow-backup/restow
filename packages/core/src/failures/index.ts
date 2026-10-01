/**
 * Failure explanations: what happened, why, and what to do.
 *
 * `classifyFailure` turns any error into a stable {@link FailureCause}; the
 * worker stores it as a {@link FailureRecord} next to the legacy error text;
 * the API adds the catalog's steps and retry advice; the UI and mails
 * translate the code. See ./types.ts for the vocabulary.
 */
export * from "./types.js";
export * from "./catalog.js";
export * from "./classify.js";
export * from "./graph.js";
export * from "./readiness.js";
export * from "./record.js";
export * from "./verification.js";
export * from "./redact.js";
