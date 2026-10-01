import { describe, expect, it } from "vitest";

import { type ClipboardEnvironment, copyToClipboard } from "./clipboard.js";

/** A minimal stand-in for the page: records the hidden field and the copy command. */
function fakeDocument(copyResult: boolean | "throw") {
  const log: string[] = [];
  const attached = new Set<unknown>();
  const focusable = (name: string) => ({ focus: () => log.push(`focus:${name}`) });
  const button = { ...focusable("button"), parentElement: null as unknown };
  const body = {
    ...focusable("body"),
    appendChild: (node: unknown) => {
      attached.add(node);
      log.push("append:body");
    },
  };
  const host = {
    appendChild: (node: unknown) => {
      attached.add(node);
      log.push("append:host");
    },
  };
  button.parentElement = host;

  const field = {
    value: "",
    readOnly: false,
    tabIndex: 0,
    style: { cssText: "" },
    setAttribute: () => {},
    focus: () => log.push("focus:field"),
    select: () => log.push("select"),
    setSelectionRange: () => {},
    remove: () => {
      attached.delete(field);
      log.push("remove");
    },
  };

  const doc = {
    body,
    activeElement: button,
    createElement: () => field,
    execCommand: (command: string) => {
      log.push(`exec:${command}:${field.value}`);
      if (copyResult === "throw") {
        throw new Error("blocked");
      }
      return copyResult;
    },
  };
  return {
    log,
    field,
    attached,
    button: button as unknown as HTMLElement,
    document: doc as unknown as NonNullable<ClipboardEnvironment["document"]>,
  };
}

describe("copyToClipboard", () => {
  it("uses the Clipboard API where the browser offers it", async () => {
    const written: string[] = [];
    const page = fakeDocument(true);
    await copyToClipboard("abc", null, {
      clipboard: { writeText: async (text) => void written.push(text) },
      document: page.document,
    });
    expect(written).toEqual(["abc"]);
    expect(page.log).toEqual([]);
  });

  it("falls back to the copy command on plain HTTP (no Clipboard API)", async () => {
    const page = fakeDocument(true);
    await copyToClipboard("https://restow.example/callback", page.button, {
      clipboard: undefined,
      document: page.document,
    });
    expect(page.log).toEqual([
      // Next to the button, so a dialog's focus trap lets the field take focus.
      "append:host",
      "focus:field",
      "select",
      "exec:copy:https://restow.example/callback",
      "remove",
      "focus:button",
    ]);
    expect(page.field.readOnly).toBe(true);
    expect(page.attached.size).toBe(0);
  });

  it("falls back to the copy command when the Clipboard API refuses", async () => {
    const page = fakeDocument(true);
    await copyToClipboard("abc", null, {
      clipboard: {
        writeText: () =>
          Promise.reject(new DOMException("Document is not focused", "NotAllowedError")),
      },
      document: page.document,
    });
    expect(page.log).toContain("append:body");
    expect(page.log).toContain("exec:copy:abc");
  });

  it("rejects when the copy command fails, and still cleans up", async () => {
    const refused = fakeDocument(false);
    await expect(
      copyToClipboard("abc", refused.button, { clipboard: null, document: refused.document }),
    ).rejects.toThrow();
    expect(refused.attached.size).toBe(0);

    const blocked = fakeDocument("throw");
    await expect(
      copyToClipboard("abc", blocked.button, { clipboard: null, document: blocked.document }),
    ).rejects.toThrow("blocked");
    expect(blocked.attached.size).toBe(0);
    expect(blocked.log.at(-1)).toBe("focus:button");
  });

  it("rejects outside a browser", async () => {
    await expect(
      copyToClipboard("abc", null, { clipboard: null, document: null }),
    ).rejects.toThrow();
  });
});
