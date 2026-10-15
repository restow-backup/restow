/**
 * @restow/cli — the standalone restore.
 *
 * The command-line entry point lives in `restow-restore.ts` (the `restow-restore`
 * bin) and runs the commands of `cli.ts`. This module re-exports the reusable
 * pieces so the reassembly logic can be driven programmatically, for example
 * by the release smoke checks that prove a server-less restore still works
 * (docs/TESTING.md).
 */
export { type CliIo, runCli } from "./cli.js";
export { chunkIdKeyFor, Keyring, type LoadKeyringOptions, loadKeyring } from "./keyring.js";
export {
  IntegrityError,
  type ObjectLayout,
  type ObjectResult,
  objectLayoutOf,
  openChunk,
  type RunReport,
  restoreSnapshot,
  verifySnapshot,
} from "./restore.js";
export {
  ChunkStore,
  isPlainJsonManifest,
  type ManifestKeyringResolver,
  type ParseManifestOptions,
  parseManifest,
  readManifest,
  safeJoin,
  type UnreadablePack,
} from "./store.js";
