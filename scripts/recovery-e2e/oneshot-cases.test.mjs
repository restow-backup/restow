import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FRESH_IMAGES,
  freshIdentity,
  ONESHOT_ANSWERS_FORMAT,
  ONESHOT_CASES,
  oneshotAnswers,
  oneshotSource,
  releaseBody,
  SOURCE_IMAGES,
  selectOneshotCases,
} from "./oneshot-cases.mjs";
import { identityOf } from "./run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");

describe("oneshot cases (docs/BAREMETAL-ONESHOT.md 19.3)", () => {
  it("has the six cases of the design, O-E1 and O-E2 per pull request", () => {
    assert.deepEqual(
      ONESHOT_CASES.map((item) => item.id),
      ["O-E1", "O-E2", "O-E3", "O-E4", "O-E5", "O-E6"],
    );
    assert.deepEqual(
      selectOneshotCases("per-pr").map((item) => item.id),
      ["O-E1", "O-E2"],
    );
    assert.deepEqual(
      selectOneshotCases("nightly").map((item) => item.id),
      ["O-E3", "O-E4", "O-E5", "O-E6"],
    );
    assert.deepEqual(
      selectOneshotCases("o-e5, O-E3").map((item) => item.id),
      ["O-E5", "O-E3"],
    );
    assert.throws(() => selectOneshotCases("O-E9"), /unknown oneshot case O-E9/);
  });

  it("names sources and images that exist", () => {
    for (const testCase of ONESHOT_CASES) {
      const src = oneshotSource(testCase);
      assert.ok(src.disks.length > 0, testCase.id);
      if (!testCase.source.case) {
        assert.ok(SOURCE_IMAGES.includes(src.image), `${testCase.id}: source image ${src.image}`);
      }
      assert.ok(
        FRESH_IMAGES.includes(testCase.fresh.image),
        `${testCase.id}: ${testCase.fresh.image}`,
      );
      assert.ok(["bios", "uefi", "uefi-sb"].includes(testCase.fresh.firmware), testCase.id);
      for (const milestone of testCase.needs) {
        assert.match(milestone, /^O[1-9]$/, testCase.id);
      }
      assert.ok(testCase.needs.includes("O3"), `${testCase.id}: every case runs the command`);
    }
  });

  it("gives the fresh machine another network than the source", () => {
    for (const testCase of ONESHOT_CASES) {
      const net = testCase.fresh.network;
      assert.ok(["static", "dhcp"].includes(net.kind), testCase.id);
      if (net.kind === "static") {
        assert.match(net.address4, /^\d+\.\d+\.\d+\.\d+\/\d+$/);
        assert.ok(net.onlink, `${testCase.id}: the Hetzner form has an on-link gateway`);
      }
    }
  });

  it("writes answers the command takes: disks only, no code", () => {
    // The format and the keys of agent/internal/oneshot/answers.go.
    const go = readFileSync(join(repo, "agent/internal/oneshot/answers.go"), "utf8");
    assert.ok(go.includes(`AnswersFormat = "${ONESHOT_ANSWERS_FORMAT}"`));
    for (const testCase of ONESHOT_CASES) {
      const answers = oneshotAnswers(testCase);
      assert.deepEqual(Object.keys(answers).sort(), ["confirmErase", "format"]);
      assert.equal(answers.format, ONESHOT_ANSWERS_FORMAT);
      assert.equal(answers.confirmErase.length, testCase.fresh.disks.length);
      assert.ok(!JSON.stringify(answers).includes("OS-"));
      // The same identities recover and the ISO cases use.
      for (const disk of testCase.fresh.disks) {
        assert.equal(freshIdentity(disk), identityOf(disk));
      }
    }
  });

  it("releases with the body of the api, or not at all", () => {
    const schema = readFileSync(join(repo, "apps/api/src/features/endpoints/schemas.ts"), "utf8");
    for (const testCase of ONESHOT_CASES) {
      const body = releaseBody(testCase);
      if (testCase.release.decision !== "approve") {
        assert.equal(body, null, testCase.id);
        assert.notEqual(testCase.expect.result, "succeeded", testCase.id);
        assert.ok(testCase.expect.checks.includes("disk-unchanged"), testCase.id);
        continue;
      }
      assert.ok(["takeover", "keep"].includes(body.networkMode), testCase.id);
      for (const key of Object.keys(body)) {
        assert.ok(schema.includes(`    ${key}: z.`), `approveOneshotSchema lacks ${key}`);
      }
      assert.equal(testCase.expect.result, "succeeded", testCase.id);
    }
  });

  it("expects the refused test load under Secure Boot to change nothing", () => {
    const sb = ONESHOT_CASES.find((item) => item.id === "O-E3");
    assert.equal(sb.fresh.firmware, "uefi-sb");
    assert.equal(sb.expect.kexec, "failed");
    // The exit codes of the command (agent/internal/oneshot/flow.go).
    const flow = readFileSync(join(repo, "agent/internal/oneshot/flow.go"), "utf8");
    const code = (name) => Number(flow.match(new RegExp(`\\t${name} = (\\d+)`))?.[1]);
    assert.equal(sb.expect.commandExit, code("ExitRefused"));
    const rejected = ONESHOT_CASES.find((item) => item.id === "O-E5");
    assert.equal(rejected.expect.commandExit, code("ExitEnded"));
  });
});
