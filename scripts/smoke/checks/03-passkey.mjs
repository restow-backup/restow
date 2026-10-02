/**
 * Check 3: first-run setup, sign-in with a passkey (a virtual authenticator in
 * a real browser), creating a tenant through the interface, and every screen
 * in German and English without a missing translation key.
 *
 * The setup and the authenticator enrolment of the first administrator go over
 * the API (the emergency path every later check signs in with); the setup also
 * creates the operator's own organisation, the installation's first tenant (kind
 * internal, listed first), which this check proves. The browser then does what a
 * person does: emergency sign-in, register a passkey, sign out, sign in with the
 * passkey, create a tenant (a customer, next to the own organisation), walk
 * through the screens.
 *
 * Between the setup and the browser, the build decides: the full build gets a
 * Service Provider license key (lib/license.mjs), installed the way an operator
 * does it, and the api is restarted because the journal receiver reads its
 * capability at start (check 6). The Community build has no license API at all:
 * its one tenant is the own organisation, the browser creates none, and a
 * second tenant is refused.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../lib/exec.mjs";
import { installLicenseKey } from "../lib/license.mjs";
import {
  ADMIN,
  OWN_ORGANISATION,
  installationTenant,
  listTenants,
  ownOrganisationOf,
  setUpInstallation,
} from "../lib/restow.mjs";

const FEATURE_UNAVAILABLE = "urn:restow:problem:feature-unavailable";

const E2E_TENANT = { name: "Smoke E2E Tenant", slug: "smoke-e2e" };

export async function passkey(ctx, check) {
  const { stack } = ctx;

  await check.step("first-run setup and authenticator enrolment over the API", async () => {
    const result = await setUpInstallation(stack);
    ctx.api = result.api;
    ctx.totpSecret = result.totpSecret;
    return `passkey gate open for ${result.setup.passkeyReady.origin}`;
  });

  await check.step(
    "the setup created the operator's own organisation: one tenant of kind internal, named as given",
    async () => {
      const tenants = await listTenants(ctx.api);
      const own = ownOrganisationOf(tenants);
      if (tenants.length !== 1 || !own) {
        throw new Error(
          `the installation has ${tenants.length} tenants (${tenants.map((tenant) => `${tenant.slug}:${tenant.kind}`).join(", ")}), expected exactly the own organisation`,
        );
      }
      if (own.name !== OWN_ORGANISATION.name || own.slug !== OWN_ORGANISATION.slug) {
        throw new Error(
          `the own organisation is ${JSON.stringify([own.name, own.slug])}, expected ${JSON.stringify([OWN_ORGANISATION.name, OWN_ORGANISATION.slug])}`,
        );
      }
      const me = await ctx.api.get("/api/v1/me");
      if (me.tenants?.[0]?.id !== own.id || me.tenants[0].kind !== "internal") {
        throw new Error(
          `the profile does not list the own organisation first: ${JSON.stringify(me.tenants)}`,
        );
      }
      return `${own.slug} (kind ${own.kind}), first in the profile's tenants`;
    },
  );

  const community = ctx.options.variant === "community";
  if (community) {
    await check.step(
      "the Community build has no license API (GET /api/v1/license is 404)",
      async () => {
        const response = await ctx.api.request("GET", "/api/v1/license");
        if (response.status !== 404) {
          throw new Error(`GET /api/v1/license answered ${response.status}, expected 404`);
        }
        return "404, like an unknown path";
      },
    );
  } else {
    await check.step(
      "install a Service Provider license key (throwaway test signer) and restart the api",
      async () => {
        const installed = await installLicenseKey(ctx.api, ctx.licenseSigner);
        // The journal receiver (check 6) reads its capability when the api starts.
        await stack.compose(["restart", "api"]);
        await stack.waitForApi();
        const state = await ctx.api.get("/api/v1/license");
        if (state.edition !== "service_provider" || state.source !== "key") {
          throw new Error(
            `after the restart the api reports the edition ${state.edition} from ${state.source}`,
          );
        }
        return `edition ${installed.edition} from an installed key (verification key: ${state.verification?.source ?? "unknown"}); api restarted, session kept`;
      },
    );
  }

  const outDir = join(ctx.workDir, "e2e");
  mkdirSync(outDir, { recursive: true });
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const script = [
    "set -u",
    "mkdir -p /work",
    "cp /smoke/e2e/package.json /smoke/e2e/package-lock.json /smoke/e2e/passkey.mjs /work/",
    "cd /work",
    "npm ci --ignore-scripts --no-audit --no-fund > /out/npm.log 2>&1 || { echo 'npm ci failed'; cat /out/npm.log; chown -R \"$HOST_UID:$HOST_GID\" /out; exit 3; }",
    "node passkey.mjs",
    "code=$?",
    'chown -R "$HOST_UID:$HOST_GID" /out',
    "exit $code",
  ].join("\n");

  ctx.log(
    "    running the browser in the Playwright container (host network, virtual authenticator)",
  );
  const result = await run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "host",
      "--ipc",
      "host",
      "-v",
      `${ctx.repoRoot}/scripts/smoke:/smoke:ro`,
      "-v",
      `${ctx.repoRoot}/packages/i18n/resources:/i18n:ro`,
      "-v",
      `${outDir}:/out`,
      "-v",
      "restow-smoke-npm-cache:/root/.npm",
      "-e",
      `BASE_URL=${stack.publicUrl}`,
      "-e",
      `ADMIN_EMAIL=${ADMIN.email}`,
      "-e",
      `ADMIN_PASSWORD=${ADMIN.password}`,
      "-e",
      `TOTP_SECRET=${ctx.totpSecret}`,
      "-e",
      `TENANT_NAME=${E2E_TENANT.name}`,
      "-e",
      `TENANT_SLUG=${E2E_TENANT.slug}`,
      // The Community build has its one tenant already (the own organisation): no wizard to run.
      "-e",
      `TENANT_WIZARD=${community ? "skip" : "run"}`,
      "-e",
      `HOST_UID=${uid}`,
      "-e",
      `HOST_GID=${gid}`,
      "--entrypoint",
      "sh",
      ctx.images.playwright,
      "-c",
      script,
    ],
    { allowFailure: true, timeoutMs: 600_000 },
  );
  if (result.stdout.trim()) {
    ctx.log(result.stdout.trim().replace(/^/gmu, "      "));
  }
  const resultFile = join(outDir, "e2e-result.json");
  if (!existsSync(resultFile)) {
    check.steps.push({
      name: "the browser run produced a result",
      result: "FAIL",
      detail:
        `${result.stderr.trim().split("\n").slice(-6).join(" ")} ${result.stdout.trim().split("\n").slice(-6).join(" ")}`.trim(),
    });
    throw new Error("the browser run left no result file");
  }
  const { steps } = JSON.parse(readFileSync(resultFile, "utf8"));
  let failed = 0;
  for (const step of steps) {
    check.steps.push({ name: step.name, result: step.ok ? "PASS" : "FAIL", detail: step.detail });
    if (!step.ok) {
      failed += 1;
    }
  }
  if (!community) {
    await check.step(
      "the tenant created in the browser is a customer, listed after the own organisation",
      async () => {
        const tenants = await listTenants(ctx.api);
        const slugs = tenants.map((tenant) => `${tenant.slug}:${tenant.kind}`);
        const created = tenants.find((tenant) => tenant.slug === E2E_TENANT.slug);
        if (!created) {
          // The browser steps report why; this check has nothing more to say about a missing tenant.
          return `${E2E_TENANT.slug} was not created (the browser steps say why)`;
        }
        if (created.kind !== "customer" || tenants[0]?.kind !== "internal") {
          throw new Error(
            `expected the own organisation first and ${E2E_TENANT.slug} as a customer, got ${slugs.join(", ")}`,
          );
        }
        return slugs.join(", ");
      },
    );
  }
  if (community) {
    await check.step(
      "the Community build keeps one tenant, its own organisation: a second one is refused (403 feature-unavailable)",
      async () => {
        const tenant = await installationTenant(ctx);
        const response = await ctx.api.request("POST", "/api/v1/tenants", {
          body: { name: "Smoke Second Tenant", slug: "smoke-second" },
        });
        if (response.status !== 403 || response.body?.type !== FEATURE_UNAVAILABLE) {
          throw new Error(
            `creating a second tenant answered ${response.status} ${JSON.stringify(response.body?.type ?? response.body)}, expected 403 ${FEATURE_UNAVAILABLE}`,
          );
        }
        return `the one tenant is the own organisation ${tenant.slug}; a second answered 403 ${FEATURE_UNAVAILABLE}`;
      },
    );
  }
  if (failed > 0 || result.code !== 0) {
    throw new Error(
      `${failed} browser step${failed === 1 ? "" : "s"} failed; screenshots are in ${outDir}`,
    );
  }
}
