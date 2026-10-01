import type { ImportUploadDto } from "../types";
import type { UploadEvent, UploadItem } from "./types";

/**
 * The list of files in the upload panel as a reducer over engine events, so
 * the whole state machine is testable without a DOM.
 */

export interface NewUploadFile {
  localId: string;
  name: string;
  size: number;
}

export type UploadAction =
  | { type: "add"; files: readonly NewUploadFile[] }
  /** A file that is already complete on the server (a `ready` upload from an earlier visit). */
  | { type: "addReady"; localId: string; upload: ImportUploadDto }
  | { type: "event"; event: UploadEvent }
  | { type: "reset"; localId: string }
  | { type: "remove"; localId: string }
  | { type: "clear" };

export function newItem(file: NewUploadFile): UploadItem {
  return {
    localId: file.localId,
    name: file.name,
    size: file.size,
    status: "queued",
    uploadId: null,
    segmentCount: 0,
    segmentsDone: 0,
    uploadedBytes: 0,
    resumed: false,
    detectedFormat: null,
    refusal: null,
    error: null,
    retrying: null,
  };
}

function update(
  items: UploadItem[],
  localId: string,
  change: (item: UploadItem) => UploadItem,
): UploadItem[] {
  return items.map((item) => (item.localId === localId ? change(item) : item));
}

export function applyEvent(items: UploadItem[], event: UploadEvent): UploadItem[] {
  return update(items, event.localId, (item) => {
    switch (event.type) {
      case "opening":
        return { ...item, status: "opening", error: null, retrying: null };
      case "started":
        return {
          ...item,
          status: "uploading",
          uploadId: event.uploadId,
          segmentCount: event.segmentCount,
          segmentsDone: event.receivedSegments,
          uploadedBytes: event.receivedBytes,
          resumed: event.resumed,
          error: null,
          retrying: null,
        };
      case "segment":
        return {
          ...item,
          segmentsDone: Math.min(item.segmentCount, item.segmentsDone + 1),
          uploadedBytes: Math.min(item.size, item.uploadedBytes + event.bytes),
          retrying: null,
        };
      case "retrying":
        return {
          ...item,
          retrying: { index: event.index, attempt: event.attempt, delayMs: event.delayMs },
        };
      case "completing":
        return { ...item, status: "completing", retrying: null };
      case "ready":
        return {
          ...item,
          status: "ready",
          uploadId: event.upload.id,
          uploadedBytes: item.size,
          segmentsDone: item.segmentCount,
          detectedFormat: event.upload.detectedFormat,
          refusal: null,
          error: null,
          retrying: null,
        };
      case "refused":
        return {
          ...item,
          status: "refused",
          uploadedBytes: item.size,
          detectedFormat: event.upload.detectedFormat,
          refusal: event.upload.refusal,
          error: null,
          retrying: null,
        };
      case "failed":
        return { ...item, status: "failed", error: event.code, retrying: null };
      case "cancelled":
        return { ...item, status: "cancelled", retrying: null };
    }
  });
}

export function uploadReducer(items: UploadItem[], action: UploadAction): UploadItem[] {
  switch (action.type) {
    case "add":
      return [...items, ...action.files.map(newItem)];
    case "addReady": {
      const item = newItem({
        localId: action.localId,
        name: action.upload.fileName,
        size: action.upload.size,
      });
      return [
        ...items,
        {
          ...item,
          status: "ready",
          uploadId: action.upload.id,
          segmentCount: action.upload.segmentCount,
          segmentsDone: action.upload.segmentCount,
          uploadedBytes: action.upload.size,
          resumed: true,
          detectedFormat: action.upload.detectedFormat,
        },
      ];
    }
    case "event":
      return applyEvent(items, action.event);
    case "reset":
      return update(items, action.localId, (item) => ({
        ...newItem(item),
        // The bytes the server already holds stay counted while the retry finds them again.
        uploadedBytes: 0,
      }));
    case "remove":
      return items.filter((item) => item.localId !== action.localId);
    case "clear":
      return [];
  }
}

/** Files of the batch that can be part of the import: complete, recognised and accepted. */
export function readyUploads(items: readonly UploadItem[]): UploadItem[] {
  return items.filter((item) => item.status === "ready" && item.uploadId !== null);
}

/** Server upload ids of everything that is ready; what the wizard hands to `POST /imports`. */
export function readyUploadIds(items: readonly UploadItem[]): string[] {
  return readyUploads(items).flatMap((item) => (item.uploadId ? [item.uploadId] : []));
}
