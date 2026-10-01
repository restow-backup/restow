import { afterAll, describe, expect, it, vi } from "vitest";
import { ARCHIVE_BODY_TEXT_LIMIT, extractArchiveFields } from "./archive-fields.js";
import { shutdownIsolation } from "./isolate.js";
import { buildEml } from "./testing/builders.js";

// The first message that needs a parser process starts it, which takes longer on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

afterAll(async () => {
  await shutdownIsolation();
});

describe("extractArchiveFields", () => {
  it("reads the envelope, the subject and the text of an ordinary message", async () => {
    const fields = await extractArchiveFields(
      buildEml({
        from: "Alice <alice@example.test>",
        to: ["bob@example.test"],
        cc: "carol@example.test",
        subject: "Quarterly",
        messageId: "<q1@example.test>",
        body: "the numbers\r\n",
        attachments: [{ filename: "a.txt", content: "attachment" }],
      }),
    );
    expect(fields).toMatchObject({
      messageId: "<q1@example.test>",
      subject: "Quarterly",
      hasAttachment: true,
      envelope: { sender: "alice@example.test" },
    });
    expect(fields.envelope.recipients.map((r) => [r.address, r.type])).toEqual([
      ["bob@example.test", "to"],
      ["carol@example.test", "cc"],
    ]);
    expect(fields.bodyText).toContain("the numbers");
    expect(fields.unavailable).toBeUndefined();
  });

  it("takes the search text of an HTML-only message from the linear converter, with its entities", async () => {
    const fields = await extractArchiveFields(
      Buffer.from(
        "From: a@example.test\r\nSubject: html\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>M&uuml;ller</p><script>x()</script><p>second</p>",
      ),
    );
    expect(fields.bodyText).toBe("Müller\nsecond");
  });

  it("survives a 30 MB text of '<' without turning it into HTML, cutting the search text at its limit", async () => {
    const hostile = Buffer.from(
      `From: a@example.test\r\nSubject: report\r\nContent-Type: text/plain\r\n\r\n${"<".repeat(30 * 1024 * 1024)}`,
    );
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const fields = await extractArchiveFields(hostile);
    clearInterval(timer);
    expect(fields.unavailable).toBeUndefined();
    expect(fields.subject).toBe("report");
    expect(fields.bodyText.length).toBe(ARCHIVE_BODY_TEXT_LIMIT);
    expect(ticks).toBeGreaterThan(0);
  });

  it("gives empty fields, marked, to a message that runs over its time, and parses the next one", async () => {
    const bomb = Buffer.from(
      `From: a@example.test\r\nSubject: slow\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${"=\r\n=3D".repeat(700_000)}`,
    );
    const slow = await extractArchiveFields(bomb, { timeoutMs: 400 });
    expect(slow).toMatchObject({ unavailable: true, subject: null, bodyText: "" });
    expect(
      (
        await extractArchiveFields(
          buildEml({ from: "a@example.test", to: "b@example.test", subject: "next", body: "x" }),
        )
      ).subject,
    ).toBe("next");
  });
});
