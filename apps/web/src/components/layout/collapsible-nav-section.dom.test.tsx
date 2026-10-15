// @vitest-environment happy-dom
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import {
  CollapsibleNavSection,
  navSectionKey,
  readSectionOpen,
  type SectionStorage,
  writeSectionOpen,
} from "@/components/layout/collapsible-nav-section";

/**
 * The collapsible installation section of the sidebar (#56) in a real DOM:
 * the toggle, the remembered state and the opening on navigation.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function memoryStorage(initial: Record<string, string> = {}): SectionStorage & {
  data: Record<string, string>;
} {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

const throwing: SectionStorage = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
};

function section(props: Partial<React.ComponentProps<typeof CollapsibleNavSection>> = {}) {
  return (
    <CollapsibleNavSection id="installation" label="Installation" activeId={null} {...props}>
      <a href="/license">License</a>
    </CollapsibleNavSection>
  );
}

function mount(node: React.ReactNode) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

function rerender(node: React.ReactNode) {
  act(() => root?.render(node));
}

const toggle = () => document.querySelector<HTMLButtonElement>("button[aria-controls]");
const content = () => document.querySelector<HTMLElement>('[data-slot="nav-section-content"]');

describe("the remembered state", () => {
  it("is open unless it was closed, and survives storage that throws", () => {
    expect(readSectionOpen("installation", memoryStorage())).toBe(true);
    expect(
      readSectionOpen("installation", memoryStorage({ [navSectionKey("installation")]: "false" })),
    ).toBe(false);
    expect(readSectionOpen("installation", throwing)).toBe(true);
    expect(readSectionOpen("installation", null)).toBe(true);
    expect(() => writeSectionOpen("installation", false, throwing)).not.toThrow();
  });
});

describe("CollapsibleNavSection", () => {
  it("toggles with its header, says so to assistive technology and remembers the choice", () => {
    const storage = memoryStorage();
    mount(section({ storage }));
    const button = toggle();
    expect(button?.textContent).toBe("Installation");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(button?.getAttribute("aria-controls")).toBe(content()?.id);
    expect(content()?.hasAttribute("inert")).toBe(false);

    act(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(content()?.hasAttribute("inert")).toBe(true);
    expect(content()?.className).toContain("grid-rows-[0fr]");
    expect(storage.data[navSectionKey("installation")]).toBe("false");

    act(() => button?.click());
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(storage.data[navSectionKey("installation")]).toBe("true");
  });

  it("animates height and opacity, and not at all with reduced motion", () => {
    mount(section({ storage: memoryStorage() }));
    const classes = content()?.className ?? "";
    expect(classes).toContain("transition-[grid-template-rows,opacity]");
    expect(classes).toContain("duration-200");
    expect(classes).toContain("motion-reduce:transition-none");
  });

  it("starts closed when it was left closed", () => {
    mount(section({ storage: memoryStorage({ [navSectionKey("installation")]: "false" }) }));
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens when the current page is in it, without remembering that as a choice", () => {
    const storage = memoryStorage({ [navSectionKey("installation")]: "false" });
    mount(section({ storage }));
    expect(toggle()?.getAttribute("aria-expanded")).toBe("false");

    rerender(section({ storage, activeId: "license" }));
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(storage.data[navSectionKey("installation")]).toBe("false");
  });

  it("opens on a page in it even when it was closed before loading", () => {
    const storage = memoryStorage({ [navSectionKey("installation")]: "false" });
    mount(section({ storage, activeId: "license" }));
    expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
  });

  it("shows its entries on the icon rail whatever was remembered", () => {
    mount(
      section({
        storage: memoryStorage({ [navSectionKey("installation")]: "false" }),
        forceOpen: true,
      }),
    );
    expect(content()?.hasAttribute("inert")).toBe(false);
    expect(toggle()?.tabIndex).toBe(-1);
  });
});
