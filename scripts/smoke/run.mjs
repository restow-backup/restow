#!/usr/bin/env node
/**
 * The Restow release smoke: its eleven checks ("The release smoke" in
 * docs/CI.md), against the release compose file (deploy/release) and the images
 * under test, written to smoke-report.md. The same script runs on a workstation and in CI (the
 * release-smoke job of .github/workflows/release.yml).
 *
 *   node scripts/smoke/run.mjs                       build the images from this checkout and test them
 *   node scripts/smoke/run.mjs --image REF --web-image REF
 *                                                    test existing images (a digest from the registry)
 *   node scripts/smoke/run.mjs --variant community   the same for the Community build (no ee/)
 *
 * Needs Docker (with compose and buildx) and Node 22. See docs/CI.md and --help.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { install, rerunMigrations } from "./checks/01-install.mjs";
import { health } from "./checks/02-health.mjs";
import { passkey } from "./checks/03-passkey.mjs";
import { m365 } from "./checks/04-m365.mjs";
import { imapBackup } from "./checks/05-imap.mjs";
import { journal } from "./checks/06-journal.mjs";
import { standaloneRestore } from "./checks/07-standalone-restore.mjs";
import { storageTargets } from "./checks/08-storage.mjs";
import { scans } from "./checks/09-scans.mjs";
import { endpoint } from "./checks/10-endpoint.mjs";
import { importExport } from "./checks/11-import-export.mjs";
import { run } from "./lib/exec.mjs";
import { createLicenseSigner } from "./lib/license.mjs";
import { CheckRun, RESULT, Report, Skip, StepFailure, formatDuration } from "./lib/report.mjs";
import { APP_IMAGE, Stack, WEB_IMAGE } from "./lib/stack.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const USAGE = `Usage: node scripts/smoke/run.mjs [options]

Build (docs/CI.md, "Two build targets"):
  --variant full|community  the build under test (default full). full: the targets runtime and web,
                            a Service Provider license key from a throwaway test signer, every check.
                            community: runtime-community and web-community, one tenant shared by
                            the checks, no license API; check 6 (journal receiver, Business) and
                            check 8 (one tenant per storage target) are skipped with the reason.
                            Defaults for community: --project restow-smoke-community,
                            --port-base 38500, --report smoke-report-community.md,
                            --work-dir smoke-out/run-community

Images (default: build both from this checkout with docker buildx, for this machine's architecture):
  --image REF               application image under test (a tag or name@sha256:digest)
  --web-image REF           web edge image under test
  --previous-image REF      application image of the previous release: enables the upgrade path of check 1
  --previous-web-image REF  web edge image of the previous release
  --version X.Y.Z           version under test (default: version in package.json); the image must carry it
  --revision SHA            git revision (default: from git)
  --require-agent           fail when the image has no agent binaries under /srv/agent (the release sets this)

Run:
  --only 5,7                run these checks (and the checks they depend on); default all
  --skip 4,10               leave these checks out (reported as skipped on request)
  --trivy-strict            count critical findings without an available fix too
  --report FILE             where smoke-report.md goes (default: smoke-report.md in the repository root)
  --work-dir DIR            working files, secrets and logs (default: smoke-out/run; must be inside $HOME for Colima)
  --project NAME            compose project name (default: restow-smoke)
  --port-base N             first of the host ports (default 38300; ports N, N+14, N+25, N+43, N+80, N+90, and +100 for the upgrade stack)
  --keep                    leave the stack running afterwards (remove it with: docker compose -p restow-smoke down -v)
  --help

Environment (check 4 only): M365_TEST_TENANT_ID, M365_TEST_CLIENT_ID, M365_TEST_CLIENT_SECRET,
M365_TEST_MAILBOX, M365_TEST_RESTORE_MAILBOX. Without them check 4 is reported as skipped.
`;

/** Where a variant's run goes unless the options say otherwise; the two can run side by side. */
export function variantDefaults(variant) {
  return variant === "community"
    ? {
        report: join(repoRoot, "smoke-report-community.md"),
        workDir: join(repoRoot, "smoke-out/run-community"),
        logsDir: join(repoRoot, "smoke-out/logs-community"),
        project: "restow-smoke-community",
        portBase: 38500,
        tag: "under-test-community",
      }
    : {
        report: join(repoRoot, "smoke-report.md"),
        workDir: join(repoRoot, "smoke-out/run"),
        logsDir: join(repoRoot, "smoke-out/logs"),
        project: "restow-smoke",
        portBase: 38300,
        tag: "under-test",
      };
}

/** The Dockerfile targets of a variant's two images. */
export function targetsOf(variant) {
  return variant === "community"
    ? { app: "runtime-community", web: "web-community" }
    : { app: "runtime", web: "web" };
}

function parseArgs(argv) {
  const options = {
    variant: "full",
    only: null,
    skip: [],
    keep: false,
    trivyStrict: false,
    requireAgent: false,
  };
  const valueAfter = (name, index) => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} needs a value`);
    }
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      case "--variant":
        options.variant = valueAfter(arg, index++);
        if (options.variant !== "full" && options.variant !== "community") {
          throw new Error("--variant is full or community");
        }
        break;
      case "--image":
        options.image = valueAfter(arg, index++);
        break;
      case "--web-image":
        options.webImage = valueAfter(arg, index++);
        break;
      case "--previous-image":
        options.previousImage = valueAfter(arg, index++);
        break;
      case "--previous-web-image":
        options.previousWebImage = valueAfter(arg, index++);
        break;
      case "--version":
        options.version = valueAfter(arg, index++).replace(/^v/u, "");
        break;
      case "--revision":
        options.revision = valueAfter(arg, index++);
        break;
      case "--report":
        options.report = resolve(valueAfter(arg, index++));
        break;
      case "--work-dir":
        options.workDir = resolve(valueAfter(arg, index++));
        break;
      case "--project":
        options.project = valueAfter(arg, index++);
        break;
      case "--port-base":
        options.portBase = Number.parseInt(valueAfter(arg, index++), 10);
        break;
      case "--only":
        options.only = valueAfter(arg, index++)
          .split(",")
          .map((id) => id.trim());
        break;
      case "--skip":
        options.skip = valueAfter(arg, index++)
          .split(",")
          .map((id) => id.trim());
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--trivy-strict":
        options.trivyStrict = true;
        break;
      case "--require-agent":
        options.requireAgent = true;
        break;
      default:
        throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    }
  }
  if ((options.image === undefined) !== (options.webImage === undefined)) {
    throw new Error("--image and --web-image go together");
  }
  const defaults = variantDefaults(options.variant);
  options.report ??= defaults.report;
  options.workDir ??= defaults.workDir;
  options.project ??= defaults.project;
  options.portBase ??= defaults.portBase;
  options.logsDir = defaults.logsDir;
  options.tag = defaults.tag;
  return options;
}

/**
 * The checks in the order they run. `needs` names the checks whose work they
 * build on; `provides` what a dependent check reads from the context.
 */
const CHECKS = [
  {
    id: "1",
    name: "Install: images, compose up, migrations (new install and upgrade)",
    fn: install,
    needs: [],
  },
  { id: "2", name: "Health endpoints, worker and scheduler registered", fn: health, needs: ["1"] },
  {
    id: "3",
    name: "Passkey sign-in E2E with a virtual authenticator, tenant creation, i18n de/en",
    fn: passkey,
    needs: ["1"],
  },
  {
    id: "5",
    name: "IMAP backup and restore against Dovecot, hash comparison",
    fn: imapBackup,
    needs: ["1", "3"],
    requires: "api",
  },
  {
    id: "6",
    name: "Journal receipt, chain verification, export",
    fn: journal,
    needs: ["1", "3"],
    requires: "api",
    communitySkip:
      "skipped: the journal receiver is a Business module, which the Community build does not contain; the full build's smoke checks it",
  },
  {
    id: "7",
    name: "Standalone restore with restow-restore from the storage of check 5",
    fn: standaloneRestore,
    needs: ["1", "3", "5"],
    requires: "imap",
  },
  {
    id: "8",
    name: "Storage targets: S3 (Garage), local path, mounted directory",
    fn: storageTargets,
    needs: ["1", "3"],
    requires: "api",
    communitySkip:
      "skipped: it needs one tenant per storage target and the Community build has exactly one; the storage targets are core code, which the full build's smoke checks",
  },
  {
    id: "10",
    name: "Endpoint backup: the agent enrolls, backs up a folder, restores it",
    fn: endpoint,
    needs: ["1", "3"],
    requires: "api",
  },
  {
    id: "11",
    name: "Mail import (folder and upload) and export (EML ZIP, MBOX), compared by hash",
    fn: importExport,
    needs: ["1", "3"],
    requires: "api",
  },
  {
    id: "4",
    name: "Microsoft 365 backup and restore against the dev tenant",
    fn: m365,
    needs: ["1", "3"],
    requires: "api",
  },
  { id: "9", name: "Image scan (Trivy) and dependency audit (pnpm audit)", fn: scans, needs: [] },
];

const STACK_CHECKS = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "10", "11"]);

/** Which checks run: the selection, widened by what they need, minus what is skipped. */
export function selectChecks(all, { only, skip }) {
  const wanted = new Set(only ?? all.map((check) => check.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const check of all) {
      if (wanted.has(check.id)) {
        for (const need of check.needs) {
          if (!wanted.has(need)) {
            wanted.add(need);
            changed = true;
          }
        }
      }
    }
  }
  return all.filter((check) => wanted.has(check.id));
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function dockerInfoArch() {
  const { stdout } = await run("docker", ["info", "--format", "{{.Architecture}}"]);
  const raw = stdout.trim();
  return raw === "x86_64" ? "amd64" : raw === "aarch64" ? "arm64" : raw;
}

async function haveImage(ref) {
  const result = await run("docker", ["image", "inspect", ref], { allowFailure: true });
  return result.code === 0;
}

async function pullIfNeeded(ref, log) {
  if (await haveImage(ref)) {
    return;
  }
  log(`pulling ${ref}`);
  await run("docker", ["pull", "--quiet", ref], { timeoutMs: 900_000 });
}

function cleanDirectory(directory) {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Files a container wrote as root: remove them the same way.
    execFileSync("docker", [
      "run",
      "--rm",
      "-v",
      `${dirname(directory)}:/parent`,
      "--entrypoint",
      "sh",
      "alpine:3.22",
      "-c",
      `rm -rf /parent/${directory.split("/").pop()}`,
    ]);
  }
  mkdirSync(directory, { recursive: true });
}

/**
 * The version a build from this checkout carries. agent/build.sh refuses a release
 * version while agent/release-signing.pub still holds the placeholder (no release
 * signing key yet, agent/README.md "Release signing"); until then a local build is a
 * development build, `<version>-dev`. Release builds are not affected: they take the
 * signed agent from agent/prebuilt.
 */
export function localBuildVersion(version, releaseKeyText) {
  if (/-dev(?:\.|$)/u.test(version) || /^ssh-ed25519 /mu.test(releaseKeyText ?? "")) {
    return version;
  }
  return `${version}-dev`;
}

async function prepareImages(ctx) {
  const { options, log } = ctx;
  const images = { ...ctx.pinned };
  const tag = options.tag;
  const targets = targetsOf(options.variant);
  if (options.image) {
    await pullIfNeeded(options.image, log);
    await pullIfNeeded(options.webImage, log);
    await run("docker", ["tag", options.image, `${APP_IMAGE}:${tag}`]);
    await run("docker", ["tag", options.webImage, `${WEB_IMAGE}:${tag}`]);
    ctx.imageDescription = options.image;
  } else {
    const releaseKey = join(repoRoot, "agent/release-signing.pub");
    const version = localBuildVersion(
      options.version,
      existsSync(releaseKey) ? readFileSync(releaseKey, "utf8") : "",
    );
    if (version !== options.version) {
      log(
        `building as ${version}: agent/release-signing.pub holds no release key yet, so agent/build.sh builds only development versions`,
      );
      options.version = version;
    }
    log(
      `building the ${options.variant} images (${targets.app}, ${targets.web}) from this checkout (docker buildx, this machine's architecture)`,
    );
    const args = [
      "--build-arg",
      `RESTOW_VERSION=${options.version}`,
      "--build-arg",
      `RESTOW_REVISION=${options.revision}`,
      "--build-arg",
      `RESTOW_CREATED=${new Date().toISOString()}`,
      "--load",
    ];
    await run(
      "docker",
      ["buildx", "build", "--target", targets.app, ...args, "-t", `${APP_IMAGE}:${tag}`, repoRoot],
      {
        stream: true,
        timeoutMs: 3_600_000,
      },
    );
    await run(
      "docker",
      ["buildx", "build", "--target", targets.web, ...args, "-t", `${WEB_IMAGE}:${tag}`, repoRoot],
      {
        stream: true,
        timeoutMs: 3_600_000,
      },
    );
    ctx.imageDescription = `${options.variant} build from this checkout (${options.revision || "no git revision"}) as ${APP_IMAGE}:${tag}`;
  }
  images.app = `${APP_IMAGE}:${tag}`;
  images.web = `${WEB_IMAGE}:${tag}`;
  if (options.previousImage) {
    const previous = `${tag.replace("under-test", "previous")}`;
    await pullIfNeeded(options.previousImage, log);
    await pullIfNeeded(options.previousWebImage ?? options.previousImage, log);
    await run("docker", ["tag", options.previousImage, `${APP_IMAGE}:${previous}`]);
    if (options.previousWebImage) {
      await run("docker", ["tag", options.previousWebImage, `${WEB_IMAGE}:${previous}`]);
    }
    images.previousApp = `${APP_IMAGE}:${previous}`;
    images.previousTag = previous;
    images.previousLabel = options.previousImage;
  }
  return images;
}

async function saveLogs(ctx) {
  const directory = join(ctx.options.logsDir);
  mkdirSync(directory, { recursive: true });
  for (const service of ["postgres", "api", "worker", "scheduler", "caddy", "dovecot", "garage"]) {
    try {
      writeFileSync(join(directory, `${service}.log`), await ctx.stack.logs(service, 5000));
    } catch {
      // The service never started; nothing to save.
    }
  }
}

/**
 * Containers write into the working directory as root (the data of the storage
 * targets, the bind-mounted share). Hand it back to the user who ran the smoke,
 * so later cleanup, artifact upload and checkout steps can read and remove it.
 */
async function giveBack(ctx) {
  if (!process.getuid || !ctx.images?.app) {
    return;
  }
  await run("docker", [
    "run",
    "--rm",
    "--network",
    "none",
    "-v",
    `${ctx.options.workDir}:/w`,
    "--entrypoint",
    "chown",
    ctx.images.app,
    "-R",
    `${process.getuid()}:${process.getgid()}`,
    "/w",
  ]);
}

/** What the crash handlers need to write a report from wherever the run stopped. */
const state = {
  report: null,
  ctx: null,
  needsStack: false,
  current: null,
  finishing: false,
  started: 0,
};

async function finish() {
  if (state.finishing) {
    return;
  }
  state.finishing = true;
  const { report, ctx, needsStack } = state;
  report.checks.sort((left, right) => Number(left.id) - Number(right.id));
  if (needsStack) {
    await saveLogs(ctx).catch(() => {});
    if (ctx.options.keep) {
      ctx.log(
        `\nThe stack is still running: docker compose -p ${ctx.options.project} down --volumes`,
      );
    } else {
      await ctx.stack.down().catch(() => {});
    }
  }
  await giveBack(ctx).catch(() => {});
  writeFileSync(ctx.options.report, report.toMarkdown());
  ctx.log(`\n${report.verdict()}`);
  ctx.log(`Report: ${ctx.options.report} (${formatDuration(Date.now() - state.started)})`);
  process.exit(report.failed.length > 0 ? 1 : 0);
}

/** An error nobody caught (a bug in the smoke or a broken socket): report it, clean up, fail. */
async function crash(error) {
  console.error(error instanceof Error ? error.stack : error);
  if (!state.report || state.finishing) {
    process.exit(2);
  }
  const current = state.current;
  if (current && !state.report.checks.some((check) => check.id === current.id)) {
    state.report.add({
      ...current.runState.finish({
        failure: `the smoke itself crashed: ${error instanceof Error ? error.message : error}`,
      }),
    });
  }
  await finish();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  options.version ??= packageVersion;
  if (options.revision === undefined) {
    const head = git(["rev-parse", "HEAD"]) || process.env.GITHUB_SHA || "";
    // A checkout with uncommitted changes is not the commit: say so in the image and the report.
    options.revision = head && git(["status", "--porcelain"]) ? `${head}-dirty` : head;
  }
  const log = (line) => console.log(line);

  const selected = selectChecks(CHECKS, options);
  const needsStack = selected.some((check) => STACK_CHECKS.has(check.id));
  const arch = await dockerInfoArch();
  const { $comment: _comment, ...pinned } = JSON.parse(
    readFileSync(join(repoRoot, "scripts/smoke/images.json"), "utf8"),
  );

  cleanDirectory(options.workDir);
  cleanDirectory(options.logsDir);

  const ctx = {
    options,
    repoRoot,
    workDir: options.workDir,
    project: options.project,
    portBase: options.portBase,
    platform: `linux/${arch}`,
    pinned,
    garageImage: pinned.garage,
    log,
    images: null,
    stack: null,
    api: null,
  };

  const started = Date.now();
  log(
    `Restow release smoke: ${options.variant} build, version ${options.version}, ${ctx.platform}, project ${options.project}`,
  );
  ctx.images = await prepareImages(ctx);
  if (options.variant === "full" && needsStack) {
    // A throwaway Ed25519 key pair for this run (lib/license.mjs): the stack trusts its
    // public key, check 3 installs a Service Provider key signed with it. The private
    // key never leaves this process.
    ctx.licenseSigner = await createLicenseSigner(repoRoot);
  }
  ctx.stack = new Stack({
    repoRoot,
    dir: join(options.workDir, "stack"),
    project: options.project,
    portBase: options.portBase,
    tag: options.tag,
    garageImage: pinned.garage,
    licensePublicKey: ctx.licenseSigner?.publicKey,
  });
  if (needsStack) {
    ctx.stack.writeFiles();
    // A leftover stack of an earlier run would hold the ports and the volumes.
    await ctx.stack.down();
  }

  const report = new Report({
    variant: options.variant,
    version: options.version,
    image: ctx.imageDescription,
    revision: options.revision,
    platform: ctx.platform,
    runner: process.env.GITHUB_RUN_ID
      ? `GitHub Actions run ${process.env.GITHUB_RUN_ID} (${process.env.RUNNER_OS ?? os.platform()} ${process.env.RUNNER_ARCH ?? os.arch()})`
      : `${os.hostname()} (${os.platform()} ${os.arch()}, Node ${process.version})`,
  });

  state.report = report;
  state.ctx = ctx;
  state.needsStack = needsStack;
  state.started = started;
  process.on("uncaughtException", (error) => void crash(error));
  process.on("unhandledRejection", (error) => void crash(error));

  const done = new Map();
  let check1 = null;
  for (const definition of selected) {
    log(`\n[${definition.id}] ${definition.name}`);
    const runState = new CheckRun(definition.id, definition.name, log);
    if (options.skip.includes(definition.id)) {
      report.add({
        ...runState.finish({ skippedSummary: "skipped: left out on request (--skip)" }),
      });
      continue;
    }
    if (options.variant === "community" && definition.communitySkip) {
      report.add(runState.finish({ skippedSummary: definition.communitySkip }));
      done.set(definition.id, RESULT.SKIPPED);
      continue;
    }
    // A check is blocked when the stack did not come up, or when what it reads from an
    // earlier check (the session, the snapshot) is missing. Other failures do not block it.
    const blockedBy = definition.needs.find(
      (need) => need === "1" && done.get(need) === RESULT.FAIL,
    );
    const missing =
      definition.requires === "api"
        ? !ctx.api
        : definition.requires === "imap"
          ? !ctx.imap?.snapshot
          : false;
    if (blockedBy || missing) {
      const reason = blockedBy
        ? `blocked: check ${blockedBy} failed, which this check builds on`
        : "blocked: an earlier check did not leave what this check needs";
      report.add(runState.finish({ skippedSummary: reason }));
      done.set(definition.id, RESULT.SKIPPED);
      continue;
    }
    let thrown = null;
    state.current = { id: definition.id, runState };
    try {
      await definition.fn(ctx, runState);
    } catch (error) {
      thrown = error;
    }
    let row;
    if (thrown instanceof Skip) {
      row = runState.finish({ skippedSummary: thrown.message });
    } else if (thrown && !(thrown instanceof StepFailure)) {
      log(`    ${thrown instanceof Error ? thrown.stack : thrown}`);
      row = runState.finish({ failure: thrown instanceof Error ? thrown.message : String(thrown) });
    } else {
      row = runState.finish();
    }
    log(`    -> ${row.result}: ${row.summary}`);
    done.set(definition.id, row.result);
    if (definition.id === "1") {
      // The last step of check 1 (migrations on the populated database) runs at the end.
      check1 = { runState, row };
    } else {
      report.add(row);
    }
  }

  if (check1) {
    if (done.get("1") !== RESULT.FAIL && needsStack) {
      log("\n[1] (continued) migrations on the populated database");
      const firstDuration = check1.row.durationMs;
      const continuedAt = Date.now();
      try {
        await rerunMigrations(ctx, check1.runState);
      } catch (error) {
        log(`    ${error instanceof Error ? error.message : error}`);
      }
      check1.row = check1.runState.finish();
      // The check ran in two parts; count the time of the parts, not the time between them.
      check1.row.durationMs = firstDuration + (Date.now() - continuedAt);
      log(`    -> ${check1.row.result}: ${check1.row.summary}`);
    }
    report.add(check1.row);
  }
  state.current = null;
  await finish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(2);
  });
}

export { CHECKS, parseArgs };
