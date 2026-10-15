/**
 * SharePoint Online backup engine (protected object kind `site`): every
 * document library through the OneDrive drive run, lists with columns and
 * items as JSON, and the site's metadata, in one snapshot per site. Restore,
 * the explorer and the restore check read the layout below.
 */
export {
  SHAREPOINT_PHASES,
  SharePointBackupEngine,
  type SharePointBackupEngineOptions,
  type SharePointGraphClientResolver,
  SiteUnavailableError,
} from "./engine.js";
export {
  LIBRARIES_FOLDER as SITE_LIBRARIES_FOLDER,
  LIST_SCHEMA_NAME as SITE_LIST_SCHEMA_NAME,
  LISTS_FOLDER as SITE_LISTS_FOLDER,
  type ListColumnFacts,
  libraryPath as siteLibraryPath,
  listPath as siteListPath,
  SITE_INFO_PATH,
  SITE_OBJECT_TYPES,
  SITE_ROLES,
  type SiteArea,
  siteAreaOf,
  writableFields as writableListItemFields,
} from "./layout.js";
export {
  readSiteManifestState,
  SITE_ENGINE_NAME,
  type SiteLibraryState,
  type SiteManifestState,
} from "./state.js";
