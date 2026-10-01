/**
 * The complete set of restore engines, built from the two things only the
 * host knows: how to get a Graph client for a tenant and how to open an IMAP
 * session for an account. The worker registers `byKind` and `download` with
 * its restore handler; `run` routes a request the same way for callers that
 * hold the set directly (verify runs, tests).
 */
import type {
  JobContext,
  ProtectedObjectKind,
  RestoreEngine,
  RestoreRequest,
} from "../engine/types.js";
import type { RestoreGraphClientFactory } from "./common.js";
import { DownloadRestoreEngine, type DownloadRestoreEngineOptions } from "./download.js";
import { ExchangeRestoreEngine } from "./exchange.js";
import { ImapRestoreEngine, type ImapSessionFactory } from "./imap.js";
import { OneDriveRestoreEngine } from "./onedrive.js";
import type { RestoreReport } from "./results.js";

export interface RestoreEnginesOptions {
  readonly graph: RestoreGraphClientFactory;
  readonly imap: ImapSessionFactory;
  readonly download?: DownloadRestoreEngineOptions;
  /** OneDrive upload-session fragment size in bytes. */
  readonly driveFragmentSize?: number;
}

export interface RestoreEngines {
  /** Engines that write back into a source, by protected object kind. */
  readonly byKind: ReadonlyMap<ProtectedObjectKind, RestoreEngine>;
  /** Produces ZIP archives for download restores of every kind. */
  readonly download: DownloadRestoreEngine;
  /** Route a request to the right engine and run it. */
  run(ctx: JobContext, request: RestoreRequest): Promise<RestoreReport>;
}

export function createRestoreEngines(options: RestoreEnginesOptions): RestoreEngines {
  const exchange = new ExchangeRestoreEngine({ graph: options.graph });
  const onedrive = new OneDriveRestoreEngine({
    graph: options.graph,
    fragmentSize: options.driveFragmentSize,
  });
  const imap = new ImapRestoreEngine({ imap: options.imap });
  const byKind = new Map<
    ProtectedObjectKind,
    ExchangeRestoreEngine | OneDriveRestoreEngine | ImapRestoreEngine
  >([
    ["mailbox", exchange],
    ["onedrive", onedrive],
    ["imap", imap],
  ]);
  const download = new DownloadRestoreEngine(options.download);
  return {
    byKind,
    download,
    async run(ctx, request) {
      if (request.target.type === "download") {
        return download.run(ctx, request);
      }
      const engine = byKind.get(request.protectedObject.kind);
      if (!engine) {
        throw new Error(
          `no restore engine for protected object kind ${request.protectedObject.kind}`,
        );
      }
      return engine.run(ctx, request);
    },
  };
}
