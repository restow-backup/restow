// @vitest-environment happy-dom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { i18n } from "@/i18n";
import { applyProductName } from "@/lib/branding";

import { BrandName, RestowMark, Wordmark } from "./wordmark";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  applyProductName(undefined);
});

function mount(node: React.ReactNode): void {
  act(() => root.render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>));
}

describe("RestowMark", () => {
  it("draws the hold and the bar of the brand guide on the 48 grid", () => {
    mount(<RestowMark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 48 48");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");

    const hold = container.querySelector("path");
    expect(hold?.getAttribute("d")).toBe("M10 13 v15 a10 10 0 0 0 10 10 h8 a10 10 0 0 0 10-10 V13");
    expect(hold?.getAttribute("stroke-width")).toBe("7");
    expect(hold?.getAttribute("stroke-linecap")).toBe("round");
    expect(hold?.getAttribute("fill")).toBe("none");

    const bar = container.querySelector("rect");
    expect(["x", "y", "width", "height", "rx"].map((name) => bar?.getAttribute(name))).toEqual([
      "15.5",
      "25",
      "17",
      "7",
      "2",
    ]);
  });

  it("takes its colours from the mark's own tokens, not from the interface's text and primary colours", () => {
    mount(<RestowMark />);
    const hold = container.querySelector("path")?.getAttribute("class") ?? "";
    const bar = container.querySelector("rect")?.getAttribute("class") ?? "";
    expect(hold).toBe("stroke-mark-hold");
    expect(bar).toBe("fill-mark-beam");
    // The colour scheme Neutral recolours --foreground and --primary; the mark must not follow it.
    for (const interfaceColour of ["foreground", "primary", "background", "muted", "accent"]) {
      expect(hold, interfaceColour).not.toContain(interfaceColour);
      expect(bar, interfaceColour).not.toContain(interfaceColour);
    }
    // No fixed colours either: the tokens carry Nile/Lapis and Limestone/Lapis Dark, and white label.
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(container.innerHTML).not.toContain("dark:");
  });

  it("has a one-colour variant that follows the text colour", () => {
    mount(<RestowMark mono />);
    const hold = container.querySelector("path")?.getAttribute("class") ?? "";
    const bar = container.querySelector("rect")?.getAttribute("class") ?? "";
    expect(hold).toBe("stroke-current");
    expect(bar).toBe("fill-current");
  });

  it("never uses the success green: a bar that is merely finished is not a checked one", () => {
    mount(<RestowMark />);
    expect(container.innerHTML.toLowerCase()).not.toContain("2da37a");
    expect(container.innerHTML).not.toMatch(/success/);
    mount(<Wordmark />);
    expect(container.innerHTML.toLowerCase()).not.toContain("2da37a");
    expect(container.innerHTML).not.toMatch(/success/);
  });
});

describe("BrandName", () => {
  it("sets the default name as the wordmark, lowercase, and keeps the plain name for screen readers", () => {
    mount(<BrandName />);
    const visible = container.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toBe("restowbackup suite");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Restow");
    const parts = [...(visible?.querySelectorAll("span") ?? [])].map((part) => part.textContent);
    expect(parts).toEqual(["restow", "backup suite"]);
  });

  it("sets the second part in the mono face and the secondary text colour, not in a fixed colour", () => {
    mount(<BrandName />);
    const [name, descriptor] = [
      ...(container.querySelector('[aria-hidden="true"]')?.querySelectorAll("span") ?? []),
    ];
    expect(name?.className).toContain("font-wordmark");
    expect(name?.className).toContain("font-bold");
    expect(descriptor?.className).toContain("font-wordmark-tag");
    expect(descriptor?.className).toContain("text-muted-foreground");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(container.innerHTML.toLowerCase()).not.toContain("success");
  });

  it("shows an operator's own product name as written, without the wordmark styling", () => {
    applyProductName("Acme Backup");
    mount(<BrandName />);
    expect(container.textContent).toBe("Acme Backup");
    expect(container.textContent).not.toContain("backup suite");
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

describe("Wordmark", () => {
  it("shows the mark and the name", () => {
    mount(<Wordmark />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.textContent).toContain("Restow");
  });

  it("can show the mark alone while the name stays readable for screen readers", () => {
    mount(<Wordmark compact />);
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector(".sr-only")?.textContent).toContain("Restow");
  });
});
