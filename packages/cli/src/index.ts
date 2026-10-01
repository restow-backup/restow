/**
 * @restow/cli — the standalone restore.
 *
 * The command-line entry point lives in `restow-restore.ts` (the `restow-restore`
 * bin) and runs the commands of `cli.ts`. This module re-exports the reusable
 * pieces so the reassembly logic can be driven programmatically, for example
 * by the release smoke checks that prove a server-less restore still works
 * (docs/TESTING.md).
 */
export { runCli, type CliIo } from "./cli.js";
export { Keyring, chunkIdKeyFor, loadKeyring, type LoadKeyringOptions } from "./keyring.js";
export {
  ChunkStore,
  isPlainJsonManifest,
  parseManifest,
  readManifest,
  safeJoin,
  type ManifestKeyringResolver,
  type ParseManifestOptions,
  type UnreadablePack,
} from "./store.js";
export {
  IntegrityError,
  objectLayoutOf,
  openChunk,
  restoreSnapshot,
  verifySnapshot,
  type ObjectLayout,
  type ObjectResult,
  type RunReport,
} from "./restore.js";
