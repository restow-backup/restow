/**
 * Copying text from a click, on every origin Restow runs on. Browsers offer
 * the async Clipboard API only on secure origins (HTTPS, localhost); an
 * installation reached over plain HTTP by IP address has no
 * `navigator.clipboard`, so the copy falls back to the older copy command on
 * a hidden text field.
 */

/** The browser parts the copy uses (injectable for tests). */
export interface ClipboardEnvironment {
  clipboard?: Pick<Clipboard, "writeText"> | null;
  document?: Pick<Document, "createElement" | "execCommand" | "body" | "activeElement"> | null;
}

function browserEnvironment(): ClipboardEnvironment {
  return {
    clipboard: typeof navigator === "undefined" ? null : navigator.clipboard,
    document: typeof document === "undefined" ? null : document,
  };
}

/**
 * The copy command on a hidden, read-only text field. The field goes next to
 * `anchor` (the clicked button) rather than at the end of the page, so a
 * dialog's focus trap lets it take focus; focus returns to the anchor after.
 */
function copyWithCommand(
  value: string,
  doc: NonNullable<ClipboardEnvironment["document"]>,
  anchor: HTMLElement | null,
): void {
  if (typeof doc.execCommand !== "function") {
    throw new Error("No clipboard access in this browser");
  }
  const field = doc.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.tabIndex = -1;
  field.setAttribute("aria-hidden", "true");
  field.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";

  const previousFocus = doc.activeElement as HTMLElement | null;
  const host = anchor?.parentElement ?? doc.body;
  host.appendChild(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, value.length);
    copied = doc.execCommand("copy");
  } finally {
    field.remove();
    const restore = previousFocus && previousFocus !== doc.body ? previousFocus : anchor;
    restore?.focus({ preventScroll: true });
  }
  if (!copied) {
    throw new Error("The browser refused to copy");
  }
}

/**
 * Put `value` on the clipboard: the Clipboard API where the browser offers
 * it, otherwise (or when it refuses) the copy command. Rejects when neither
 * worked, so the caller can say so.
 */
export async function copyToClipboard(
  value: string,
  anchor: HTMLElement | null = null,
  environment: ClipboardEnvironment = browserEnvironment(),
): Promise<void> {
  const { clipboard, document: doc } = environment;
  if (typeof clipboard?.writeText === "function") {
    try {
      await clipboard.writeText(value);
      return;
    } catch (cause) {
      // Denied (for example, the page lost focus): the copy command may still work.
      if (!doc) {
        throw cause;
      }
    }
  }
  if (!doc) {
    throw new Error("No clipboard access outside a browser");
  }
  copyWithCommand(value, doc, anchor);
}
