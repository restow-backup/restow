import * as React from "react";

import { createUploadTransport } from "../api";
import type { ImportConfig, ImportUploadDto } from "../types";
import { UploadEngine } from "./engine";
import { SpeedMeter, overallProgress } from "./progress";
import { assignResumes, resumableUploads } from "./resume";
import { readyUploads, uploadReducer } from "./state";
import type { UploadItem, UploadTransport } from "./types";

export interface UseUploadManagerOptions {
  tenantId: string | null;
  config: Pick<ImportConfig, "segmentSize" | "maxFileBytes"> | undefined;
  /** Uploads the server still holds from earlier visits (for resuming by name and size). */
  unfinished: readonly ImportUploadDto[] | undefined;
}

export interface AddFilesResult {
  added: number;
  /** Files skipped because the same name and size is already in the list. */
  duplicates: number;
}

let localCounter = 0;
const nextLocalId = () => `upload-${++localCounter}`;

/**
 * The upload panel's state: the file list as a reducer over the engine's
 * events, the overall progress with speed and ETA, and the actions. The engine
 * lives as long as the wizard is mounted; leaving the page stops the requests
 * without deleting anything, so the uploads can be continued later.
 */
export function useUploadManager({ tenantId, config, unfinished }: UseUploadManagerOptions) {
  const [items, dispatch] = React.useReducer(uploadReducer, []);
  const engineRef = React.useRef<UploadEngine | null>(null);
  const transportRef = React.useRef<UploadTransport | null>(null);
  const filesRef = React.useRef(new Map<string, File>());
  const meterRef = React.useRef(new SpeedMeter());
  const unfinishedRef = React.useRef(unfinished);
  unfinishedRef.current = unfinished;
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const [now, setNow] = React.useState(() => Date.now());

  const segmentSize = config?.segmentSize;
  const maxFileBytes = config?.maxFileBytes;

  React.useEffect(() => {
    const transport = createUploadTransport(tenantId);
    transportRef.current = transport;
    const engine = new UploadEngine({
      transport,
      onEvent: (event) => dispatch({ type: "event", event }),
      segmentSize,
      maxFileBytes,
    });
    engineRef.current = engine;
    return () => {
      // The page is going away: stop sending, keep the uploads on the server.
      engine.suspend();
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    };
  }, [tenantId, segmentSize, maxFileBytes]);

  const totalUploaded = items.reduce(
    (sum, item) =>
      sum + (item.status === "ready" || item.status === "refused" ? item.size : item.uploadedBytes),
    0,
  );
  React.useEffect(() => {
    meterRef.current.record(Date.now(), totalUploaded);
  }, [totalUploaded]);

  const progress = React.useMemo(
    () => overallProgress(items, meterRef.current.bytesPerSecond(now)),
    [items, now],
  );

  // Speed and ETA keep moving while nothing new arrives.
  React.useEffect(() => {
    if (!progress.busy) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [progress.busy]);

  // Leaving a running upload by accident costs time: ask first.
  React.useEffect(() => {
    if (!progress.busy) {
      return;
    }
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [progress.busy]);

  const addFiles = React.useCallback((files: readonly File[]): AddFilesResult => {
    const engine = engineRef.current;
    if (!engine) {
      return { added: 0, duplicates: files.length };
    }
    const present = new Set(
      itemsRef.current
        .filter((item) => item.status !== "cancelled")
        .map((item) => `${item.name}\u0000${item.size}`),
    );
    const fresh: File[] = [];
    let duplicates = 0;
    for (const file of files) {
      const key = `${file.name}\u0000${file.size}`;
      if (present.has(key)) {
        duplicates += 1;
      } else {
        present.add(key);
        fresh.push(file);
      }
    }
    if (fresh.length === 0) {
      return { added: 0, duplicates };
    }
    const pairs = assignResumes(fresh, resumableUploads(unfinishedRef.current ?? []));
    const entries = pairs.map(({ file, resume }) => ({ localId: nextLocalId(), file, resume }));
    dispatch({
      type: "add",
      files: entries.map(({ localId, file }) => ({
        localId,
        name: file.name,
        size: file.size,
      })),
    });
    for (const { localId, file, resume } of entries) {
      filesRef.current.set(localId, file);
      engine.enqueue({ localId, file, resume });
    }
    return { added: entries.length, duplicates };
  }, []);

  /** Use an upload that is complete on the server as it is (no file to pick again). */
  const addReadyUpload = React.useCallback((upload: ImportUploadDto) => {
    if (itemsRef.current.some((item) => item.uploadId === upload.id)) {
      return;
    }
    dispatch({ type: "addReady", localId: nextLocalId(), upload });
  }, []);

  /** Delete an upload the engine does not know (one taken over from an earlier visit). */
  const deleteForeign = React.useCallback((item: UploadItem | undefined) => {
    if (item?.uploadId) {
      void transportRef.current?.remove(item.uploadId).catch(() => {
        // Best effort: it expires on its own.
      });
    }
  }, []);

  const remove = React.useCallback(
    (localId: string) => {
      if (filesRef.current.has(localId)) {
        void engineRef.current?.cancel(localId);
      } else {
        deleteForeign(itemsRef.current.find((item) => item.localId === localId));
      }
      filesRef.current.delete(localId);
      dispatch({ type: "remove", localId });
    },
    [deleteForeign],
  );

  const retry = React.useCallback((localId: string) => {
    const file = filesRef.current.get(localId);
    if (!file || !engineRef.current) {
      return;
    }
    dispatch({ type: "reset", localId });
    engineRef.current.enqueue({ localId, file });
  }, []);

  const cancelAll = React.useCallback(() => {
    void engineRef.current?.cancelAll();
    for (const item of itemsRef.current) {
      if (!filesRef.current.has(item.localId)) {
        deleteForeign(item);
      }
    }
    filesRef.current.clear();
    dispatch({ type: "clear" });
  }, [deleteForeign]);

  return {
    items: items as readonly UploadItem[],
    ready: readyUploads(items),
    progress,
    addFiles,
    addReadyUpload,
    remove,
    retry,
    cancelAll,
  };
}

export type UploadManager = ReturnType<typeof useUploadManager>;
