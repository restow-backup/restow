/**
 * Files out of a drop. Folders cannot be uploaded (a browser hands over an
 * unreadable placeholder for them), so they are told apart and reported
 * instead of failing later while being read.
 */

export interface DroppedEntries {
  files: File[];
  /** How many dropped items were folders. */
  directories: number;
}

interface EntryLike {
  isDirectory?: boolean;
}

interface ItemLike {
  kind: string;
  getAsFile(): File | null;
  webkitGetAsEntry?: () => EntryLike | null;
}

export interface TransferLike {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<ItemLike> | null;
}

export function extractDroppedFiles(transfer: TransferLike): DroppedEntries {
  const files: File[] = [];
  let directories = 0;
  const items = transfer.items ? Array.from(transfer.items) : [];
  if (items.length > 0) {
    for (const item of items) {
      if (item.kind !== "file") {
        continue;
      }
      if (item.webkitGetAsEntry?.()?.isDirectory) {
        directories += 1;
        continue;
      }
      const file = item.getAsFile();
      if (file) {
        files.push(file);
      }
    }
    return { files, directories };
  }
  return { files: transfer.files ? Array.from(transfer.files) : [], directories };
}

/** True while a drag carries files (not text or a link). */
export function hasFiles(transfer: { types?: ArrayLike<string> | null } | null): boolean {
  return transfer?.types ? Array.from(transfer.types).includes("Files") : false;
}
