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

/**
 * Core work that runs only when an extension enables it, the worker's side of
 * apps/api's `GATED_FEATURES` (apps/api/src/lib/features.ts; the same names):
 *
 *   archive.mailboxCapture  continuous archive capture from the mailbox, Graph and
 *                           IMAP (./archive-capture); off = the capture service idles
 *   archive.smtpCapture     archive capture by SMTP (journaling, forwarded copies)
 *
 * Without a registered gate every feature is off, so the core alone runs exactly its own
 * work. The core never learns why a gate opens (in the full build, ee/ decides by the
 * installed license).
 */
export const WORKER_GATED_FEATURES = ["archive.mailboxCapture", "archive.smtpCapture"] as const;

export type WorkerGatedFeature = (typeof WORKER_GATED_FEATURES)[number];

/** Decides whether a gated feature is on right now; asked again on every check. */
export interface WorkerFeatureGate {
  isEnabled(feature: WorkerGatedFeature): Promise<boolean>;
}

export interface WorkerExtension {
  readonly name: string;
  /** Units of work for the shared `retention` queue (./handlers/retention.ts). */
  readonly retentionTasks?: (context: WorkerExtensionContext) => readonly RetentionTask[];
  /** Handlers for queues the core has none for. */
  readonly handlers?: readonly AnyJobHandler[];
  /** The gate of the core's gated work ({@link WORKER_GATED_FEATURES}). */
  readonly features?: (context: WorkerExtensionContext) => WorkerFeatureGate;
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

/**
 * One gate over every registered extension's gate: a feature is on when any of them says
 * so, off when none is registered. A gate that throws counts as off for this check.
 */
export function extensionFeatureGate(context: WorkerExtensionContext): WorkerFeatureGate {
  const gates = workerExtensions.flatMap((extension) =>
    extension.features ? [extension.features(context)] : [],
  );
  return {
    async isEnabled(feature) {
      for (const gate of gates) {
        if (await gate.isEnabled(feature).catch(() => false)) {
          return true;
        }
      }
      return false;
    },
  };
}

/** Test support: forget every registration (the registry is process-wide). */
export function resetWorkerExtensionsForTesting(): void {
  workerExtensions.length = 0;
}
