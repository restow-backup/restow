/**
 * Microsoft Graph layer of Restow: throttled client, per-tenant tokens, delta
 * synchronisation with 410 handling, and typed resource helpers for directory,
 * mail, calendar, contacts and OneDrive. Graph is the only Microsoft interface
 * (docs/MICROSOFT.md); nothing here talks EWS or PowerShell.
 */
export * from "./client.js";
export * from "./errors.js";
export * from "./delta.js";
export * from "./auth/token.js";
export * from "./resources/index.js";
