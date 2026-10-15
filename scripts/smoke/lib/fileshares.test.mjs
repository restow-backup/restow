import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACL_FILE,
  ACL_SID,
  DENIED_FILE,
  EXCLUDED_FILE,
  NON_ASCII_FILE,
  aclEntries,
  compareHashes,
  describeDifference,
  expectedInBackup,
  fileBytes,
  hasAclEntry,
  hashesOf,
  isRestoredCopyOf,
  parseFindSums,
  restartedServices,
  runEnded,
  sha256,
  shareCorpus,
  userSidOf,
  zipHashes,
} from "./fileshares.mjs";

test("the corpus is a few hundred files, deterministic, with the special files", () => {
  const first = shareCorpus();
  const second = shareCorpus();
  assert.ok(first.length >= 250 && first.length <= 400, `${first.length} files`);
  assert.deepEqual(
    first.map((file) => sha256(file.bytes)),
    second.map((file) => sha256(file.bytes)),
  );
  const paths = first.map((file) => file.path);
  for (const path of [NON_ASCII_FILE, ACL_FILE, DENIED_FILE, EXCLUDED_FILE]) {
    assert.ok(paths.includes(path), path);
  }
  assert.deepEqual([...paths].sort(), paths);
  assert.equal(new Set(paths).size, paths.length);
  assert.notEqual(sha256(fileBytes("a", 10)), sha256(fileBytes("b", 10)));
  assert.equal(
    shareCorpus("other").some((file, index) => sha256(file.bytes) === sha256(first[index].bytes)),
    false,
  );
});

test("a backup holds everything but the denied and the excluded file", () => {
  const corpus = shareCorpus();
  const backed = expectedInBackup(corpus).map((file) => file.path);
  assert.equal(backed.length, corpus.length - 2);
  assert.ok(!backed.includes(DENIED_FILE));
  assert.ok(!backed.includes(EXCLUDED_FILE));
});

test("hashes below a folder are relative to it", () => {
  const files = [
    { path: "Finance/a.txt", bytes: Buffer.from("a") },
    { path: "Finance/2025/b.txt", bytes: Buffer.from("b") },
    { path: "Reports/c.txt", bytes: Buffer.from("c") },
  ];
  assert.deepEqual([...hashesOf(files, "Finance").keys()], ["a.txt", "2025/b.txt"]);
  assert.equal(hashesOf(files).size, 3);
});

test("find | sha256sum output is read with UTF-8 names and the ./ dropped", () => {
  const hash = "a".repeat(64);
  const sums = parseFindSums(
    `${hash}  ./Reports/Größenübersicht März – Ä.txt\n${"b".repeat(64)}  ./x y.bin\nnoise\n`,
  );
  assert.equal(sums.get("Reports/Größenübersicht März – Ä.txt"), hash);
  assert.equal(sums.get("x y.bin"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("trees are compared by path and hash, and the difference is worded", () => {
  const expected = new Map([
    ["a", "1"],
    ["b", "2"],
    ["c", "3"],
  ]);
  const actual = new Map([
    ["a", "1"],
    ["b", "x"],
    ["d", "4"],
  ]);
  const difference = compareHashes(expected, actual);
  assert.deepEqual(difference, { missing: ["c"], extra: ["d"], differ: ["b"], same: false });
  assert.equal(describeDifference(difference), "1 missing (c); 1 unexpected (d); 1 different (b)");
  assert.equal(compareHashes(expected, new Map(expected)).same, true);
});

test("ZIP entries become hashes of files, folders left out", () => {
  const map = zipHashes([
    { name: "Finance/", data: Buffer.alloc(0) },
    { name: "Finance/a.txt", data: Buffer.from("a") },
  ]);
  assert.deepEqual([...map.keys()], ["Finance/a.txt"]);
  assert.equal(map.get("Finance/a.txt"), sha256(Buffer.from("a")));
});

test("the keep-both copy is recognised by restow-share's naming", () => {
  const original = "Reports/doc-001.bin";
  assert.ok(isRestoredCopyOf(original, "Reports/doc-001 (restored 2026-10-10 1204).bin"));
  assert.ok(isRestoredCopyOf(original, "Reports/doc-001 (restored 2026-10-10 1204 2).bin"));
  assert.ok(!isRestoredCopyOf(original, "Reports/doc-001.bin"));
  assert.ok(!isRestoredCopyOf(original, "Other/doc-001 (restored x).bin"));
  assert.ok(!isRestoredCopyOf(original, "Reports/doc-001 (restored ).bin"));
  assert.ok(isRestoredCopyOf("README", "README (restored x)"));
});

test("Samba's tools are read: the user SID and the ACL entries", () => {
  assert.equal(
    userSidOf("Unix username:        smoke\nUser SID:             S-1-5-21-1-2-3-1000\n"),
    "S-1-5-21-1-2-3-1000",
  );
  assert.equal(userSidOf("nothing"), null);
  const acl = [
    "REVISION:1",
    "CONTROL:SR|DP",
    "OWNER:S-1-5-21-1-2-3-1000",
    "ACL:S-1-5-21-1-2-3-1000:ALLOWED/0x0/0x001f01ff",
    `ACL:${ACL_SID}:ALLOWED/0x0/0x001200a9`,
    "ACL:S-1-5-21-1-2-3-1000:DENIED/0x0/0x00120089",
  ].join("\n");
  assert.equal(aclEntries(acl).length, 3);
  assert.ok(hasAclEntry(acl, ACL_SID));
  assert.ok(hasAclEntry(acl, "S-1-5-21-1-2-3-1000", "DENIED"));
  assert.ok(!hasAclEntry(acl, "S-1-5-32-544"));
});

test("a run has ended once it is done one way or the other", () => {
  for (const status of ["succeeded", "warning", "failed", "cancelled"]) {
    assert.ok(runEnded(status), status);
  }
  for (const status of ["queued", "starting", "running"]) {
    assert.ok(!runEnded(status), status);
  }
});

test("a changed start time is a restart", () => {
  assert.deepEqual(
    restartedServices(
      { api: "2026-10-10T10:00:00Z", worker: "2026-10-10T10:00:01Z" },
      { api: "2026-10-10T10:00:00Z", worker: "2026-10-10T11:00:00Z" },
    ),
    ["worker"],
  );
  assert.deepEqual(restartedServices({ api: "t" }, {}), []);
});
