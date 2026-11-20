import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FRESH_IMAGES,
  FRESH_MAC,
  freshCommandScript,
  freshIdentity,
  freshNetworkConfig,
  freshSeed,
  judgeOneshot,
  netEvidence,
  ONESHOT_ANSWERS_FORMAT,
  ONESHOT_CASES,
  oneshotAnswers,
  oneshotSource,
  releaseBody,
  SOURCE_IMAGES,
  selectOneshotCases,
} from "./oneshot-cases.mjs";
import { identityOf, ONESHOT_REBOOT_COUNTDOWN, selectRunCases } from "./run.mjs";

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

  it("writes answers the command takes: the disks, the passphrase of LUKS, no code", () => {
    // The format and the keys of agent/internal/oneshot/answers.go.
    const go = readFileSync(join(repo, "agent/internal/oneshot/answers.go"), "utf8");
    assert.ok(go.includes(`AnswersFormat = "${ONESHOT_ANSWERS_FORMAT}"`));
    assert.ok(go.includes('`json:"passphrase,omitempty"`'));
    for (const testCase of ONESHOT_CASES) {
      const luks = Boolean(oneshotSource(testCase).passphrase);
      if (luks) {
        // Without it the command ends before the release (passphrase_missing).
        assert.throws(() => oneshotAnswers(testCase), /need its passphrase/);
      }
      const answers = oneshotAnswers(testCase, { passphrase: "e2e-secret" });
      assert.deepEqual(
        Object.keys(answers).sort(),
        luks ? ["confirmErase", "format", "passphrase"] : ["confirmErase", "format"],
        testCase.id,
      );
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
      const body = releaseBody(testCase, "483 914");
      if (testCase.release.decision !== "approve") {
        assert.equal(body, null, testCase.id);
        assert.notEqual(testCase.expect.result, "succeeded", testCase.id);
        assert.ok(testCase.expect.checks.includes("disk-unchanged"), testCase.id);
        continue;
      }
      assert.ok(["takeover", "keep"].includes(body.networkMode), testCase.id);
      // The match code the API shows the admin travels with the release (approveOneshotSchema).
      assert.equal(body.matchCode, "483 914");
      assert.throws(() => releaseBody(testCase, undefined), /no match code/);
      for (const key of Object.keys(body)) {
        assert.match(
          schema,
          new RegExp(`\\n {4}${key}: z\\b`),
          `approveOneshotSchema lacks ${key}`,
        );
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

  it("seeds the fresh machine with the command, its files and the case's network", () => {
    const testCase = ONESHOT_CASES.find((item) => item.id === "O-E1");
    const seed = freshSeed(testCase, {
      instanceUrl: "https://restow-e2e.10.0.2.2.nip.io:39343",
      code: "OS-ABCDE-FGHIJ-KLMNO",
      caPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n",
      sumsSha256: "a".repeat(64),
      answers: oneshotAnswers(testCase, { passphrase: "e2e-secret" }),
    });
    assert.deepEqual(Object.keys(seed).sort(), ["meta-data", "network-config", "user-data"]);
    assert.ok(seed["user-data"].startsWith("#cloud-config\n"));
    const userData = JSON.parse(seed["user-data"].slice("#cloud-config\n".length));
    const files = Object.fromEntries(userData.write_files.map((file) => [file.path, file]));
    assert.equal(files["/root/restow-oneshot/code"].permissions, "0600");
    assert.equal(files["/root/restow-oneshot/answers.json"].permissions, "0600");
    assert.deepEqual(userData.runcmd, [["/root/restow-oneshot/run.sh"]]);
    // The code goes to the command in the environment (and so over stdin), never as an argument.
    const script = files["/root/restow-oneshot/run.sh"].content;
    assert.ok(!script.includes("OS-ABCDE"));
    assert.match(script, /\| *\n? *RESTOW_ONESHOT_CODE="\$\(cat \/root\/restow-oneshot\/code\)"/);
    assert.match(script, /RESTOW_SHA256SUMS_SHA256=a{64} sh -s -- --answers /);
    assert.match(script, /--cacert \/root\/restow-oneshot\/ca.pem 'https:\/\/restow-e2e/);
    assert.equal(JSON.parse(seed["meta-data"])["instance-id"], "restow-o-e1");
    assert.deepEqual(
      JSON.parse(seed["network-config"]),
      freshNetworkConfig(testCase.fresh.network),
    );
    assert.throws(() =>
      freshCommandScript({ instanceUrl: "https://x'; rm -rf /", sumsSha256: "a".repeat(64) }),
    );
    assert.throws(() => freshSeed(testCase, { code: "not a code" }), /not a oneshot code/);
  });

  it("gives the static form one IPv4 default route on-link and no router advertisements", () => {
    const testCase = ONESHOT_CASES.find((item) => item.id === "O-E1");
    const config = freshNetworkConfig(testCase.fresh.network);
    const eth = config.ethernets.eth0;
    assert.deepEqual(eth.match, { macaddress: FRESH_MAC });
    assert.equal(eth["set-name"], "eth0");
    assert.deepEqual(eth.addresses, ["10.0.2.15/32"]);
    assert.deepEqual(eth.routes, [{ to: "0.0.0.0/0", via: "10.0.2.2", "on-link": true }]);
    // QEMU's router advertisements would add a second IPv6 default route the command refuses.
    assert.equal(eth["accept-ra"], false);
    const dhcp = freshNetworkConfig({ kind: "dhcp" });
    assert.equal(dhcp.ethernets.eth0.dhcp4, true);
  });

  it("judges the restored system by its E2E-NET line", () => {
    const o1 = ONESHOT_CASES.find((item) => item.id === "O-E1");
    const o2 = ONESHOT_CASES.find((item) => item.id === "O-E2");
    const log = "noise\nE2E-NET before=yes static=10.0.2.15/32 \nE2E-BOOT e2-ubuntu2404 abc\n";
    assert.deepEqual(netEvidence(log), { before: true, static: ["10.0.2.15/32"] });
    assert.deepEqual(judgeOneshot(o1, netEvidence(log)), []);
    assert.deepEqual(netEvidence("E2E-NET before=no static=none\n"), { before: false, static: [] });
    const failures = judgeOneshot(o1, netEvidence("E2E-NET before=no static=192.168.1.5/24\n"));
    assert.equal(failures.length, 2);
    assert.match(failures[1], /lacks 10.0.2.15\/32/);
    assert.deepEqual(judgeOneshot(o2, netEvidence("E2E-NET before=yes static=none\n")), []);
    assert.deepEqual(judgeOneshot(o2, null), ["the restored system printed no E2E-NET line"]);
    // The line the factory's boot marker prints (lib.sh), in the same form.
    const lib = readFileSync(join(repo, "integrations/recovery/test/machines/lib.sh"), "utf8");
    assert.ok(lib.includes(`printf 'E2E-NET before=%s static=%s\\n'`));
  });

  it("waits for recover's restart countdown, in either language", () => {
    const text = readFileSync(join(repo, "agent/internal/recovery/text_oneshot.go"), "utf8");
    const lines = [...text.matchAll(/"oneshot\.reboot": +"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line.replace("{seconds}", "60"), ONESHOT_REBOOT_COUNTDOWN);
    }
  });

  it("runs oneshot cases by their ids, next to the ISO cases", () => {
    assert.deepEqual(
      selectRunCases("O-E1").map((item) => item.id),
      ["O-E1"],
    );
    assert.deepEqual(
      selectRunCases("E1, o-e2").map((item) => item.id),
      ["E1", "O-E2"],
    );
    // The keywords keep selecting the ISO and probe cases only.
    assert.ok(selectRunCases("per-pr").every((item) => !item.fresh));
    assert.throws(() => selectRunCases("O-E9"), /unknown oneshot case/);
  });
});
