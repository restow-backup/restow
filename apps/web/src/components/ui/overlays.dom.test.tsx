// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { i18n } from "@/i18n";

/**
 * Overlays never leave the viewport. A dialog sits in an overlay that spans the
 * viewport from its top edge, at most one viewport high, and centres it with auto margins (no
 * `top: 50%` plus a -50% translate, which pushed a dialog off the bottom of
 * the screen), the dialog is capped at that height and scrolls inside, and its
 * header and footer stay in view. A select opens below its trigger, at most
 * 24rem high and as wide as its longest option. Layout itself cannot be
 * measured in happy-dom, so these pin the structure and the classes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function render(node: React.ReactNode): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function classesOf(selector: string): string[] {
  const element = document.body.querySelector(selector);
  if (!element) {
    throw new Error(`nothing matches ${selector}`);
  }
  return element.className.split(/\s+/);
}

describe("Dialog", () => {
  it("sits in a viewport-high overlay instead of being translated to the middle", async () => {
    await render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <p>Body</p>
          <DialogFooter>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const content = document.body.querySelector('[data-slot="dialog-content"]');
    expect(content?.parentElement?.getAttribute("data-slot")).toBe("dialog-overlay");

    const overlay = classesOf('[data-slot="dialog-overlay"]');
    expect(overlay).toEqual(
      expect.arrayContaining([
        "fixed",
        "inset-0",
        "max-h-screen",
        "supports-[height:100dvh]:max-h-dvh",
        "flex",
        "overflow-y-auto",
        "p-4",
      ]),
    );

    const box = classesOf('[data-slot="dialog-content"]');
    expect(box).toEqual(expect.arrayContaining(["m-auto", "max-h-full", "overflow-y-auto"]));
    expect(box.join(" ")).not.toMatch(/top-\[50%\]|translate-y|fixed/);
  });

  it("keeps a visible header and the footer in view while the dialog scrolls", async () => {
    await render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button">Save</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    expect(classesOf('[data-slot="dialog-header"]')).toEqual(
      expect.arrayContaining(["[&:not(.sr-only)]:sticky", "[&:not(.sr-only)]:-top-6"]),
    );
    expect(classesOf('[data-slot="dialog-footer"]')).toEqual(
      expect.arrayContaining(["sticky", "-bottom-6", "bg-background"]),
    );
  });

  it("leaves a screen-reader-only header out of the layout", async () => {
    await render(
      <Dialog open>
        <DialogContent>
          <DialogHeader className="sr-only">
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>,
    );
    const header = classesOf('[data-slot="dialog-header"]');
    expect(header).toContain("sr-only");
    // Every sticky class is scoped to `:not(.sr-only)`.
    expect(header.filter((name) => /(^|:)sticky$/.test(name))).toEqual([
      "[&:not(.sr-only)]:sticky",
    ]);
  });
});

describe("AlertDialog", () => {
  it("is placed and scrolls like a dialog", async () => {
    await render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Title</AlertDialogTitle>
            <AlertDialogDescription>Description</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <button type="button">OK</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    );
    const content = document.body.querySelector('[data-slot="alert-dialog-content"]');
    expect(content?.parentElement?.getAttribute("data-slot")).toBe("alert-dialog-overlay");
    expect(classesOf('[data-slot="alert-dialog-overlay"]')).toEqual(
      expect.arrayContaining(["supports-[height:100dvh]:max-h-dvh", "overflow-y-auto"]),
    );
    const box = classesOf('[data-slot="alert-dialog-content"]');
    expect(box).toEqual(expect.arrayContaining(["m-auto", "max-h-full", "overflow-y-auto"]));
    expect(box.join(" ")).not.toMatch(/top-\[50%\]|translate-y/);
    expect(classesOf('[data-slot="alert-dialog-footer"]')).toEqual(
      expect.arrayContaining(["sticky", "-bottom-6"]),
    );
  });
});

describe("Sheet", () => {
  it("is one viewport high at most and scrolls inside", async () => {
    await render(
      <Sheet open>
        <SheetContent side="right">
          <SheetTitle>Title</SheetTitle>
          <SheetDescription>Description</SheetDescription>
        </SheetContent>
      </Sheet>,
    );
    const sheet = classesOf('[data-slot="sheet-content"]');
    expect(sheet).toEqual(
      expect.arrayContaining([
        "inset-y-0",
        "max-h-screen",
        "supports-[height:100dvh]:max-h-dvh",
        "overflow-y-auto",
      ]),
    );
    expect(sheet).not.toContain("h-full");
  });
});

describe("Select", () => {
  it("opens below the trigger, at most 24rem high and as wide as its longest option", async () => {
    await render(
      <Select open value="a">
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Shared and personal</SelectItem>
          <SelectItem value="b">Shared or blocked only</SelectItem>
        </SelectContent>
      </Select>,
    );
    const content = classesOf('[data-slot="select-content"]');
    expect(content).toEqual(
      expect.arrayContaining([
        "max-h-[min(var(--radix-select-content-available-height),24rem)]",
        "w-max",
        "min-w-(--radix-select-trigger-width)",
        "max-w-(--radix-select-content-available-width)",
      ]),
    );
    // Popper placement: Radix wraps the list in its positioning wrapper.
    expect(
      document.body.querySelector(
        '[data-radix-popper-content-wrapper] [data-slot="select-content"]',
      ),
    ).not.toBeNull();
  });

  it("never cuts the chosen value off in the trigger", async () => {
    await render(
      <Select value="a">
        <SelectTrigger className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Shared and personal</SelectItem>
        </SelectContent>
      </Select>,
    );
    const trigger = classesOf('[data-slot="select-trigger"]').join(" ");
    expect(trigger).not.toMatch(/line-clamp|truncate|whitespace-nowrap|(^| )h-9( |$)/);
    expect(trigger).toContain("data-[size=default]:min-h-9");
  });
});
