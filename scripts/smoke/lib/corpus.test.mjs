import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCorpus, buildMessage, sha256, toCrlf } from "./corpus.mjs";
import { buildJournalReport } from "./journal-report.mjs";

test("the corpus is deterministic and distinct", () => {
  const a = buildCorpus({ seed: 1, mailbox: "alice@smoke.test", count: 20 });
  const b = buildCorpus({ seed: 1, mailbox: "alice@smoke.test", count: 20 });
  assert.deepEqual(
    a.map((message) => message.sha256),
    b.map((message) => message.sha256),
  );
  assert.equal(new Set(a.map((message) => message.sha256)).size, 20);
  assert.deepEqual([...new Set(a.map((message) => message.folder))].sort(), [
    "Archive 2026",
    "INBOX",
  ]);
  const other = buildCorpus({ seed: 2, mailbox: "alice@smoke.test", count: 20 });
  assert.notEqual(a[0].sha256, other[0].sha256);
});

test("messages use CRLF only and carry an attachment every third message", () => {
  const plain = buildMessage({ seed: 3, index: 1, mailbox: "a@smoke.test" }).toString("latin1");
  assert.ok(!/[^\r]\n/u.test(plain), "a bare LF found");
  const withAttachment = buildMessage({ seed: 3, index: 3, mailbox: "a@smoke.test" }).toString(
    "latin1",
  );
  assert.match(withAttachment, /filename="data-3\.bin"/u);
  assert.ok(!/filename=/u.test(plain));
});

test("toCrlf and sha256", () => {
  assert.equal(toCrlf(Buffer.from("a\nb\r\nc")).toString(), "a\r\nb\r\nc");
  assert.equal(
    sha256(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("the journal report wraps the original as message/rfc822", () => {
  const original = buildMessage({ seed: 4, index: 1, mailbox: "bob@smoke.test" });
  const report = buildJournalReport({
    journalAddress: "journal+token@archive.smoke.test",
    original,
    sender: "sender1@smoke.test",
    subject: "Quarterly numbers #1",
    messageId: "<smoke-4-1@smoke.test>",
    to: ["bob@smoke.test"],
    bcc: ["carol@smoke.test"],
  });
  const text = report.toString("utf8");
  assert.match(text, /Bcc: carol@smoke\.test/u);
  assert.ok(report.includes(original));
  assert.match(text, /Content-Type: message\/rfc822/u);
});
