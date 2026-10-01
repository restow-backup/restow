import type { Database } from "@restow/db";
import type { AnyJobHandler } from "./handlers/framework.js";
import type { RetentionTask } from "./handlers/retention.js";

/**
 * Extension points of the worker: the only way code outside the core
 * (the Business and Service Provider modules under `ee/worker`, see
 * ee/README.md) adds work to it. The core never imports `ee/`; the one
 * designated loader (`./ee.ts`) imports the `ee/worker` entry and registers
 * it here, and the process entrypoint (./index.ts) reads the registry while
 * it starts. Imports types only.
 */

/** What an extension gets to build its tasks at startup. */
export interface WorkerExtensionContext {
  /** The installation pool (packages/db/src/roles.ts). */
  readonly providerDb: Database;
}

export interface WorkerExtension {
  readonly name: string;
  /** Units of work for the shared `retention` queue (./handlers/retention.ts). */
  readonly retentionTasks?: (context: WorkerExtensionContext) => readonly RetentionTask[];
  /** Handlers for queues the core has none for. */
  readonly handlers?: readonly AnyJobHandler[];
}

const workerExtensions: WorkerExtension[] = [];

export function registerWorkerExtension(extension: WorkerExtension): void {
  if (workerExtensions.some((existing) => existing.name === extension.name)) {
    throw new Error(`worker extension ${extension.name} is already registered`);
  }
  workerExtensions.push(extension);
}

export function extensionRetentionTasks(context: WorkerExtensionContext): RetentionTask[] {
  return workerExtensions.flatMap((extension) => [...(extension.retentionTasks?.(context) ?? [])]);
}

export function extensionHandlers(): AnyJobHandler[] {
  return workerExtensions.flatMap((extension) => [...(extension.handlers ?? [])]);
}

/** Test support: forget every registration (the registry is process-wide). */
export function resetWorkerExtensionsForTesting(): void {
  workerExtensions.length = 0;
}
