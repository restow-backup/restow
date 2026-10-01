import { describe, expect, it, vi } from "vitest";

/**
 * Records every call to the real `sanitize-html` package while still running
 * it, so a test can prove the preview never reaches the sanitiser for
 * protected mail (rather than merely asserting on its output).
 */
const sanitizeHtmlCalls = vi.fn();
vi.mock("sanitize-html", async (importOriginal) => {
  // sanitize-html's own types declare `export =` (CommonJS), so its actual
  // shape at this ESM interop boundary is `{ default: <the function> }`, not
  // `typeof import("sanitize-html")` itself (which types the un-interopped
  // export and has no `.default`).
  const actual = await importOriginal<{ default: typeof import("sanitize-html") }>();
  const spied = Object.assign(
    (html: string, options?: unknown) => {
      sanitizeHtmlCalls(html, options);
      return (actual.default as (input: string, opts?: unknown) => string)(html, options as never);
    },
    // sanitize-html.simpleTransform is a static property of the default export.
    actual.default,
  );
  return { ...actual, default: spied };
});

import {
  MAX_SANITIZED_HTML_CHARS,
  PREVIEW_SIZE_CAP_BYTES,
  attachmentIndexOf,
  buildPreviewFromMime,
  detectProtection,
  downloadContentType,
  findAttachment,
  headersFromMetadata,
  parseTopLevelContentType,
  sanitizeMailHtml,
  unavailablePreview,
} from "./preview.js";

const CRLF = "\r\n";
const eml = (lines: readonly string[]): Buffer => Buffer.from(lines.join(CRLF), "utf8");

const PLAIN_TEXT_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Hello",
  "Date: Mon, 10 Jan 2026 08:00:00 +0000",
  "Message-ID: <msg1@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello Bob, this is a plain text body.",
  "",
]);

// A 1x1 transparent PNG, base64.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const HTML_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>, Carla <carla@example.com>",
  "Cc: Dave <dave@example.com>",
  "Subject: Report",
  "Date: Tue, 11 Jan 2026 09:00:00 +0000",
  "Message-ID: <msg2@example.com>",
  'Content-Type: multipart/related; boundary="BOUNDARY1"',
  "",
  "--BOUNDARY1",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<html><body style="background:url(http://evil.example.com/bg.png)">',
  "<script>alert(1)</script>",
  '<p onclick="alert(2)">Click me</p>',
  '<form><input type="text"><button>Go</button></form>',
  '<iframe src="http://evil.example.com"></iframe>',
  '<object data="http://evil.example.com/x.swf"></object>',
  '<img src="cid:logo123" alt="logo">',
  '<img src="http://tracker.example.com/pixel.gif" alt="tracker" srcset="http://tracker.example.com/2x.gif 2x">',
  '<a href="http://example.com/page">a link</a>',
  "</body></html>",
  "",
  "--BOUNDARY1",
  "Content-Type: image/png",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo123>",
  "",
  PNG_BASE64,
  "",
  "--BOUNDARY1",
  "Content-Type: application/pdf",
  'Content-Disposition: attachment; filename="report.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  "JVBERi0xLjQK",
  "",
  "--BOUNDARY1--",
  "",
]);

const RPMSG_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Protected",
  "Date: Wed, 12 Jan 2026 10:00:00 +0000",
  "Message-ID: <msg3@example.com>",
  'Content-Type: multipart/mixed; boundary="BOUNDARY2"',
  "",
  "--BOUNDARY2",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "This message is protected. Open message.rpmsg to read it.",
  "",
  "--BOUNDARY2",
  "Content-Type: application/x-microsoft-rpmsg-message",
  'Content-Disposition: attachment; filename="message.rpmsg"',
  "Content-Transfer-Encoding: base64",
  "",
  "UkNQTVNHUkNQTVNH",
  "",
  "--BOUNDARY2--",
  "",
]);

const SMIME_ENVELOPED_MAIL = eml([
  "MIME-Version: 1.0",
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Encrypted",
  "Date: Thu, 13 Jan 2026 11:00:00 +0000",
  "Message-ID: <msg4@example.com>",
  "Content-Type: application/pkcs7-mime;",
  "    smime-type=enveloped-data;",
  '    name="smime.p7m"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="smime.p7m"',
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
]);

const SMIME_SIGNED_ONLY_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Signed",
  "Date: Fri, 14 Jan 2026 12:00:00 +0000",
  "Message-ID: <msg5@example.com>",
  'Content-Type: multipart/signed; protocol="application/pkcs7-signature"; micalg=sha-256; boundary="BOUNDARY3"',
  "",
  "--BOUNDARY3",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Signed but readable body.",
  "",
  "--BOUNDARY3",
  "Content-Type: application/pkcs7-signature; name=smime.p7s",
  'Content-Disposition: attachment; filename="smime.p7s"',
  "Content-Transfer-Encoding: base64",
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
  "--BOUNDARY3--",
  "",
]);

/** The legacy `x-pkcs7-mime` spelling RFC 8551 still asks receivers to accept. */
const SMIME_LEGACY_ENVELOPED_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Legacy encrypted",
  "Date: Sat, 15 Jan 2026 13:00:00 +0000",
  "Message-ID: <msg6@example.com>",
  "Content-Type: application/x-pkcs7-mime;",
  "    smime-type=enveloped-data;",
  '    name="smime.p7m"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="smime.p7m"',
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
]);

/** A message mislabelled with a generic type, recognised only by its conventional file name. */
const SMIME_MISLABELLED_ENVELOPED_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Mislabelled encrypted",
  "Date: Sun, 16 Jan 2026 14:00:00 +0000",
  "Message-ID: <msg7@example.com>",
  'Content-Type: application/octet-stream; name="smime.p7m"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="smime.p7m"',
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
]);

/**
 * An S/MIME-enveloped part wrapped inside an outer `multipart/mixed` next to
 * a plain-text disclaimer, as some gateways do — not the top-level part
 * itself, unlike {@link SMIME_ENVELOPED_MAIL}.
 */
const SMIME_ENVELOPED_NESTED_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Encrypted with disclaimer",
  "Date: Mon, 18 Jan 2026 16:00:00 +0000",
  "Message-ID: <msg9@example.com>",
  'Content-Type: multipart/mixed; boundary="BOUNDARY5"',
  "",
  "--BOUNDARY5",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "This message contains confidential information. Disclaimer added by gateway.",
  "",
  "--BOUNDARY5",
  "Content-Type: application/pkcs7-mime;",
  "    smime-type=enveloped-data;",
  '    name="smime.p7m"',
  "Content-Transfer-Encoding: base64",
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
  "--BOUNDARY5--",
  "",
]);

/** A pkcs7-mime part whose smime-type is a real but non-enveloped kind: not encrypted. */
const SMIME_COMPRESSED_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Compressed, not encrypted",
  "Date: Tue, 19 Jan 2026 17:00:00 +0000",
  "Message-ID: <msg11@example.com>",
  "Content-Type: application/pkcs7-mime; smime-type=compressed-data; name=smime.p7z",
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="smime.p7z"',
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
]);

/** A pkcs7-mime part with no smime-type parameter and no conventional smime.p7m name: unflagged. */
const SMIME_NO_TYPE_UNNAMED_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: pkcs7-mime with no smime-type",
  "Date: Wed, 20 Jan 2026 18:00:00 +0000",
  "Message-ID: <msg12@example.com>",
  'Content-Type: application/pkcs7-mime; name="other.dat"',
  "Content-Transfer-Encoding: base64",
  "",
  "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
  "",
]);

/** An HTML body next to a rights-protected attachment, for the sanitiser-never-called check below. */
const HTML_WITH_RPMSG_ATTACHMENT_MAIL = eml([
  "From: Anna <anna@example.com>",
  "To: Bob <bob@example.com>",
  "Subject: Protected with an HTML part",
  "Date: Mon, 17 Jan 2026 15:00:00 +0000",
  "Message-ID: <msg8@example.com>",
  'Content-Type: multipart/mixed; boundary="BOUNDARY4"',
  "",
  "--BOUNDARY4",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><script>alert(1)</script><p>Open message.rpmsg to read it.</p></body></html>",
  "",
  "--BOUNDARY4",
  "Content-Type: application/x-microsoft-rpmsg-message",
  'Content-Disposition: attachment; filename="message.rpmsg"',
  "Content-Transfer-Encoding: base64",
  "",
  "UkNQTVNHUkNQTVNH",
  "",
  "--BOUNDARY4--",
  "",
]);

describe("parseTopLevelContentType", () => {
  it("reads the outermost part's type and parameters, folded or not", () => {
    expect(parseTopLevelContentType(SMIME_ENVELOPED_MAIL)).toEqual({
      type: "application/pkcs7-mime",
      params: { "smime-type": "enveloped-data", name: "smime.p7m" },
    });
    expect(parseTopLevelContentType(PLAIN_TEXT_MAIL)).toEqual({
      type: "text/plain",
      params: { charset: "utf-8" },
    });
  });

  it("returns null without a Content-Type header", () => {
    expect(parseTopLevelContentType(Buffer.from("Subject: none\r\n\r\nbody", "utf8"))).toBeNull();
  });
});

describe("detectProtection", () => {
  it("flags an S/MIME-enveloped message but not a signed-only one", async () => {
    const { simpleParser } = await import("mailparser");
    const enveloped = await simpleParser(SMIME_ENVELOPED_MAIL);
    expect(detectProtection(SMIME_ENVELOPED_MAIL, enveloped)).toBe("smime-encrypted");

    const signedOpaque = eml([
      "Content-Type: application/pkcs7-mime; smime-type=signed-data; name=smime.p7m",
      "Content-Transfer-Encoding: base64",
      "",
      "MIIBAAAAAAAAAAAAAAAAAAAAAAA=",
      "",
    ]);
    expect(parseTopLevelContentType(signedOpaque)?.params["smime-type"]).toBe("signed-data");
    const parsedOpaqueSigned = await simpleParser(signedOpaque);
    expect(detectProtection(signedOpaque, parsedOpaqueSigned)).toBeNull();

    const signed = await simpleParser(SMIME_SIGNED_ONLY_MAIL);
    expect(detectProtection(SMIME_SIGNED_ONLY_MAIL, signed)).toBeNull();
  });

  it("flags a rights-protected (rpmsg) message from its attachment", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(RPMSG_MAIL);
    expect(detectProtection(RPMSG_MAIL, parsed)).toBe("rights-protected");
  });

  it("does not flag ordinary mail", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(PLAIN_TEXT_MAIL);
    expect(detectProtection(PLAIN_TEXT_MAIL, parsed)).toBeNull();
  });

  it("flags the legacy application/x-pkcs7-mime spelling (RFC 8551) as encrypted", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(SMIME_LEGACY_ENVELOPED_MAIL);
    expect(detectProtection(SMIME_LEGACY_ENVELOPED_MAIL, parsed)).toBe("smime-encrypted");
  });

  it("flags a message mislabelled with a generic type by its smime.p7m name", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(SMIME_MISLABELLED_ENVELOPED_MAIL);
    expect(detectProtection(SMIME_MISLABELLED_ENVELOPED_MAIL, parsed)).toBe("smime-encrypted");
  });

  it("flags an S/MIME-enveloped part nested inside multipart/mixed, not only a top-level one", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(SMIME_ENVELOPED_NESTED_MAIL);
    expect(detectProtection(SMIME_ENVELOPED_NESTED_MAIL, parsed)).toBe("smime-encrypted");
  });

  it("does not flag a pkcs7-mime part whose smime-type is a non-enveloped kind (e.g. compressed-data)", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(SMIME_COMPRESSED_MAIL);
    expect(detectProtection(SMIME_COMPRESSED_MAIL, parsed)).toBeNull();
  });

  it("does not flag a pkcs7-mime part with no smime-type and no conventional smime.p7m name", async () => {
    const { simpleParser } = await import("mailparser");
    const parsed = await simpleParser(SMIME_NO_TYPE_UNNAMED_MAIL);
    expect(detectProtection(SMIME_NO_TYPE_UNNAMED_MAIL, parsed)).toBeNull();
  });
});

describe("sanitizeMailHtml", () => {
  it("strips script tags, event handlers, forms, iframes and objects", () => {
    const output = sanitizeMailHtml(
      '<script>alert(1)</script><p onclick="alert(2)">hi</p><form><input><button>go</button></form>' +
        '<iframe src="http://evil.example.com"></iframe><object data="http://evil.example.com/x"></object>',
    );
    expect(output).not.toMatch(/<script/i);
    expect(output).not.toContain("alert(1)");
    expect(output).not.toMatch(/onclick/i);
    expect(output).not.toMatch(/<form|<input|<button|<iframe|<object/i);
  });

  it("removes remote image src and any srcset, but keeps a data: URI", () => {
    const output = sanitizeMailHtml(
      '<img src="http://tracker.example.com/pixel.gif" srcset="http://tracker.example.com/2x.gif 2x">' +
        '<img src="data:image/png;base64,AAAA">',
    );
    expect(output).not.toContain("tracker.example.com");
    expect(output).not.toMatch(/srcset/i);
    expect(output).toContain('src="data:image/png;base64,AAAA"');
  });

  it("drops <style> blocks entirely and neuters url() left in inline style attributes", () => {
    const output = sanitizeMailHtml(
      "<style>body { background: url(http://evil.example.com/bg.png); }</style>" +
        "<div style=\"background:url('http://evil.example.com/x.png')\">x</div>",
    );
    expect(output).not.toContain("evil.example.com");
    expect(output).not.toMatch(/<style/i);
    expect(output).toContain("url()");
  });

  it("opens links in a new tab without leaking a referrer", () => {
    const output = sanitizeMailHtml('<a href="http://example.com/page">a link</a>');
    expect(output).toContain('target="_blank"');
    expect(output).toContain('rel="noopener noreferrer"');
    expect(output).toContain('href="http://example.com/page"');
  });

  it("drops an <img> whose src is protocol-relative, backslash-escaped or a relative path", () => {
    const protocolRelative = sanitizeMailHtml('<img src="//evil.example.com/j.png">');
    expect(protocolRelative).not.toContain("evil.example.com");
    expect(protocolRelative).not.toContain("<img");

    // Browsers normalise a backslash the same way as a forward slash here.
    const backslash = sanitizeMailHtml('<img src="\\\\evil.example.com/p.png">');
    expect(backslash).not.toContain("evil.example.com");
    expect(backslash).not.toContain("<img");

    // A same-origin relative path would resolve against whichever page hosts the preview.
    const relative = sanitizeMailHtml('<img src="/api/v1/restore/abc/download">');
    expect(relative).not.toContain("/api/v1/restore");
    expect(relative).not.toContain("<img");

    // The one form that is kept: an embedded image inlined by mailparser.
    const inline = sanitizeMailHtml('<img src="data:image/png;base64,AAAA">');
    expect(inline).toContain('src="data:image/png;base64,AAAA"');
  });

  it("neuters a CSS-escaped url() that would otherwise slip past a plain string search", () => {
    // `\75 rl(` and `u\rl(` both decode to `url(` in every browser's CSS parser.
    const hexEscaped = sanitizeMailHtml(
      '<div style="background:\\75 rl(http://evil.example.com/x.png)">x</div>',
    );
    expect(hexEscaped).not.toContain("evil.example.com");
    expect(hexEscaped).toContain("url()");

    const literalEscaped = sanitizeMailHtml(
      '<div style="background:u\\rl(http://evil.example.com/y.png)">y</div>',
    );
    expect(literalEscaped).not.toContain("evil.example.com");
    expect(literalEscaped).toContain("url()");
  });

  it("neuters a quoted url() argument that itself contains parentheses", () => {
    // Unquoted `url(...)` cannot contain a bare paren, but the quoted form
    // can: only the matching quote, not paren balancing, ends the argument.
    const output = sanitizeMailHtml(
      "<div style=\"background:url('https://evil.example/x(1).png')\">x</div>",
    );
    expect(output).not.toContain("evil.example");
    expect(output).toContain("url()");
  });

  it("neuters a doubly CSS-escaped url() a single decode pass would miss", () => {
    // `\5c 75rl(` decodes once to the literal text `\75rl(` (a backslash from
    // the `\5c` escape followed by the untouched digits `75rl(`), which is
    // itself a valid escape (`\75` = `u`) a browser decodes again into
    // `url(`. A sanitiser that decodes only once and then ships that text
    // unchanged (because it does not yet literally contain "url(") lets this
    // through.
    const doublyHexEscaped = sanitizeMailHtml(
      '<div style="background:\\5c 75rl(http://evil.example.com/x.png)">x</div>',
    );
    expect(doublyHexEscaped).not.toContain("evil.example.com");
    expect(doublyHexEscaped).toContain("url()");

    // Two literal backslashes before "rl(": the first pass consumes the
    // doubled backslash into one literal backslash, again forming `\rl(` —
    // itself a one-more-pass-away `url(`.
    const doublyLiteralEscaped = sanitizeMailHtml(
      '<div style="background:u\\\\rl(http://evil.example.com/y.png)">y</div>',
    );
    expect(doublyLiteralEscaped).not.toContain("evil.example.com");
    expect(doublyLiteralEscaped).toContain("url()");
  });

  it("does not throw on a CSS escape whose decoded code point is invalid", () => {
    // CSS Syntax Level 3 §4.3.7: a zero code point, a surrogate half
    // (U+D800-U+DFFF) or anything past the last Unicode code point
    // (U+10FFFF) is not a valid argument to `String.fromCodePoint` and must
    // decode to U+FFFD instead of throwing. The message is
    // attacker-controlled, so any sender could otherwise make their own mail
    // unpreviewable for everyone (a RangeError escaping all the way out to a
    // generic 500 instead of a rendered, if odd-looking, preview).
    expect(() => sanitizeMailHtml('<div style="color:\\FFFFFF">x</div>')).not.toThrow();
    expect(() => sanitizeMailHtml('<div style="color:\\110000">x</div>')).not.toThrow();
    expect(() => sanitizeMailHtml('<div style="color:\\D800">x</div>')).not.toThrow();
    expect(() => sanitizeMailHtml('<div style="color:\\0">x</div>')).not.toThrow();
    expect(sanitizeMailHtml('<p style="color:\\FFFFFF">ok</p>')).toContain("<p");
  });

  it("neuters image-set() and -webkit-image-set(), including one nested url()", () => {
    const imageSet = sanitizeMailHtml(
      "<div style=\"background:image-set('http://evil.example.com/x.png' 1x)\">z</div>",
    );
    expect(imageSet).not.toContain("evil.example.com");
    expect(imageSet).toContain("image-set()");

    const webkitImageSet = sanitizeMailHtml(
      "<div style=\"background:-webkit-image-set(url('http://evil.example.com/x.png') 1x)\">w</div>",
    );
    expect(webkitImageSet).not.toContain("evil.example.com");
    expect(webkitImageSet).toContain("image-set()");
  });

  /**
   * One nested layer of backslash escaping in front of a CSS function name's
   * first letter costs the sender only four more characters (`\5c `) but
   * costs the decoder one more full {@link decodeCssEscapes} pass: decoding
   * `\5c ` once yields a literal backslash that, concatenated with the
   * untouched text after it, forms a brand new escape for the next pass to
   * find. `levels === 1` is a single ordinary hex escape of the function
   * name's first letter (`\75` = `u`, `\69` = `i`); each `levels + 1` adds
   * one more `\5c ` layer in front of it. Mirrors the two-level
   * `\5c 75rl(` example already covered above, generalised to an arbitrary
   * depth so a round-trip through the sanitiser's actual 10-pass budget can
   * be tested at both sides of that boundary.
   */
  function nestedCssEscape(levels: number, hex: string, rest: string): string {
    return `\\${"5c ".repeat(levels - 1)}${hex}${rest}`;
  }

  it("still decodes and neuters a url() whose escaping reaches its fixpoint within the 10-pass budget", () => {
    // 9 nested layers: the sanitiser's loop confirms the fixpoint on its
    // 10th (last available) pass, exactly as it did before this fix.
    const escapedUrl = nestedCssEscape(9, "75", "rl(http://evil.example.com/x.png)");
    const output = sanitizeMailHtml(`<div style="background:${escapedUrl}">x</div>`);
    expect(output).not.toContain("evil.example.com");
    expect(output).toContain("url()");
    expect(output).toMatch(/style=/);

    const escapedImageSet = nestedCssEscape(9, "69", "mage-set(http://evil.example.com/y.png)");
    const imageSetOutput = sanitizeMailHtml(`<div style="background:${escapedImageSet}">y</div>`);
    expect(imageSetOutput).not.toContain("evil.example.com");
    expect(imageSetOutput).toContain("image-set()");
    expect(imageSetOutput).toMatch(/style=/);
  });

  it("drops a style declaration whose url()/image-set() is escaped through 11 or more levels instead of shipping it half-decoded", () => {
    // 11 nested layers: the loop's 10-pass budget runs out before a
    // fixpoint is confirmed. Shipping the partially-decoded text here (the
    // pre-fix behaviour) would leave a still-escaped token in the sanitised
    // HTML that the browser's own CSS tokeniser finishes decoding into a
    // live url() call — the exact bug this fix closes.
    const escapedUrl = nestedCssEscape(11, "75", "rl(http://evil.example.com/x.png)");
    const output = sanitizeMailHtml(`<div style="background:${escapedUrl}">x</div>`);
    expect(output).not.toContain("evil.example.com");
    // The whole declaration is dropped, not merely neutered: no leftover
    // backslash escape and no `style=` attribute at all.
    expect(output).not.toMatch(/style=/);
    expect(output).not.toContain("\\");

    const escapedImageSet = nestedCssEscape(11, "69", "mage-set(http://evil.example.com/y.png)");
    const imageSetOutput = sanitizeMailHtml(`<div style="background:${escapedImageSet}">y</div>`);
    expect(imageSetOutput).not.toContain("evil.example.com");
    expect(imageSetOutput).not.toMatch(/style=/);
    expect(imageSetOutput).not.toContain("\\");

    // Well past the boundary too, not just one level over it.
    const deeplyEscaped = nestedCssEscape(20, "75", "rl(http://evil.example.com/z.png)");
    const deepOutput = sanitizeMailHtml(`<div style="background:${deeplyEscaped}">z</div>`);
    expect(deepOutput).not.toContain("evil.example.com");
    expect(deepOutput).not.toMatch(/style=/);
  });

  it("drops a style value carrying @import or an old expression() instead of neutering it", () => {
    const withImport = sanitizeMailHtml(
      '<div style="@import url(http://evil.example.com/x.css)">x</div>',
    );
    expect(withImport).not.toContain("evil.example.com");
    expect(withImport).not.toMatch(/style=/);

    const withExpression = sanitizeMailHtml('<div style="width:expression(alert(1))">x</div>');
    expect(withExpression).not.toContain("expression");
    expect(withExpression).not.toMatch(/style=/);
  });

  it("only touches url() inside a style attribute, leaving message text and link targets intact", () => {
    const bodyText = sanitizeMailHtml("<p>See background: url(images/bg.png) for the mockup.</p>");
    expect(bodyText).toContain("background: url(images/bg.png)");

    const linkWithUrlLikeQuery = sanitizeMailHtml(
      '<a href="https://example.com/a?x=url(1)">a link</a>',
    );
    expect(linkWithUrlLikeQuery).toContain('href="https://example.com/a?x=url(1)"');
  });
});

describe("buildPreviewFromMime in text mode (the fallback of the preview process)", () => {
  it("turns an HTML-only body into text with the linear converter and never reaches the sanitiser", async () => {
    sanitizeHtmlCalls.mockClear();
    const preview = await buildPreviewFromMime(
      eml([
        "From: Anna <anna@example.com>",
        "Subject: Offer",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<style>p{color:red}</style><p>M&uuml;ller &amp; S&#246;hne</p><p>second<br>line</p>",
      ]),
      { mode: "text" },
    );
    expect(preview).toMatchObject({
      previewable: true,
      simplified: true,
      headers: { subject: "Offer" },
      body: { kind: "text", content: "Müller & Söhne\nsecond\nline" },
    });
    expect(sanitizeHtmlCalls).not.toHaveBeenCalled();
  });

  it("prefers the text part of an alternative message and still lists the attachments", async () => {
    const preview = await buildPreviewFromMime(HTML_MAIL, { mode: "text" });
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) {
      throw new Error("expected previewable");
    }
    expect(preview.body.kind).toBe("text");
    expect(preview.body.content).not.toMatch(/<\w/);
    expect(preview.simplified).toBe(true);
  });

  it("is not simplified in the normal mode", async () => {
    const preview = await buildPreviewFromMime(PLAIN_TEXT_MAIL);
    expect(preview.previewable && preview.simplified).toBeFalsy();
  });

  it("shows the text instead of sanitising an HTML body longer than the limit", async () => {
    sanitizeHtmlCalls.mockClear();
    const preview = await buildPreviewFromMime(
      eml([
        "From: Anna <anna@example.com>",
        "Subject: Long",
        "Content-Type: text/html",
        "",
        `<p>start</p>${"<i>x</i>".repeat(Math.ceil(MAX_SANITIZED_HTML_CHARS / 8))}`,
      ]),
    );
    expect(preview).toMatchObject({ previewable: true, simplified: true, body: { kind: "text" } });
    expect(sanitizeHtmlCalls).not.toHaveBeenCalled();
  });

  it("still recognises protected mail", async () => {
    const preview = await buildPreviewFromMime(
      eml([
        "From: Anna <anna@example.com>",
        "Subject: Secret",
        "MIME-Version: 1.0",
        'Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"',
        "Content-Transfer-Encoding: base64",
        "",
        "AAAA",
      ]),
      { mode: "text" },
    );
    expect(preview).toMatchObject({ previewable: false, reason: "smime-encrypted" });
  });
});

describe("buildPreviewFromMime", () => {
  it("returns a plain-text body for a text/plain message", async () => {
    const preview = await buildPreviewFromMime(PLAIN_TEXT_MAIL);
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) throw new Error("expected previewable");
    expect(preview.body.kind).toBe("text");
    expect(preview.body.content.trim()).toBe("Hello Bob, this is a plain text body.");
    expect(preview.headers).toMatchObject({
      subject: "Hello",
      from: "Anna <anna@example.com>",
      to: ["Bob <bob@example.com>"],
      cc: [],
      messageId: "<msg1@example.com>",
    });
    expect(preview.attachments).toEqual([]);
  });

  it("sanitises the HTML body, inlines the cid: image and lists attachments", async () => {
    const preview = await buildPreviewFromMime(HTML_MAIL);
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) throw new Error("expected previewable");
    expect(preview.body.kind).toBe("html");
    expect(preview.body.content).toContain("data:image/png;base64,");
    expect(preview.body.content).not.toContain("cid:logo123");
    expect(preview.body.content).not.toContain("tracker.example.com");
    expect(preview.body.content).not.toMatch(/<script|<iframe|<object|<form/i);
    expect(preview.headers.to).toEqual(["Bob <bob@example.com>", "Carla <carla@example.com>"]);
    expect(preview.headers.cc).toEqual(["Dave <dave@example.com>"]);
    // The inline logo and the PDF attachment; the tracking pixel was never a MIME part.
    expect(preview.attachments).toHaveLength(2);
    expect(preview.attachments.find((a) => a.filename === "report.pdf")).toMatchObject({
      contentType: "application/pdf",
      inline: false,
    });
    expect(preview.attachments.some((a) => a.inline)).toBe(true);
  });

  it("marks a rights-protected message unpreviewable without sanitising anything", async () => {
    const preview = await buildPreviewFromMime(RPMSG_MAIL);
    expect(preview).toMatchObject({
      previewable: false,
      reason: "rights-protected",
      attachments: [],
    });
    expect(preview.headers.subject).toBe("Protected");
  });

  it("marks an S/MIME-enveloped message unpreviewable", async () => {
    const preview = await buildPreviewFromMime(SMIME_ENVELOPED_MAIL);
    expect(preview).toMatchObject({
      previewable: false,
      reason: "smime-encrypted",
      attachments: [],
    });
  });

  it("previews a signed-only S/MIME message normally", async () => {
    const preview = await buildPreviewFromMime(SMIME_SIGNED_ONLY_MAIL);
    expect(preview.previewable).toBe(true);
    if (!preview.previewable) throw new Error("expected previewable");
    expect(preview.body.kind).toBe("text");
    expect(preview.body.content.trim()).toBe("Signed but readable body.");
  });

  it("marks an S/MIME-enveloped part nested inside multipart/mixed unpreviewable, not only a top-level one", async () => {
    const preview = await buildPreviewFromMime(SMIME_ENVELOPED_NESTED_MAIL);
    expect(preview).toMatchObject({
      previewable: false,
      reason: "smime-encrypted",
      attachments: [],
    });
  });

  it("previews HTML mail whose inline style carries an out-of-range CSS escape instead of throwing", async () => {
    const mail = eml([
      "From: Anna <anna@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Bad escape",
      "Date: Thu, 22 Jan 2026 09:00:00 +0000",
      "Message-ID: <msg13@example.com>",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<div style="color:\\FFFFFF">x</div>',
      "",
    ]);
    const preview = await buildPreviewFromMime(mail);
    expect(preview.previewable).toBe(true);
  });

  it("marks the legacy x-pkcs7-mime spelling and a mislabelled p7m unpreviewable", async () => {
    const legacy = await buildPreviewFromMime(SMIME_LEGACY_ENVELOPED_MAIL);
    expect(legacy).toMatchObject({
      previewable: false,
      reason: "smime-encrypted",
      attachments: [],
    });

    const mislabelled = await buildPreviewFromMime(SMIME_MISLABELLED_ENVELOPED_MAIL);
    expect(mislabelled).toMatchObject({
      previewable: false,
      reason: "smime-encrypted",
      attachments: [],
    });
  });

  it("never calls the HTML sanitiser for protected mail, even one that carries an HTML part", async () => {
    sanitizeHtmlCalls.mockClear();

    const rpmsg = await buildPreviewFromMime(RPMSG_MAIL);
    expect(rpmsg.previewable).toBe(false);
    expect(sanitizeHtmlCalls).not.toHaveBeenCalled();

    const smime = await buildPreviewFromMime(SMIME_ENVELOPED_MAIL);
    expect(smime.previewable).toBe(false);
    expect(sanitizeHtmlCalls).not.toHaveBeenCalled();

    // An HTML body next to the rpmsg attachment: still never reaches the sanitiser.
    const withHtmlPart = await buildPreviewFromMime(HTML_WITH_RPMSG_ATTACHMENT_MAIL);
    expect(withHtmlPart).toMatchObject({
      previewable: false,
      reason: "rights-protected",
      attachments: [],
    });
    expect(sanitizeHtmlCalls).not.toHaveBeenCalled();

    // Control: an ordinary HTML message does reach it.
    await buildPreviewFromMime(HTML_MAIL);
    expect(sanitizeHtmlCalls).toHaveBeenCalledTimes(1);
  });
});

describe("findAttachment / attachmentIndexOf", () => {
  it("parses the att-<n> id format and rejects anything else", () => {
    expect(attachmentIndexOf("att-0")).toBe(0);
    expect(attachmentIndexOf("att-12")).toBe(12);
    expect(attachmentIndexOf("attachment-0")).toBeNull();
    expect(attachmentIndexOf("att--1")).toBeNull();
  });

  it("locates an attachment of an ordinary message by index", async () => {
    const preview = await buildPreviewFromMime(HTML_MAIL);
    if (!preview.previewable) throw new Error("expected previewable");
    const pdfId = preview.attachments.find((a) => a.filename === "report.pdf")?.id;
    expect(pdfId).toBeDefined();
    const attachment = await findAttachment(HTML_MAIL, pdfId as string);
    expect(attachment?.filename).toBe("report.pdf");
    expect(attachment?.content).toBeInstanceOf(Buffer);
  });

  it("finds nothing on a protected message, even for a plausible id", async () => {
    expect(await findAttachment(RPMSG_MAIL, "att-0")).toBeNull();
  });

  it("returns null for an id past the end or a malformed one", async () => {
    expect(await findAttachment(PLAIN_TEXT_MAIL, "att-9")).toBeNull();
    expect(await findAttachment(PLAIN_TEXT_MAIL, "not-an-id")).toBeNull();
  });
});

describe("downloadContentType", () => {
  it("forces application/octet-stream for a type or extension the browser would render", () => {
    expect(downloadContentType({ contentType: "text/html", filename: "note.txt" })).toBe(
      "application/octet-stream",
    );
    expect(downloadContentType({ contentType: "image/svg+xml", filename: undefined })).toBe(
      "application/octet-stream",
    );
    expect(
      downloadContentType({ contentType: "application/octet-stream", filename: "page.html" }),
    ).toBe("application/octet-stream");
  });

  it("passes through an ordinary attachment type", () => {
    expect(downloadContentType({ contentType: "application/pdf", filename: "report.pdf" })).toBe(
      "application/pdf",
    );
    expect(downloadContentType({ contentType: "image/png", filename: "logo.png" })).toBe(
      "image/png",
    );
  });

  it("forces application/octet-stream for any +xml content type and text/xsl", () => {
    // Every `…+xml` type (RFC 6839's structured syntax suffix) is an XML
    // document a browser renders, not only the specific ones named above.
    expect(downloadContentType({ contentType: "application/rss+xml", filename: undefined })).toBe(
      "application/octet-stream",
    );
    expect(downloadContentType({ contentType: "application/atom+xml", filename: undefined })).toBe(
      "application/octet-stream",
    );
    expect(
      downloadContentType({ contentType: "application/mathml+xml", filename: undefined }),
    ).toBe("application/octet-stream");
    expect(downloadContentType({ contentType: "text/xsl", filename: undefined })).toBe(
      "application/octet-stream",
    );
  });

  it("forces application/octet-stream for the extended set of renderable extensions", () => {
    expect(downloadContentType({ contentType: "application/pdf", filename: "report.xsl" })).toBe(
      "application/octet-stream",
    );
    expect(downloadContentType({ contentType: "application/pdf", filename: "report.xht" })).toBe(
      "application/octet-stream",
    );
    expect(downloadContentType({ contentType: "application/pdf", filename: "report.mht" })).toBe(
      "application/octet-stream",
    );
  });

  it("ignores a charset parameter when matching a renderable content type", () => {
    expect(
      downloadContentType({ contentType: "text/html; charset=utf-8", filename: undefined }),
    ).toBe("application/octet-stream");
  });
});

describe("headersFromMetadata / unavailablePreview", () => {
  it("splits the manifest's comma-separated to/cc into arrays", () => {
    const headers = headersFromMetadata({
      subject: "Big export",
      from: "anna@example.com",
      to: "bob@example.com, carla@example.com",
      cc: "dave@example.com",
      sentDateTime: "2026-01-01T00:00:00Z",
      messageId: "<big@example.com>",
    });
    expect(headers).toEqual({
      subject: "Big export",
      from: "anna@example.com",
      to: ["bob@example.com", "carla@example.com"],
      cc: ["dave@example.com"],
      date: "2026-01-01T00:00:00Z",
      messageId: "<big@example.com>",
    });
  });

  it("keeps a quoted 'Last, First' display name as one recipient instead of splitting on its comma", () => {
    const headers = headersFromMetadata({
      subject: "Directory name",
      to: '"Flores, Lucas" <lucas@example.test>, bob@example.test',
      cc: '"Doe, Jane" <jane@example.test>',
    });
    expect(headers.to).toEqual(['"Flores, Lucas" <lucas@example.test>', "bob@example.test"]);
    expect(headers.cc).toEqual(['"Doe, Jane" <jane@example.test>']);
  });

  it("builds a not-previewable result without reading any content", () => {
    const result = unavailablePreview("too-large", { subject: "Huge attachment" });
    expect(result).toEqual({
      previewable: false,
      reason: "too-large",
      headers: {
        subject: "Huge attachment",
        from: null,
        to: [],
        cc: [],
        date: null,
        messageId: null,
      },
      attachments: [],
    });
  });
});

describe("PREVIEW_SIZE_CAP_BYTES", () => {
  it("is a positive, sane bound", () => {
    expect(PREVIEW_SIZE_CAP_BYTES).toBeGreaterThan(1024 * 1024);
    expect(PREVIEW_SIZE_CAP_BYTES).toBeLessThan(100 * 1024 * 1024);
  });
});
