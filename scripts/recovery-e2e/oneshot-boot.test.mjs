import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { cmdline, resultOf, runScript, sessionData, TEST_SECRET } from "./oneshot-boot.mjs";

const AGENT =
  "boot=live components live-media=/restow/medium live-media-timeout=30 noswap nopersistence " +
  "modprobe.blacklist=amdgpu,radeon,nouveau,xe restow.oneshot=1 restow.keymap=us console=ttyS0,115200n8 restow.console=ttyS0\n";

test("the command line is the agent's, with the recovery program masked and the check run", () => {
  const line = cmdline(AGENT);
  assert.ok(line.startsWith(AGENT.trim()));
  assert.match(line, / systemd\.mask=restow-recover\.service /);
  assert.match(line, /systemd\.run="\/usr\/bin\/sh -c '.*run\.sh'"/);
  assert.ok(!line.includes(TEST_SECRET), "the session secret is not on the command line");
  assert.throws(() => cmdline("boot=live components"), /restow\.oneshot=1/);
});

test("the session data is valid oneshot data with the test secret", () => {
  const data = JSON.parse(sessionData());
  assert.equal(data.format, "restow-oneshot-v1");
  assert.equal(data.session.secret, TEST_SECRET);
  assert.deepEqual(data.confirmErase, ["serial.restow-oneshot-disk0"]);
});

test("the check compares the bytes and looks for the secret on the command line", () => {
  const sha = createHash("sha256").update(sessionData()).digest("hex");
  const script = runScript(sha);
  assert.ok(script.includes(sha));
  assert.ok(script.includes(`grep -c '${TEST_SECRET}' /proc/cmdline`));
  assert.ok(script.includes('"rootfs[/restow/medium]"'));
  assert.throws(() => runScript("x"), /dataSha256/);
});

test("the result line counts the failures", () => {
  assert.equal(resultOf("PASS: a\nONESHOT-BOOT-RESULT 0\n"), 0);
  assert.equal(resultOf("FAIL: a\nONESHOT-BOOT-RESULT 2\n"), 2);
  assert.equal(resultOf("no result"), null);
});
