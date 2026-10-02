import { mailfiles } from "@restow/core";
import { afterAll, describe, expect, it } from "vitest";
import {
  PREVIEW_MAX_QUEUED,
  PreviewBusyError,
  PreviewUnreadableError,
  findAttachmentInWorker,
  previewInWorker,
} from "./preview-isolated.js";

// The first message that needs a preview process starts it; that takes longer on a busy machine.
const TIMEOUT = 90_000;

const mail = (headers: string, body: string): Buffer =>
  Buffer.from(`From: Anna <anna@example.test>\r\nSubject: hello\r\n${headers}\r\n\r\n${body}`);

const HTML_MAIL = mail(
  "Content-Type: text/html; charset=utf-8",
  '<p onclick="x()">Hello <b>Board</b></p><script>alert(1)</script>',
);

/** Soft line breaks: mailparser decodes them in time that grows with the square of the body. */
const QP_BOMB = mail(
  "Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable",
  "=\r\n=3D".repeat(700_000),
);

/**
 * Nested blocks: the sanitiser needs about 16 s for them on a laptop (and only more on a loaded
 * machine), a plain text conversion milliseconds. The body is 1.5 MB, far below the size at which
 * the preview skips the sanitiser by itself (MAX_SANITIZED_HTML_CHARS): a `simplified` answer for it
 * can only come from the plain-text retry that follows a formatted view that ran over its time.
 */
const DIV_BOMB = mail("Content-Type: text/html", `<p>words here</p>${"<div>".repeat(300_000)}`);

/**
 * Budgets of the retry test. The formatted view gets a short one it cannot meet (8 times less than
 * it needs here; a slower machine needs more, so it fails the same way), the retry a long one it
 * cannot miss (a process start and 20 ms of work here; a loaded CI runner needed over 2.5 s for it
 * when it was bound to half of the first budget). Neither outcome depends on the speed of the machine.
 */
const FORMATTED_VIEW_BUDGET_MS = 2000;
const TEXT_RETRY_BUDGET_MS = 30_000;

/** A 30 MB text of "<": mailparser's text to HTML conversion would make a 125 MB string of it at once. */
const LT_REPORT = mail("Content-Type: text/plain", "<".repeat(30 * 1024 * 1024));

afterAll(async () => {
  await mailfiles.shutdownIsolation();
});

describe("previewInWorker", { timeout: TIMEOUT }, () => {
  it("previews an ordinary message the same way as in process: sanitised HTML, no simplification", async () => {
    const preview = await previewInWorker(HTML_MAIL);
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) {
      throw new Error("expected previewable");
    }
    expect(preview.headers.subject).toBe("hello");
    expect(preview.body.kind).toBe("html");
    expect(preview.body.content).toContain("Hello <b>Board</b>");
    expect(preview.body.content).not.toMatch(/<script|onclick/i);
    expect(preview.simplified).toBeUndefined();
  });

  it("shows the text of a message whose formatted view runs over its limit, marked as simplified", async () => {
    await previewInWorker(HTML_MAIL);
    const preview = await previewInWorker(DIV_BOMB, {
      timeoutMs: FORMATTED_VIEW_BUDGET_MS,
      textTimeoutMs: TEXT_RETRY_BUDGET_MS,
    });
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) {
      throw new Error("expected previewable");
    }
    expect(preview).toMatchObject({ simplified: true, body: { kind: "text" } });
    expect(preview.body.content).toContain("words here");
    expect(preview.body.content).not.toContain("<");
  });

  it("gives up on a message that stays slow in the text mode as well, and the event loop never waits for it", async () => {
    await previewInWorker(HTML_MAIL);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const started = Date.now();
    const failure = await previewInWorker(QP_BOMB, { timeoutMs: 600 }).catch((e: unknown) => e);
    clearInterval(timer);
    expect(failure).toBeInstanceOf(PreviewUnreadableError);
    expect((failure as PreviewUnreadableError).kind).toBe("timeout");
    // The text attempt got half of the time of the formatted view, as it does by default.
    expect((failure as PreviewUnreadableError).message).toContain("within 300 ms");
    expect(Date.now() - started).toBeLessThan(30_000);
    // About a second passed (a full and a text attempt): the loop ticked all along.
    expect(ticks).toBeGreaterThan(30);
    // The next message is previewed as usual.
    expect((await previewInWorker(HTML_MAIL)).previewable).toBe(true);
  });

  it("gives the text attempt the time it is asked for instead of half of the time of the formatted view", async () => {
    await previewInWorker(HTML_MAIL);
    const failure = await previewInWorker(QP_BOMB, { timeoutMs: 300, textTimeoutMs: 1500 }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PreviewUnreadableError);
    expect((failure as PreviewUnreadableError).kind).toBe("timeout");
    expect((failure as PreviewUnreadableError).message).toContain("within 1500 ms");
  });

  it("previews a 30 MB report of '<' as text without a stall: no text to HTML conversion is asked for", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const preview = await previewInWorker(LT_REPORT);
    clearInterval(timer);
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) {
      throw new Error("expected previewable");
    }
    expect(preview.body.kind).toBe("text");
    expect(preview.body.content.length).toBeGreaterThan(1_000_000);
    expect(ticks).toBeGreaterThan(0);
    // The process that did it is still fine for the next message.
    expect((await previewInWorker(HTML_MAIL)).previewable).toBe(true);
  });

  it("refuses a request beyond the queue it is allowed, and serves the ones it let in", async () => {
    await previewInWorker(HTML_MAIL);
    mailfiles.configureIsolation({ workers: 1, maxQueued: 0 });
    try {
      const slow = previewInWorker(DIV_BOMB, { timeoutMs: 2000 }).catch(() => undefined);
      const refused = await previewInWorker(HTML_MAIL).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(PreviewBusyError);
      await slow;
    } finally {
      mailfiles.configureIsolation({ workers: 2, maxQueued: PREVIEW_MAX_QUEUED });
    }
  });
});

describe("findAttachmentInWorker", { timeout: TIMEOUT }, () => {
  const withAttachment = Buffer.from(
    [
      "From: Anna <anna@example.test>",
      "Subject: with file",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "see attached",
      "--b",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="board.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("%PDF-1.4\n").toString("base64"),
      "--b--",
      "",
    ].join("\r\n"),
  );

  it("returns the attachment with its content as a Buffer, and null for an id that is not there", async () => {
    const found = await findAttachmentInWorker(withAttachment, "att-0");
    expect(found).toMatchObject({ filename: "board.pdf", contentType: "application/pdf", size: 9 });
    expect(Buffer.isBuffer(found?.content)).toBe(true);
    expect(found?.content.toString("utf8")).toBe("%PDF-1.4\n");
    expect(await findAttachmentInWorker(withAttachment, "att-9")).toBeNull();
    expect(await findAttachmentInWorker(withAttachment, "not-an-id")).toBeNull();
  });

  it("says that a message that runs over its limit cannot be read", async () => {
    await findAttachmentInWorker(withAttachment, "att-0");
    const failure = await findAttachmentInWorker(QP_BOMB, "att-0", { timeoutMs: 600 }).catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(PreviewUnreadableError);
  });
});
