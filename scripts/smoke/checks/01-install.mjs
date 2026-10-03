/**
 * Check 1: the images, `docker compose up` from the release compose file, the
 * database migrations on an empty database (new install) and on the database of
 * the previous release (upgrade), and again on the populated database at the end.
 *
 * The images are checked against the build they claim to be (docs/CI.md, "Image
 * assertions"): the licenses label and RESTOW_IMAGE_VARIANT of the full or the
 * Community build, no license signing code in either image, no ee/ code at all
 * in the Community images and the ee/ modules in the full one
 * (scripts/docker/check-image-tree.mjs, the check the Dockerfile runs as well).
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildCorpus } from "../lib/corpus.mjs";
import { run, waitFor } from "../lib/exec.mjs";
import { ImapClient } from "../lib/imap-lite.mjs";
import {
  ADMIN,
  addImapMailbox,
  createTenant,
  listTenants,
  ownOrganisationOf,
  setUpInstallation,
  signIn,
  waitForSnapshot,
} from "../lib/restow.mjs";
import { APP_IMAGE, Stack, WEB_IMAGE } from "../lib/stack.mjs";

const ROLES = ["restow_app", "restow_provider"];

/** The licenses label of each build's images (Dockerfile). */
export const EXPECTED_LICENSES = {
  full: "Apache-2.0 AND LicenseRef-Restow-Enterprise",
  community: "Apache-2.0",
};

/** The environment an image starts its processes with, as a map. */
function envOf(image) {
  return Object.fromEntries(
    (image.Config?.Env ?? []).map((line) => [
      line.slice(0, line.indexOf("=")),
      line.slice(line.indexOf("=") + 1),
    ]),
  );
}

/**
 * Whether an image is the build it is tested as: its licenses label, its
 * RESTOW_IMAGE_VARIANT (unset or `full` in the full build) and a RESTOW_REVISION
 * equal to its revision label. Returns the problems, empty when it is.
 */
export function variantProblems(variant, app, web) {
  const problems = [];
  const expected = EXPECTED_LICENSES[variant];
  for (const [name, image] of [
    ["application", app],
    ["web edge", web],
  ]) {
    const licenses = image.Config?.Labels?.["org.opencontainers.image.licenses"];
    if (licenses !== expected) {
      problems.push(
        `the ${name} image is labelled "${licenses}", the ${variant} build "${expected}"`,
      );
    }
  }
  const env = envOf(app);
  const marker = env.RESTOW_IMAGE_VARIANT ?? "";
  if (variant === "community" ? marker !== "community" : !["", "full"].includes(marker)) {
    problems.push(`RESTOW_IMAGE_VARIANT is "${marker}" in an image tested as the ${variant} build`);
  }
  const revision = app.Config?.Labels?.["org.opencontainers.image.revision"] ?? "";
  if ((env.RESTOW_REVISION ?? "") !== revision) {
    problems.push(
      `RESTOW_REVISION is "${env.RESTOW_REVISION ?? ""}", the revision label "${revision}"`,
    );
  }
  return problems;
}

/** Run scripts/docker/check-image-tree.mjs with `args` inside the application image. */
async function checkAppTree(ctx, args) {
  const result = await run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "-v",
      `${ctx.repoRoot}/scripts/docker:/check:ro`,
      "--entrypoint",
      "node",
      ctx.images.app,
      "/check/check-image-tree.mjs",
      ...args,
    ],
    { allowFailure: true, timeoutMs: 300_000 },
  );
  if (result.code !== 0) {
    throw new Error(`application image: ${`${result.stderr}${result.stdout}`.trim()}`);
  }
  return result.stdout.trim();
}

/** Copy the web interface out of the edge image and run the same check on it. */
async function checkWebTree(ctx, variant) {
  const dir = join(ctx.workDir, "web-srv");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { stdout } = await run("docker", ["create", ctx.images.web]);
  const container = stdout.trim();
  try {
    await run("docker", ["cp", `${container}:/srv/.`, dir]);
  } finally {
    await run("docker", ["rm", container], { allowFailure: true });
  }
  const result = await run(
    process.execPath,
    [join(ctx.repoRoot, "scripts/docker/check-image-tree.mjs"), "--variant", variant, dir],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    throw new Error(`web edge image: ${`${result.stderr}${result.stdout}`.trim()}`);
  }
  return result.stdout.trim().replace(dir, "/srv");
}

async function inspect(image) {
  const { stdout } = await run("docker", ["image", "inspect", image]);
  return JSON.parse(stdout)[0];
}

/** The number of migrations an image ships (its drizzle journal). */
async function shippedMigrations(image) {
  const { stdout } = await run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "cat",
    image,
    "/prod/api/node_modules/@restow/db/drizzle/meta/_journal.json",
  ]);
  return JSON.parse(stdout).entries.length;
}

async function appliedMigrations(stack) {
  return Number.parseInt(await stack.sql("select count(*) from drizzle.__drizzle_migrations"), 10);
}

const TOOLS_SCRIPT = `
set -eu
if find /prod \\( -path "*/@tutao/*" -o -name "oxmsg*" \\) | grep -q .; then echo "@tutao/oxmsg is in the image"; exit 1; fi
test -d /var/lib/restow/import
for file in LICENSE NOTICE THIRD_PARTY_NOTICES.md restic-LICENSE go-LICENSE msgreader-LICENSE shadcn-ui-LICENSE; do
  test -s "/usr/share/doc/restow/$file" || { echo "/usr/share/doc/restow/$file is missing"; exit 1; }
done
echo "no @tutao/oxmsg in the production trees, import folder present, license texts in /usr/share/doc/restow"
restic version
restow-restore --help > /dev/null && echo "restow-restore runs"
if ls /srv/agent/*/*/restow-agent > /dev/null 2>&1; then
  for dir in /srv/agent/*/*/; do
    (cd "$dir" && sha256sum -c SHA256SUMS > /dev/null) || { echo "checksum mismatch in $dir"; exit 1; }
  done
  echo "agent downloads:" $(ls -d /srv/agent/*/*/ | wc -l) "targets verified against SHA256SUMS"
  ls /srv/agent/install
else
  echo "NO-AGENT"
fi
`;

export async function install(ctx, check) {
  const { stack, images, options } = ctx;

  await check.step("the images under test carry the expected metadata", async () => {
    const app = await inspect(images.app);
    const web = await inspect(images.web);
    const platform = `${app.Os}/${app.Architecture}`;
    if (ctx.platform && platform !== ctx.platform) {
      throw new Error(`the application image is ${platform}, this run tests ${ctx.platform}`);
    }
    const labels = app.Config.Labels ?? {};
    for (const key of ["title", "description", "source", "licenses", "version", "revision"]) {
      if (labels[`org.opencontainers.image.${key}`] === undefined) {
        throw new Error(`the application image has no org.opencontainers.image.${key} label`);
      }
    }
    if (options.version && labels["org.opencontainers.image.version"] !== options.version) {
      throw new Error(
        `the image says version "${labels["org.opencontainers.image.version"]}", this run tests "${options.version}"`,
      );
    }
    if (!web.Config.Labels?.["org.opencontainers.image.source"]) {
      throw new Error("the web edge image has no org.opencontainers.image.source label");
    }
    ctx.imageFacts = {
      platform,
      version: labels["org.opencontainers.image.version"],
      revision: labels["org.opencontainers.image.revision"],
      sizeMb: Math.round(app.Size / 1_000_000),
    };
    return `${platform}, version "${ctx.imageFacts.version}", revision "${ctx.imageFacts.revision}", ${ctx.imageFacts.sizeMb} MB`;
  });

  const variant = options.variant ?? "full";
  await check.step(
    `the images are the ${variant} build: licenses label, RESTOW_IMAGE_VARIANT, RESTOW_REVISION`,
    async () => {
      const app = await inspect(images.app);
      const web = await inspect(images.web);
      const problems = variantProblems(variant, app, web);
      if (problems.length > 0) {
        throw new Error(problems.join("; "));
      }
      const env = envOf(app);
      return `licenses "${EXPECTED_LICENSES[variant]}", RESTOW_IMAGE_VARIANT=${env.RESTOW_IMAGE_VARIANT || "(unset)"}, RESTOW_REVISION=${env.RESTOW_REVISION || "(empty)"}`;
    },
  );

  await check.step(
    variant === "community"
      ? "no ee/ code and no license signing code in either Community image"
      : "no license signing code in either image, and the ee/ modules in the api and the worker",
    async () => {
      const lines = [await checkAppTree(ctx, ["--variant", variant, "/prod"])];
      if (variant === "full") {
        lines.push(
          await checkAppTree(ctx, [
            "--variant",
            "full",
            "--require-ee",
            "/prod/api",
            "/prod/worker",
          ]),
        );
      }
      lines.push(await checkWebTree(ctx, variant));
      return lines.join("; ").replaceAll("\n", "; ");
    },
  );

  await check.step("restic, restow-restore and the agent downloads are in the image", async () => {
    const { stdout } = await run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      "sh",
      images.app,
      "-c",
      TOOLS_SCRIPT,
    ]);
    if (stdout.includes("NO-AGENT")) {
      if (options.requireAgent) {
        throw new Error(
          "the image ships no agent binaries under /srv/agent, and this run requires them",
        );
      }
      check.skip(
        "the agent binaries under /srv/agent are checked",
        "this image was built without agent/",
      );
    }
    return stdout.trim().split("\n").join("; ");
  });

  await check.step(
    "the release compose file is valid, with and without the updater profile",
    async () => {
      await stack.compose(["config", "--quiet"]);
      await stack.compose(["--profile", "updater", "config", "--quiet"]);
    },
  );

  await check.step("fresh install: docker compose up on an empty database", async () => {
    await stack.up(["postgres", "api", "worker", "scheduler", "caddy", "dovecot", "garage"]);
    await stack.waitForApi();
    const shipped = await shippedMigrations(images.app);
    const applied = await appliedMigrations(stack);
    if (applied !== shipped) {
      throw new Error(`${applied} migrations applied, the image ships ${shipped}`);
    }
    const roles = (
      await stack.sql("select rolname from pg_roles where rolname like 'restow%' order by 1")
    )
      .split("\n")
      .filter((name) => name !== "restow");
    for (const role of ROLES) {
      if (!roles.includes(role)) {
        throw new Error(`the database role ${role} was not created`);
      }
    }
    const tables = Number.parseInt(
      await stack.sql(
        "select count(*) from information_schema.tables where table_schema = 'public'",
      ),
      10,
    );
    if (tables < 20) {
      throw new Error(`only ${tables} tables exist after the migrations`);
    }
    const rls = await stack.sql(
      "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity",
    );
    return `${applied} migrations applied to an empty database, ${tables} tables, ${rls} of them with row level security`;
  });

  if (images.previousApp) {
    await check.step(`upgrade path: ${images.previousLabel} to this version`, () =>
      upgradeFromPrevious(ctx),
    );
  } else {
    check.skip(
      "upgrade path from the previous release",
      "no earlier public release exists (this is the first); the upgrade path is checked from the next release on",
    );
  }
}

/**
 * The upgrade: a stack of the previous release with real data (a tenant, a
 * mailbox, a backup), then the images switched to this version in place. The
 * migrations run on that database; the data must still be there and restorable.
 */
async function upgradeFromPrevious(ctx) {
  const stack = new Stack({
    repoRoot: ctx.repoRoot,
    dir: `${ctx.workDir}/upgrade`,
    project: `${ctx.project}-upgrade`,
    portBase: ctx.portBase + 100,
    tag: ctx.images.previousTag ?? "previous",
    garageImage: ctx.garageImage,
  });
  stack.writeFiles();
  const services = ["postgres", "api", "worker", "scheduler", "dovecot"];
  try {
    await stack.up(services);
    await stack.waitForApi();
    const before = await appliedMigrations(stack);
    const { api, totpSecret } = await setUpInstallation(stack);
    // From 0.2.0 on the setup creates the own organisation, and an installation without a
    // license key has only that one tenant; 0.1.0 created none, so the check made its own.
    const tenant =
      ownOrganisationOf(await listTenants(api)) ??
      (await createTenant(api, "Upgrade Tenant", "upgrade"));
    const login = "upgrade@smoke.test";
    const imap = await ImapClient.connect({
      host: "127.0.0.1",
      port: stack.ports.imap,
      user: login,
      password: stack.imapPassword,
    });
    for (const message of buildCorpus({
      seed: 5,
      mailbox: login,
      count: 8,
      folders: { INBOX: 1 },
    })) {
      await imap.append("INBOX", message.bytes);
    }
    await imap.logout();
    const { objectId } = await addImapMailbox(api, tenant.id, {
      stack,
      login,
      name: "Upgrade box",
    });
    const first = await waitForSnapshot(api, tenant.id, objectId);

    // Switch both images to the version under test; the volumes stay.
    stack.setTag(ctx.options.tag ?? "under-test");
    await stack.up(services);
    await stack.waitForApi();
    const after = await appliedMigrations(stack);
    const shipped = await shippedMigrations(ctx.images.app);
    if (after !== shipped) {
      throw new Error(
        `after the upgrade ${after} migrations are applied, the image ships ${shipped}`,
      );
    }
    const again = await signIn(stack, totpSecret);
    // This installation can have only one tenant (no license key) and has exactly one: the own
    // organisation, either created by the previous release's setup or, coming from 0.1.0
    // (which knew none), marked as the own one on the first start of the new version.
    const upgraded = await listTenants(again);
    if (upgraded.length !== 1 || upgraded[0].id !== tenant.id || upgraded[0].kind !== "internal") {
      throw new Error(
        `after the upgrade the tenant list is ${JSON.stringify(upgraded.map((entry) => [entry.slug, entry.kind]))}, expected the one tenant of the previous release as the own organisation`,
      );
    }
    const objects = await again.get("/api/v1/jobs/objects", { tenantId: tenant.id });
    const object = objects.items.find((entry) => entry.id === objectId);
    if (!object?.lastSnapshot || object.lastSnapshot.sequence < first.sequence) {
      throw new Error("the backup made before the upgrade is gone");
    }
    const queued = await again.post("/api/v1/verify", {}, { tenantId: tenant.id });
    await waitFor(
      "the restore check of the upgraded installation",
      async () => {
        const latest = await again.get("/api/v1/verify/latest", { tenantId: tenant.id });
        const entry = latest.objects.find((candidate) => candidate.object.id === objectId);
        return entry?.state === "green" ? entry : null;
      },
      { timeoutMs: 120_000, intervalMs: 2000 },
    );
    void queued;
    void ADMIN;
    return `${before} -> ${after} migrations on a database with a tenant and a backup; the tenant is the own organisation, the backup is still there and proven restorable`;
  } finally {
    await stack.down();
  }
}

/**
 * Last step of check 1: restart the api on the database everything else has
 * filled. The migrations run again (they must be a no-op) and nothing is lost.
 */
export async function rerunMigrations(ctx, check) {
  const { stack, images } = ctx;
  await check.step(
    "migrations run again on the populated database and change nothing",
    async () => {
      const before = await appliedMigrations(stack);
      const tenantsBefore = await stack.sql("select count(*) from tenants");
      const snapshotsBefore = await stack.sql("select count(*) from snapshots");
      await stack.compose(["restart", "api"]);
      await stack.waitForApi();
      const after = await appliedMigrations(stack);
      const shipped = await shippedMigrations(images.app);
      if (after !== before || after !== shipped) {
        throw new Error(`migrations before ${before}, after ${after}, shipped ${shipped}`);
      }
      const tenantsAfter = await stack.sql("select count(*) from tenants");
      const snapshotsAfter = await stack.sql("select count(*) from snapshots");
      // The scheduler keeps making backups in the background: snapshots may grow, never shrink.
      if (tenantsAfter !== tenantsBefore || Number(snapshotsAfter) < Number(snapshotsBefore)) {
        throw new Error(
          `tenants ${tenantsBefore} -> ${tenantsAfter}, snapshots ${snapshotsBefore} -> ${snapshotsAfter}`,
        );
      }
      return `${after} migrations applied, ${tenantsAfter} tenants kept, snapshots ${snapshotsBefore} -> ${snapshotsAfter} (none lost)`;
    },
  );
}

export { APP_IMAGE, WEB_IMAGE };
