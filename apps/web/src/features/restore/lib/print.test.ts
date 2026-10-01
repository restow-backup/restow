// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildPrintDocument, createPrintFrame, printMessage } from "./print";

const labels = {
  subject: "Subject",
  from: "From",
  to: "To",
  cc: "Cc",
  date: "Received",
  noSubject: "(no subject)",
};

describe("buildPrintDocument", () => {
  it("carries the same CSP as the reading pane's srcdoc and never a <script>", () => {
    const html = buildPrintDocument(
      {
        subject: "Q3 report",
        from: "a@x.com",
        to: "b@x.com",
        cc: null,
        date: "23 Sep 2026",
        body: { kind: "html", content: "<p>Hi</p>" },
      },
      labels,
    );
    expect(html).toContain(
      `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"`,
    );
    expect(html).not.toMatch(/<script/i);
  });

  it("includes only the headers that are known", () => {
    const html = buildPrintDocument(
      {
        subject: "Q3 report",
        from: "a@x.com",
        to: null,
        cc: null,
        date: null,
        body: { kind: "html", content: "<p>Hi</p>" },
      },
      labels,
    );
    expect(html).toContain("Q3 report");
    expect(html).toContain("a@x.com");
    expect(html).not.toContain(">To<");
    expect(html).not.toContain(">Received<");
  });

  it("falls back to the 'no subject' label", () => {
    const html = buildPrintDocument(
      {
        subject: null,
        from: null,
        to: null,
        cc: null,
        date: null,
        body: { kind: "text", content: "hi" },
      },
      labels,
    );
    expect(html).toContain("(no subject)");
  });

  it("escapes header values but embeds the (already sanitised) HTML body as-is", () => {
    const html = buildPrintDocument(
      {
        subject: "<b>bold</b> & co",
        from: null,
        to: null,
        cc: null,
        date: null,
        body: { kind: "html", content: "<p>already sanitised &amp; safe</p>" },
      },
      labels,
    );
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; co");
    expect(html).toContain("<p>already sanitised &amp; safe</p>");
  });

  it("wraps a plain-text body in an escaped <pre>", () => {
    const html = buildPrintDocument(
      {
        subject: "Plain",
        from: null,
        to: null,
        cc: null,
        date: null,
        body: { kind: "text", content: "line 1 <not a tag>" },
      },
      labels,
    );
    expect(html).toContain("<pre>line 1 &lt;not a tag&gt;</pre>");
  });
});

describe("printMessage", () => {
  afterEach(() => {
    for (const frame of document.querySelectorAll("iframe")) {
      frame.remove();
    }
  });

  it("sandboxes the throwaway iframe with allow-modals (Chrome drops print() without it) and never allow-scripts", () => {
    printMessage("<p>hi</p>");
    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("sandbox")).toBe("allow-same-origin allow-modals");
    expect(iframe?.getAttribute("sandbox")).not.toContain("allow-scripts");
  });

  it("never sizes the throwaway iframe to 0×0 (some engines skip laying out a zero-area frame)", () => {
    printMessage("<p>hi</p>");
    const iframe = document.querySelector("iframe");
    expect(iframe?.style.width).not.toBe("0");
    expect(iframe?.style.width).not.toBe("0px");
    expect(iframe?.style.height).not.toBe("0");
    expect(iframe?.style.height).not.toBe("0px");
  });

  it("prints exactly once, only once the srcdoc document itself has loaded", () => {
    const { iframe, handleLoad } = createPrintFrame("<p>hi</p>");
    const blankWindow = { print: vi.fn(), focus: vi.fn(), addEventListener: vi.fn() };
    const srcdocWindow = { print: vi.fn(), focus: vi.fn(), addEventListener: vi.fn() };

    // The iframe's own initial `about:blank` document loads first; this must
    // never print (it would print an empty page).
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => ({ URL: "about:blank" }),
    });
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => blankWindow,
    });
    handleLoad();
    expect(blankWindow.print).not.toHaveBeenCalled();

    // The `srcdoc` document loads second; only this one is the message.
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => ({ URL: "about:srcdoc" }),
    });
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => srcdocWindow,
    });
    handleLoad();
    expect(srcdocWindow.print).toHaveBeenCalledTimes(1);
    expect(srcdocWindow.focus).toHaveBeenCalledTimes(1);
  });
});
