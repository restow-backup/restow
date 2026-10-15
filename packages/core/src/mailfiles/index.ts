/**
 * Mail file import and export (docs/IMPORT.md): readers for EML, MSG, MBOX,
 * ZIP archives and folder trees, the encrypted staging store, the import engine
 * and the export writers. Exposed as the `mailfiles` namespace of @restow/core.
 */

export * from "./archive-fields.js";
export * from "./export/index.js";
export * from "./export-sources.js";
export * from "./folder.js";
export * from "./import-engine.js";
export {
  configureIsolation,
  defaultIsolationWorkers,
  type IsolatedFailureKind,
  type IsolatedTask,
  IsolatedTaskError,
  isolatedTimeoutMs,
  type RunIsolatedOptions,
  runIsolated,
  shutdownIsolation,
} from "./isolate.js";
export * from "./meta.js";
export * from "./segments.js";
export * from "./sniff.js";
export * from "./types.js";
export * from "./walk.js";
