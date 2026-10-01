/**
 * OneDrive backup engine (protected object kind `onedrive`): root delta with
 * token, items tracked by id, streaming downloads into the chunk store,
 * folders and information-only metadata in the manifest, optional versions,
 * resume, 410 resync, non-fatal item failures and cancellation.
 *
 * The public surface is deliberately small and prefixed, because the package
 * root re-exports every engine side by side. Restore and the file explorer
 * read the manifest vocabulary below (object types, version paths).
 */
export {
  ONEDRIVE_BACKUP_DEFAULTS,
  OneDriveBackupEngine,
  type OneDriveBackupEngineOptions,
  type OneDriveGraphClientResolver,
  type OneDriveIdResolver,
  OneDriveUnavailableError,
  createOneDriveBackupEngine,
  looksLikeDriveId,
  resolveOneDriveId,
} from "./engine.js";
export {
  ONEDRIVE_OBJECT_TYPES,
  type OneDriveObjectType,
  VERSION_PATH_MARKER as ONEDRIVE_VERSION_PATH_MARKER,
  isVersionPath as isOneDriveVersionPath,
  versionPath as oneDriveVersionPath,
} from "./items.js";
export { ONEDRIVE_PHASES, type OneDrivePhase } from "./run.js";
export {
  type OneDriveCursor,
  type OneDriveManifestState,
  readManifestState as readOneDriveManifestState,
} from "./state.js";
