/**
 * Mail file import and export (docs/IMPORT.md): readers for EML, MSG, MBOX,
 * ZIP archives and folder trees, the encrypted staging store, the import engine
 * and the export writers. Exposed as the `mailfiles` namespace of @restow/core.
 */
export * from "./types.js";
export * from "./segments.js";
export * from "./sniff.js";
export * from "./meta.js";
export * from "./folder.js";
export * from "./walk.js";
export * from "./import-engine.js";
export * from "./archive-fields.js";
export {
  type IsolatedFailureKind,
  type IsolatedTask,
  IsolatedTaskError,
  type RunIsolatedOptions,
  configureIsolation,
  defaultIsolationWorkers,
  isolatedTimeoutMs,
  runIsolated,
  shutdownIsolation,
} from "./isolate.js";
export * from "./export-sources.js";
export * from "./export/index.js";
