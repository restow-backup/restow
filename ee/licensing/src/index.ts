/**
 * License keys for the Business and Service Provider modules: editions, the
 * capability table, offline verification of Ed25519-signed keys against the
 * embedded verification key, and the installed license as stored. Shared by
 * ee/api and ee/worker (relative imports, compiled into the app that loads
 * them). The core (apps/, packages/) knows nothing of any of it.
 *
 * Issuing keys is not part of this repository; tests sign with a throwaway key
 * (../testing/test-signer.mjs).
 */
export * from "./capabilities.js";
export * from "./editions.js";
export * from "./public-key.js";
export * from "./store.js";
export * from "./token.js";
