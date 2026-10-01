import { beforeAll, describe, expect, it } from "vitest";

import { render } from "@/components/kit/test-utils";
import { i18n } from "@/i18n";

import type { EntryPreview } from "../api.js";
import { ReadingPaneView } from "./reading-pane.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const baseHeaders = {
  subject: "Contract draft",
  from: "legal@example.com",
  to: ["anna@example.com"],
  cc: [] as string[],
  date: "2026-09-20T10:00:00.000Z",
  messageId: "<contract@example.com>",
};

function preview(patch: Partial<EntryPreview> = {}): EntryPreview {
  return {
    previewable: true,
    headers: baseHeaders,
    body: { kind: "html", content: "<p>Please review the attached draft.</p>" },
    attachments: [
      {
        id: "a1",
        filename: "draft.pdf",
        contentType: "application/pdf",
        size: 20480,
        inline: false,
      },
    ],
    ...patch,
  } as EntryPreview;
}

describe("ReadingPaneView", () => {
  it("shows the headers, joining multiple recipients", () => {
    const html = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({
          headers: { ...baseHeaders, to: ["anna@example.com", "bob@example.com"] },
        })}
      />,
    );
    expect(html).toContain("Contract draft");
    expect(html).toContain("legal@example.com");
    expect(html).toContain("anna@example.com, bob@example.com");
  });

  it("renders the HTML body in a sandboxed iframe via srcdoc with its own CSP", () => {
    const html = render(
      <ReadingPaneView snapshotId="s1" entryId="e1" tenantId="t1" preview={preview()} />,
    );
    expect(html).toContain("<iframe");
    // Only `allow-popups`/`allow-popups-to-escape-sandbox`, so a link the
    // server rewrote to `target="_blank"` still opens: never script
    // execution or same-origin access (the print button opens its own
    // separate throwaway iframe instead — see lib/print.ts).
    expect(html).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain("allow-scripts");
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("allow-forms");
    expect(html).not.toContain("allow-top-navigation");
    expect(html).toContain("Please review the attached draft.");
    expect(html).toContain(
      "Content-Security-Policy&quot; content=&quot;default-src &#x27;none&#x27;; img-src data:; style-src &#x27;unsafe-inline&#x27;",
    );
  });

  it("renders a plain-text body directly, without an iframe", () => {
    const html = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ body: { kind: "text", content: "Plain text body" } })}
      />,
    );
    expect(html).not.toContain("<iframe");
    expect(html).toContain("<pre");
    expect(html).toContain("Plain text body");
  });

  it("lists attachments with a download link, skips inline parts, and falls back to a generic name", () => {
    const withAttachment = render(
      <ReadingPaneView snapshotId="s1" entryId="e1" tenantId="t1" preview={preview()} />,
    );
    expect(withAttachment).toContain("draft.pdf");
    expect(withAttachment).toContain("/snapshots/s1/entries/e1/attachments/a1");
    expect(withAttachment).toContain('aria-label="Download draft.pdf"');

    const empty = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ attachments: [] })}
      />,
    );
    expect(empty).toContain("No attachments");

    const inlineOnly = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({
          attachments: [
            { id: "a2", filename: "logo.png", contentType: "image/png", size: 512, inline: true },
          ],
        })}
      />,
    );
    expect(inlineOnly).toContain("No attachments");
    expect(inlineOnly).not.toContain("logo.png");

    const unnamed = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({
          attachments: [
            {
              id: "a3",
              filename: null,
              contentType: "application/octet-stream",
              size: 10,
              inline: false,
            },
          ],
        })}
      />,
    );
    expect(unnamed).toContain("Unnamed attachment");
  });

  it("shows an explanatory notice instead of a body for a rights-protected mail", () => {
    const html = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ previewable: false, reason: "rights-protected" })}
      />,
    );
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<pre");
    expect(html).toContain("Rights-protected by Microsoft Purview");
    expect(html).toContain("restoring into the mailbox works");
  });

  it("shows an explanatory notice for an S/MIME-encrypted mail", () => {
    const html = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ previewable: false, reason: "smime-encrypted" })}
      />,
    );
    expect(html).toContain("S/MIME-encrypted");
  });

  it("explains an oversized or unsupported-format message without claiming it is protected", () => {
    const tooLarge = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ previewable: false, reason: "too-large" })}
      />,
    );
    expect(tooLarge).toContain("too large to show here");
    expect(tooLarge).not.toContain("Purview");
    expect(tooLarge).not.toContain("S/MIME");

    const unsupported = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ previewable: false, reason: "unsupported-format" })}
      />,
    );
    expect(unsupported).toContain("format that cannot be shown here");
  });

  it("explains a message that could not be read within the preview's limits", () => {
    const html = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({ previewable: false, reason: "unreadable", attachments: [] })}
      />,
    );
    expect(html).toContain("could not be read within the time and memory");
    expect(html).toContain("restore it into the mailbox");
    expect(html).toContain("Contract draft");
    expect(html).not.toContain("Purview");
    expect(html).not.toContain("<iframe");
  });

  it("says when the formatted view was replaced by the text of the message, and shows that text", () => {
    const html = render(
      <ReadingPaneView
        snapshotId="s1"
        entryId="e1"
        tenantId="t1"
        preview={preview({
          simplified: true,
          body: { kind: "text", content: "Only the words" },
        })}
      />,
    );
    expect(html).toContain("Simplified view");
    expect(html).toContain("was too large to prepare");
    expect(html).toContain("Only the words");
    expect(html).not.toContain("<iframe");
  });

  it("shows no simplification notice for an ordinary message", () => {
    const html = render(
      <ReadingPaneView snapshotId="s1" entryId="e1" tenantId="t1" preview={preview()} />,
    );
    expect(html).not.toContain("Simplified view");
  });

  it("never offers a 'show remote images' control", () => {
    const html = render(
      <ReadingPaneView snapshotId="s1" entryId="e1" tenantId="t1" preview={preview()} />,
    );
    expect(html.toLowerCase()).not.toContain("remote image");
  });
});
