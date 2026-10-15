import type {
  InfiniteData,
  UseInfiniteQueryResult,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import type * as React from "react";

import type { BrowseEntry } from "@/features/endpoints/api";

/**
 * What the file restore of a source needs from it (docs/FILESHARES.md 12.4): the restore points,
 * one folder of one, the ZIP download, the restore dialog, and the texts that name the kind of
 * source. Machines (features/endpoints) and file shares (features/file-shares) each build one;
 * `RestorePointBrowser` is the same for both. The `use*` members are hooks: an adapter is built
 * once per component and its hooks are called on every render, in the same order.
 */

/** A restore point as the timeline and the browser need it. */
export interface RestorePointView {
  id: string;
  /** ISO 8601. */
  time: string;
  /** What the browser's title names it by. */
  shortId: string;
}

/** One page of a folder: the entries in the server's order and where the next page starts. */
export interface FolderPage {
  entries: readonly BrowseEntry[];
  nextCursor: string | null;
}

export interface RestoreDialogSlotProps<P extends RestorePointView> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  point: P;
  /** The selected paths, a folder standing for everything inside it. */
  paths: readonly string[];
  /** The request went through: the selection can be cleared. */
  onRequested: () => void;
}

export interface FileSourceAdapter<P extends RestorePointView> {
  useRestorePoints: () => UseQueryResult<readonly P[]>;
  useFolder: (
    pointId: string | null,
    path: string,
  ) => UseInfiniteQueryResult<InfiniteData<FolderPage>>;
  useCreateDownload: () => UseMutationResult<
    { id: string },
    unknown,
    { snapshotId: string; paths: readonly string[] }
  >;
  /** The address of a prepared download, which the browser is sent to. */
  downloadUrl: (downloadId: string) => string;
  startDownload: (url: string) => void;
  limits: { downloadPaths: number; restorePaths: number };
  /** Whether the selection can be restored (a revoked machine cannot take a restore). */
  canRestore: boolean;
  /** The restore button's label; the machine's "Restore to the machine" by default. */
  restoreLabel?: string;
  /** A note under the selection bar (why a restore is closed, for example). */
  note?: React.ReactNode;
  /** The accessible name of the timeline. */
  timelineLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  /** What a restore point shows below its time on the timeline. */
  renderDetails: (point: P) => React.ReactNode;
  /** Shown in the browser's header of the chosen restore point (a permissions note, search). */
  renderBrowserExtra?: (point: P, openPath: (path: string) => void) => React.ReactNode;
  renderRestoreDialog: (props: RestoreDialogSlotProps<P>) => React.ReactNode;
  /** The translation key of an error (`endpoints:` keys by default). */
  errorKey: (error: unknown) => string;
  isRetryable: (error: unknown) => boolean;
}

/** Newest first, the order of every restore point list. */
export function newestFirst<P extends RestorePointView>(points: readonly P[]): P[] {
  return [...points].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}
