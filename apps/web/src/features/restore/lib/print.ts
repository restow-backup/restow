/**
 * Printing one message: `buildPrintDocument` is the print-only HTML, pure so
 * it is unit-tested without a DOM; `printMessage` loads it into a throwaway,
 * hidden iframe and prints through the *iframe's own* window
 * (`contentWindow.print()`) rather than the host page's `window.print()`, so
 * the browser's print dialog shows only the message, with none of the app's
 * own chrome. See explorer/reading-pane.tsx for how this is wired to the
 * print button.
 *
 * Same CSP as the reading pane's own `srcdoc` (no scripts, `img-src data:`
 * only, inline styles only): the server already sanitised `body.content` for
 * that iframe, and this reuses it as-is, so it must stay unable to run script
 * here too.
 *
 * Cross-browser notes: verified interactively against a real Chromium engine
 * (the iframe fires `load` twice — once for `about:blank`, once for the
 * `srcdoc` document — `contentWindow.print()` fires exactly once, only for
 * the `srcdoc` load, and the printed document holds only the headers table
 * and the sanitised body, no app chrome and no `<script>`). Firefox has not
 * been run interactively in any environment available while building this
 * feature; the notes below on `allow-modals` and frame sizing follow the
 * HTML sandbox-attribute spec, which Firefox implements the same way, but
 * that is a spec reading, not an observed Firefox run — treat it as
 * unverified until someone attaches a real Firefox window and confirms it.
 * - `allow-modals` is required for `contentWindow.print()` to open a dialog
 *   at all from a sandboxed frame; this is a sandbox-token restriction in
 *   the HTML spec itself (not a Chrome quirk), so it applies the same way in
 *   every conformant engine, Firefox included.
 * - The frame is sized 1×1px, not 0×0: some engines skip laying out a
 *   zero-area iframe (or its subresources) as a performance optimisation,
 *   which can leave `srcdoc` unrendered before printing ever gets a chance
 *   to trigger. A 1px frame keeps a real, if invisible, layout box.
 * - Cleanup prefers the `afterprint` event and only falls back to a timer if
 *   an engine never fires it for a frame's own window; that timer is long
 *   (60s) specifically because Firefox's print preview is a modal the user
 *   can leave open far longer than Chrome's native dialog, and removing the
 *   iframe out from under an open preview would blank it.
 */

export interface PrintableMessage {
  subject: string | null;
  from: string | null;
  to: string | null;
  cc: string | null;
  /** Already formatted and localised (the caller formats the ISO date). */
  date: string | null;
  body: { kind: "html" | "text"; content: string };
}

export interface PrintLabels {
  subject: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  noSubject: string;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

export function buildPrintDocument(message: PrintableMessage, labels: PrintLabels): string {
  const rows: Array<[string, string]> = [
    [labels.subject, message.subject ?? labels.noSubject],
    ...(message.from ? [[labels.from, message.from] as [string, string]] : []),
    ...(message.to ? [[labels.to, message.to] as [string, string]] : []),
    ...(message.cc ? [[labels.cc, message.cc] as [string, string]] : []),
    ...(message.date ? [[labels.date, message.date] as [string, string]] : []),
  ];
  const headerRows = rows
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join("");
  const bodyHtml =
    message.body.kind === "html"
      ? message.body.content
      : `<pre>${escapeHtml(message.body.content)}</pre>`;
  const title = escapeHtml(message.subject ?? labels.noSubject);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<title>${title}</title>
<style>
  body { font-family: sans-serif; font-size: 12pt; color: #000; margin: 1.5cm; }
  table.headers { border-collapse: collapse; margin-bottom: 1em; width: 100%; }
  table.headers th { text-align: left; padding: 0.1em 0.75em 0.1em 0; color: #555; font-weight: 600; vertical-align: top; white-space: nowrap; }
  table.headers td { padding: 0.1em 0; word-break: break-word; }
  hr { border: none; border-top: 1px solid #ccc; margin: 1em 0; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; }
  img { max-width: 100%; }
</style>
</head>
<body>
<table class="headers">${headerRows}</table>
<hr>
${bodyHtml}
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Printing through a throwaway iframe
// ---------------------------------------------------------------------------

export interface PrintFrame {
  iframe: HTMLIFrameElement;
  /**
   * The iframe's `load` handler, exposed so it can be driven directly in
   * tests without depending on a real browser actually loading an iframe's
   * `srcdoc`. A real iframe fires `load` twice for `srcdoc` content: once for
   * its own initial `about:blank` document, once more for the `srcdoc`
   * document itself. Printing on the first call would print an empty page,
   * so this only prints once `contentDocument.URL` is `about:srcdoc`.
   */
  handleLoad: () => void;
}

/** Builds (and attaches) the throwaway iframe `printMessage` prints through; split out so tests can drive `handleLoad` directly. */
export function createPrintFrame(html: string, doc: Document = document): PrintFrame {
  const iframe = doc.createElement("iframe");
  // `allow-modals` is required: without it, Chrome silently drops a sandboxed
  // document's `print()` call and no dialog ever opens. `allow-same-origin`
  // lets the parent call `contentWindow.print()` at all (cross-origin frames
  // block script access to their window); never `allow-scripts`, so the
  // sanitised message itself still cannot run script.
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.position = "fixed";
  iframe.style.inset = "auto 0 0 auto";
  // 1px, not 0: a zero-area iframe risks an engine skipping its layout (and
  // so its `srcdoc` content) entirely before `print()` ever runs.
  iframe.style.width = "1px";
  iframe.style.height = "1px";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.border = "0";

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  };

  const handleLoad = () => {
    if (iframe.contentDocument?.URL !== "about:srcdoc") {
      // The iframe's own initial `about:blank` document, not the message yet.
      return;
    }
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    win.addEventListener("afterprint", cleanup, { once: true });
    win.focus();
    win.print();
    // Not every engine fires `afterprint` for a frame's window; this is the
    // fallback. It is deliberately generous (not the usual few seconds): a
    // print *preview* (Firefox's own dialog is one) can stay open far
    // longer than that while someone adjusts settings, and removing the
    // iframe out from under it would blank the preview mid-review.
    (doc.defaultView ?? window).setTimeout(cleanup, 60_000);
  };

  iframe.addEventListener("load", handleLoad);
  doc.body.appendChild(iframe);
  iframe.srcdoc = html;
  return { iframe, handleLoad };
}

/** Prints `html` (from {@link buildPrintDocument}) through a throwaway, hidden iframe. */
export function printMessage(html: string): void {
  createPrintFrame(html);
}
