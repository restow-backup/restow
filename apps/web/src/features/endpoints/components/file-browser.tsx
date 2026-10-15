/**
 * The file browser of restore points moved to features/restore/files (machines and file shares
 * share it, docs/FILESHARES.md 12.4); the machine pages keep importing it from here.
 */
export {
  BrowserBody,
  EntryTable,
  type FolderPages,
  PathBar,
  SelectionBar,
} from "@/features/restore/files/file-browser";
