import { Readable } from "node:stream";
import {
  type LocalRecoveryIso,
  RECOVERY_ISO_GITHUB_BASES,
  type RecoveryIsoCandidate,
  type RecoveryIsoFetchProblem,
  type RecoveryIsoFetchStatus,
  type RecoveryIsoSelection,
  readRecoveryIsoFetchState,
  recoveryFirmwareLicensesName,
  recoveryIsoDropDirs,
  recoveryIsoFetchEnabled,
  selectRecoveryIso,
} from "@restow/core";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { config } from "../../config.js";
import {
  assertProviderRoute,
  authenticate,
  requireTenant,
  resolveTenantAccess,
  TENANT_HEADER,
  type TenantEnv,
} from "../../middleware/session.js";
import { ProblemError } from "../../problem.js";
import { ALPHA_SOURCE_URL, DEFAULT_SOURCE_URL } from "../updates/source.js";
import { updateState } from "../updates/state-instance.js";
import { releaseKeyFingerprint } from "./commands.js";
import { agentRoot, openDistributionFile, readReleaseKey } from "./distribution.js";
import { instanceUrl } from "./instance-url.js";

// The names, the checksum parser and the hash cache live in @restow/core (release/recovery-iso.ts),
// shared with the worker that downloads the ISO; re-exported for the api's callers and tests.
export {
  isoChecksum,
  recoveryFirmwareLicensesName,
  recoveryIsoFileName,
  recoveryIsoHashStats,
  resetRecoveryIsoHashCache,
} from "@restow/core";

/**
 * The recovery ISO this installation offers (docs/BAREMETAL.md 8.5, 9.2, 14.6, 26.13).
 *
 * `verified`: the server itself checked the maintainer's signature over the release's
 * `SHA256SUMS` with the release key the image ships (the same key and check as the agent), and the
 * checksums list the ISO of this release (or a verified rebuild `recovery-v<v>.<n>` lists its own).
 * Only then can a recovery code be issued and does the web app show the code dialog and the wizard.
 *
 * Where it comes from (`source`): this instance, when the worker downloaded it into the store (or
 * an operator put it into a drop folder) and its SHA-256 equals the verified line; otherwise the
 * GitHub release, which stays the fallback link either way (`githubUrl`). `local` tells how far the
 * worker got: not fetched yet, fetching (bytes), verified, failed with a reason, or disabled.
 *
 * The answer carries the commands to check the file before it is written to a USB stick: the
 * signature of the checksums with the release key of the Git tag (never the one this instance
 * serves alone), then the hash of the file.
 *
 *   GET /api/v1/recovery-iso              the state above (tenant admins)
 *   GET /api/v1/recovery-iso/file/<file>  the verified copy on this instance (tenant admins; a plain
 *                                         navigation, so the tenant may come as `?tenant=`)
 */

export interface RecoveryIsoCommands {
  linux: string[];
  macos: string[];
  windows: string[];
}

export type RecoveryIsoSource = "instance" | "github";

export interface RecoveryIsoLocalState {
  status: RecoveryIsoFetchStatus;
  /** Why the last pass failed (or, with `verified`, a rebuild that was skipped). */
  problem: RecoveryIsoFetchProblem | null;
  detail: string | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  /** "store": downloaded by the worker; "import": from a drop folder. */
  origin: "store" | "import" | null;
  /** The drop folder in the data volume for installations without internet. */
  importDir: string | null;
  updatedAt: string | null;
}

export interface RecoveryIsoState {
  version: string | null;
  /** null: the ISO of the release itself; n: the rebuild `recovery-v<version>.<n>`. */
  rebuild: number | null;
  fileName: string | null;
  url: string | null;
  source: RecoveryIsoSource | null;
  sha256: string | null;
  /** Known only for the copy on this instance. */
  sizeBytes: number | null;
  releaseKeyFingerprint: string | null;
  verified: boolean;
  /** The GitHub release page of the ISO's tag. */
  releaseUrl: string | null;
  /** The ISO on GitHub (the fallback link). */
  githubUrl: string | null;
  /** The signed checksums on GitHub and their signature, for the commands. */
  sumsUrl: string | null;
  signatureUrl: string | null;
  /** Where the source bundle of the GPL packages is (release attachments, 8.7). */
  sourcesUrl: string | null;
  /** The licence notes of the non-free firmware in the image (8.4). */
  firmwareLicensesUrl: string | null;
  local: RecoveryIsoLocalState;
  commands: RecoveryIsoCommands;
}

function commandsFor(candidate: RecoveryIsoCandidate | null): RecoveryIsoCommands {
  if (!candidate) {
    return { linux: [], macos: [], windows: [] };
  }
  const { fileName, sumsName } = candidate;
  const line = `grep ' recovery/${fileName}$' ${sumsName} | sed 's# recovery/# #'`;
  const verify = `./verify-agent-signature.sh ${sumsName} ${sumsName}.sig release-signing.pub`;
  return {
    linux: [verify, `${line} | sha256sum -c -`],
    macos: [verify, `${line} | shasum -a 256 -c -`],
    windows: [`(Get-FileHash -Algorithm SHA256 '${fileName}').Hash.ToLower()`],
  };
}

/**
 * The repository whose releases carry the ISO: the one the worker found, else the alpha
 * repository when the installation follows it, otherwise the project's public one. A source an
 * administrator named (a fork, a Forgejo mirror) is not assumed to attach an ISO.
 */
export function recoveryIsoGithubBase(found: string | null = null): string {
  if (found && (RECOVERY_ISO_GITHUB_BASES as readonly string[]).includes(found)) {
    return found;
  }
  try {
    return updateState.get().source.isAlpha ? ALPHA_SOURCE_URL : DEFAULT_SOURCE_URL;
  } catch {
    return DEFAULT_SOURCE_URL;
  }
}

export interface RecoveryIsoOptions {
  /** `RESTOW_RECOVERY_ISO_DIR`. */
  isoDir?: string | null;
  /** The store of the worker (`RESTOW_RECOVERY_ISO_STORE_DIR`, default /data/recovery-iso). */
  storeDir?: string | null;
  /** The release key line (default: the image's). */
  key?: string;
  /** The repository whose release attachments carry the ISO. */
  githubBase?: string;
  /** Whether the worker downloads (RESTOW_RECOVERY_ISO_FETCH). */
  fetchEnabled?: boolean;
  now?: () => number;
}

/** A pass that reported nothing for this long is not fetching any more (the worker stopped). */
const STALE_FETCH_MS = 15 * 60 * 1000;

function resolved(options: RecoveryIsoOptions) {
  const isoDir = options.isoDir === undefined ? config.recoveryIsoDir : options.isoDir;
  const storeDir = options.storeDir === undefined ? config.recoveryIsoStoreDir : options.storeDir;
  return { isoDir: isoDir ?? null, storeDir: storeDir ?? null };
}

/** What the files say about the ISO (shared by the state and the download routes). */
export async function recoveryIsoSelection(
  root = agentRoot(),
  options: RecoveryIsoOptions = {},
): Promise<RecoveryIsoSelection & { storeDir: string | null; dropDirs: string[] }> {
  const { isoDir, storeDir } = resolved(options);
  const dropDirs = recoveryIsoDropDirs(storeDir, isoDir);
  const selection = await selectRecoveryIso({
    root,
    ...(options.key === undefined ? {} : { key: options.key }),
    storeDir,
    dropDirs,
  });
  return { ...selection, storeDir, dropDirs };
}

async function localState(
  selection: { newest: RecoveryIsoCandidate | null; local: LocalRecoveryIso | null },
  offered: RecoveryIsoCandidate | null,
  storeDir: string | null,
  options: RecoveryIsoOptions,
): Promise<RecoveryIsoLocalState & { githubBase: string | null }> {
  const fetchEnabled = options.fetchEnabled ?? recoveryIsoFetchEnabled();
  const importDir = storeDir ? `${storeDir.replace(/\/+$/, "")}/import` : null;
  const worker = await readRecoveryIsoFetchState(storeDir);
  const newestIsLocal =
    selection.local !== null && offered?.fileName === selection.newest?.fileName;
  const base = {
    origin: selection.local?.origin ?? null,
    importDir,
    githubBase: worker?.githubBase ?? null,
    updatedAt: worker?.updatedAt ?? null,
  };
  if (newestIsLocal) {
    return {
      ...base,
      status: "verified",
      // A rebuild the worker skipped (bad signature, another release) stays visible.
      problem: worker?.status === "verified" ? worker.problem : null,
      detail: worker?.status === "verified" ? worker.detail : null,
      bytesDone: selection.local?.size ?? null,
      bytesTotal: selection.local?.size ?? null,
    };
  }
  if (!storeDir || !fetchEnabled) {
    return {
      ...base,
      status: "disabled",
      problem: null,
      detail: null,
      bytesDone: null,
      bytesTotal: null,
    };
  }
  // The worker's state only counts for the ISO that is the newest now.
  const current = worker && worker.fileName === selection.newest?.fileName ? worker : null;
  if (current?.status === "fetching") {
    const age = (options.now ?? Date.now)() - Date.parse(current.updatedAt);
    if (Number.isFinite(age) && age > STALE_FETCH_MS) {
      return {
        ...base,
        status: "failed",
        problem: "truncated",
        detail: null,
        bytesDone: current.bytesDone,
        bytesTotal: current.bytesTotal,
      };
    }
    return {
      ...base,
      status: "fetching",
      problem: null,
      detail: null,
      bytesDone: current.bytesDone,
      bytesTotal: current.bytesTotal,
    };
  }
  if (current?.status === "failed" || (worker?.status === "failed" && !selection.newest)) {
    const failed = current ?? worker;
    return {
      ...base,
      status: "failed",
      problem: failed?.problem ?? null,
      detail: failed?.detail ?? null,
      bytesDone: failed?.bytesDone ?? null,
      bytesTotal: failed?.bytesTotal ?? null,
    };
  }
  return {
    ...base,
    status: "not_fetched",
    problem: null,
    detail: null,
    bytesDone: null,
    bytesTotal: null,
  };
}

/**
 * What the installation offers. `verified` only when the server checked the release signature and
 * the checksums list an ISO of this release (a rebuild names its own number).
 */
export async function recoveryIsoState(
  root = agentRoot(),
  instance: string | null = null,
  options: RecoveryIsoOptions = {},
): Promise<RecoveryIsoState> {
  const key = options.key ?? (await readReleaseKey().catch(() => ""));
  const fingerprint = key ? releaseKeyFingerprint(key) : null;
  const selection = await recoveryIsoSelection(root, { ...options, key });
  const offered = selection.offered;
  // A copy here is offered only when the request knows the instance's address.
  const fromInstance = selection.local !== null && instance !== null && offered !== null;
  const { githubBase, ...local } = await localState(
    selection,
    offered,
    selection.storeDir,
    options,
  );
  if (!offered) {
    return {
      version: null,
      rebuild: null,
      fileName: null,
      url: null,
      source: null,
      sha256: null,
      sizeBytes: null,
      releaseKeyFingerprint: fingerprint,
      verified: false,
      releaseUrl: null,
      githubUrl: null,
      sumsUrl: null,
      signatureUrl: null,
      sourcesUrl: null,
      firmwareLicensesUrl: null,
      local,
      commands: commandsFor(null),
    };
  }
  const base = (options.githubBase ?? recoveryIsoGithubBase(githubBase)).replace(/\/+$/, "");
  const tag = encodeURIComponent(offered.tag);
  const releaseUrl = `${base}/releases/tag/${tag}`;
  const download = (name: string) => `${base}/releases/download/${tag}/${encodeURIComponent(name)}`;
  const githubUrl = download(offered.fileName);
  return {
    version: offered.version,
    rebuild: offered.rebuild,
    fileName: offered.fileName,
    url: fromInstance
      ? `${(instance as string).replace(/\/+$/, "")}/api/v1/recovery-iso/file/${encodeURIComponent(offered.fileName)}`
      : githubUrl,
    source: fromInstance ? "instance" : "github",
    sha256: offered.sha256,
    sizeBytes: fromInstance ? (selection.local as LocalRecoveryIso).size : null,
    releaseKeyFingerprint: fingerprint,
    verified: true,
    releaseUrl,
    githubUrl,
    sumsUrl: download(offered.sumsName),
    signatureUrl: download(`${offered.sumsName}.sig`),
    // The source bundle of the GPL packages is a set of attachments of the same release (8.7).
    sourcesUrl: releaseUrl,
    firmwareLicensesUrl: download(recoveryFirmwareLicensesName(offered.version, offered.rebuild)),
    local,
    commands: commandsFor(offered),
  };
}

/**
 * The verified copy on this instance of `fileName` for `version` (any version when null), or
 * null. Only the ISO the installation offers now, only with the hash of its verified line.
 */
export async function servableRecoveryIso(
  fileName: string,
  version: string | null = null,
  root = agentRoot(),
  options: RecoveryIsoOptions = {},
): Promise<LocalRecoveryIso | null> {
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) {
    return null;
  }
  const selection = await recoveryIsoSelection(root, options);
  const offered = selection.offered;
  if (!offered || !selection.local || offered.fileName !== fileName) {
    return null;
  }
  if (version !== null && offered.version !== version) {
    return null;
  }
  return selection.local;
}

/** A download response of a verified copy. */
export function recoveryIsoResponse(found: LocalRecoveryIso, fileName: string): Response {
  return new Response(
    Readable.toWeb(openDistributionFile(found.path)) as unknown as ReadableStream,
    {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(found.size),
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "private, max-age=300",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export const recoveryIsoRoutes = new Hono<TenantEnv>();

recoveryIsoRoutes.get("/", requireTenant("tenant_admin"), async (c) => {
  const instance = await instanceUrl(c);
  return c.json(await recoveryIsoState(agentRoot(), instance.url || null));
});

/**
 * The download is a plain browser navigation, which cannot carry the `X-Restow-Tenant` header;
 * the tenant may therefore also arrive as the `tenant` query parameter (like the export download).
 * Otherwise identical to requireTenant("tenant_admin").
 */
const adminForDownload: MiddlewareHandler<TenantEnv> = async (c: Context<TenantEnv>, next) => {
  const state = await authenticate(c.req.raw.headers);
  assertProviderRoute(c, state);
  const selector = c.req.header(TENANT_HEADER) ?? c.req.query("tenant");
  const { tenant, role } = await resolveTenantAccess(state, selector, "tenant_admin");
  c.set("auth", state.auth);
  c.set("user", state.user);
  c.set("isProviderAdmin", state.isProviderAdmin);
  c.set("providerAccess", state.providerAccess);
  c.set("memberships", state.memberships);
  c.set("tenantId", tenant.id);
  c.set("tenant", tenant);
  c.set("role", role);
  await next();
};

recoveryIsoRoutes.get("/file/:file", adminForDownload, async (c) => {
  const file = c.req.param("file");
  const found = await servableRecoveryIso(file);
  if (!found) {
    throw new ProblemError(404, "Not Found", {
      detail: "This installation holds no verified copy of that file.",
    });
  }
  return recoveryIsoResponse(found, file);
});
