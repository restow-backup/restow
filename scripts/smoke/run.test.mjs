import assert from "node:assert/strict";
import { test } from "node:test";
import { EXPECTED_LICENSES, variantProblems } from "./checks/01-install.mjs";
import { assessReadiness } from "./checks/02-health.mjs";
import { m365Config } from "./checks/04-m365.mjs";
import { summarizeTrivy } from "./checks/09-scans.mjs";
import { compareHashes } from "./lib/graph.mjs";
import { CHECKS, localBuildVersion, parseArgs, selectChecks, targetsOf } from "./run.mjs";

test("the checks have unique ids and every dependency exists", () => {
  const ids = CHECKS.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    [...ids].sort((a, b) => Number(a) - Number(b)),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
  );
  for (const check of CHECKS) {
    for (const need of check.needs) {
      assert.ok(ids.includes(need), `${check.id} needs unknown check ${need}`);
    }
  }
});

test("--only pulls in what a check builds on, in run order", () => {
  const ids = (options) =>
    selectChecks(CHECKS, { only: null, skip: [], ...options }).map((check) => check.id);
  assert.deepEqual(ids({ only: ["7"] }), ["1", "3", "5", "7"]);
  assert.deepEqual(ids({ only: ["9"] }), ["9"]);
  assert.deepEqual(ids({}).length, 11);
});

test("check 2 takes /readyz as ready only with the database, the worker and the scheduler ok", () => {
  const ok = { status: "ready", checks: { database: true, worker: "ok", scheduler: "ok" } };
  assert.deepEqual(assessReadiness(200, ok), { ready: true, problems: [] });

  const noWorker = {
    status: "not_ready",
    checks: { database: true, worker: "missing", scheduler: "ok" },
  };
  const missing = assessReadiness(503, noWorker);
  assert.equal(missing.ready, false);
  assert.match(missing.problems.join(" "), /worker is "missing"/);
  assert.doesNotMatch(missing.problems.join(" "), /scheduler/);

  // The old placeholder and a build that does not report the roles are not ready either.
  for (const checks of [
    { database: true, worker: "stub", scheduler: "stub" },
    { database: true },
  ]) {
    const result = assessReadiness(200, { status: "ready", checks });
    assert.equal(result.ready, false);
    assert.match(result.problems.join(" "), /worker/);
    assert.match(result.problems.join(" "), /scheduler/);
  }

  assert.equal(assessReadiness(503, { status: "not_ready", checks: {} }).ready, false);
  assert.equal(assessReadiness(200, { status: "starting", checks: ok.checks }).ready, false);
  assert.equal(assessReadiness(502, null).ready, false);
});

test("check 4 needs all five dev tenant variables", () => {
  assert.deepEqual(m365Config({}).missing.length, 5);
  assert.deepEqual(m365Config({ M365_TEST_TENANT_ID: "t", M365_TEST_CLIENT_ID: "c" }).missing, [
    "M365_TEST_CLIENT_SECRET",
    "M365_TEST_MAILBOX",
    "M365_TEST_RESTORE_MAILBOX",
  ]);
  const full = m365Config({
    M365_TEST_TENANT_ID: " tenant ",
    M365_TEST_CLIENT_ID: "client",
    M365_TEST_CLIENT_SECRET: "secret",
    M365_TEST_MAILBOX: "Test.User@Contoso.onmicrosoft.com",
    M365_TEST_RESTORE_MAILBOX: "restore@contoso.onmicrosoft.com",
  });
  assert.equal(full.missing.length, 0);
  assert.equal(full.tenantId, "tenant");
  assert.equal(full.mailbox, "test.user@contoso.onmicrosoft.com");
  assert.equal(
    m365Config({ M365_TEST_TENANT_ID: "  " }).missing.includes("M365_TEST_TENANT_ID"),
    true,
  );
});

test("summarizeTrivy flattens the findings of every target", () => {
  const findings = summarizeTrivy({
    Results: [
      {
        Target: "os",
        Vulnerabilities: [
          { VulnerabilityID: "CVE-1", Severity: "CRITICAL", PkgName: "a", InstalledVersion: "1" },
        ],
      },
      {
        Target: "bin",
        Vulnerabilities: [
          {
            VulnerabilityID: "CVE-2",
            Severity: "HIGH",
            PkgName: "b",
            InstalledVersion: "2",
            FixedVersion: "3",
          },
        ],
      },
      { Target: "clean" },
    ],
  });
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.severity, finding.fixed]),
    [
      ["CVE-1", "CRITICAL", ""],
      ["CVE-2", "HIGH", "3"],
    ],
  );
});

test("compareHashes names what is missing and what differs", () => {
  const result = compareHashes(
    new Map([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]),
    new Map([
      ["a", "1"],
      ["b", "x"],
    ]),
  );
  assert.deepEqual(result, { missing: ["c"], different: ["b"] });
});

test("--variant picks the build, its targets and a stack that does not collide with the full one", () => {
  const full = parseArgs([]);
  assert.equal(full.variant, "full");
  assert.equal(full.project, "restow-smoke");
  assert.equal(full.portBase, 38300);
  assert.equal(full.tag, "under-test");
  assert.deepEqual(targetsOf("full"), { app: "runtime", web: "web" });

  const community = parseArgs(["--variant", "community"]);
  assert.equal(community.variant, "community");
  assert.equal(community.project, "restow-smoke-community");
  assert.equal(community.portBase, 38500);
  assert.equal(community.tag, "under-test-community");
  assert.match(community.report, /smoke-report-community\.md$/);
  assert.match(community.workDir, /smoke-out\/run-community$/);
  assert.deepEqual(targetsOf("community"), { app: "runtime-community", web: "web-community" });

  const explicit = parseArgs(["--variant", "community", "--project", "p", "--port-base", "40000"]);
  assert.equal(explicit.project, "p");
  assert.equal(explicit.portBase, 40000);
  assert.throws(() => parseArgs(["--variant", "enterprise"]), /full or community/);
});

test("the community variant skips exactly the journal and the storage targets, with a reason", () => {
  const skipped = CHECKS.filter((check) => check.communitySkip).map((check) => check.id);
  assert.deepEqual(skipped, ["6", "8"]);
  for (const check of CHECKS.filter((entry) => entry.communitySkip)) {
    assert.match(check.communitySkip, /^skipped: .*Community build/);
  }
});

test("check 1 tells the two builds apart by their labels and their variant marker", () => {
  const image = (licenses, env) => ({
    Config: {
      Labels: {
        "org.opencontainers.image.licenses": licenses,
        "org.opencontainers.image.revision": "abc123",
      },
      Env: env,
    },
  });
  const full = EXPECTED_LICENSES.full;
  const community = EXPECTED_LICENSES.community;
  assert.equal(full, "Apache-2.0 AND LicenseRef-Restow-Enterprise");
  assert.equal(community, "Apache-2.0");
  const revision = "RESTOW_REVISION=abc123";

  assert.deepEqual(
    variantProblems("full", image(full, ["RESTOW_IMAGE_VARIANT=full", revision]), image(full, [])),
    [],
  );
  // An image built before the variable existed reads as the full build.
  assert.deepEqual(variantProblems("full", image(full, [revision]), image(full, [])), []);
  assert.deepEqual(
    variantProblems(
      "community",
      image(community, ["RESTOW_IMAGE_VARIANT=community", revision]),
      image(community, []),
    ),
    [],
  );
  // A full image tested as the Community build, and the other way round.
  assert.equal(
    variantProblems(
      "community",
      image(full, ["RESTOW_IMAGE_VARIANT=full", revision]),
      image(full, []),
    ).length,
    3,
  );
  assert.equal(
    variantProblems(
      "full",
      image(community, ["RESTOW_IMAGE_VARIANT=community", revision]),
      image(community, []),
    ).length,
    3,
  );
  assert.match(
    variantProblems("full", image(full, []), image(full, [])).join(" "),
    /RESTOW_REVISION is ""/,
  );
});

test("a local build is a development build until the agent release key exists", () => {
  const placeholder = "# PLACEHOLDER: no release signing key has been created yet.\n";
  const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample restow-agent-release\n";
  assert.equal(localBuildVersion("0.1.0", placeholder), "0.1.0-dev");
  assert.equal(localBuildVersion("0.1.0", ""), "0.1.0-dev");
  assert.equal(localBuildVersion("0.1.0", key), "0.1.0");
  assert.equal(localBuildVersion("0.1.0-dev", placeholder), "0.1.0-dev");
  assert.equal(localBuildVersion("0.2.0-dev.3", placeholder), "0.2.0-dev.3");
});
