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

  it("holds in Nile and Limestone, the bar in Lapis and its dark step", () => {
    mount(<RestowMark />);
    const hold = container.querySelector("path")?.getAttribute("class") ?? "";
    const bar = container.querySelector("rect")?.getAttribute("class") ?? "";
    expect(hold).toContain("stroke-[#0F1B2D]");
    expect(hold).toContain("dark:stroke-[#F4F5F7]");
    expect(bar).toContain("fill-[#2B4C9B]");
    expect(bar).toContain("dark:fill-[#9DB4E6]");
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
  });
});

describe("BrandName", () => {
  it("sets the default name as the wordmark, lowercase, and keeps the plain name for screen readers", () => {
    mount(<BrandName />);
    const visible = container.querySelector('[aria-hidden="true"]');
    expect(visible?.textContent).toBe("restowbackup");
    expect(container.querySelector(".sr-only")?.textContent).toBe("Restow");
    const parts = [...(visible?.querySelectorAll("span") ?? [])].map((part) => part.textContent);
    expect(parts).toEqual(["restow", "backup"]);
  });

  it("shows an operator's own product name as written, without the wordmark styling", () => {
    applyProductName("Acme Backup");
    mount(<BrandName />);
    expect(container.textContent).toBe("Acme Backup");
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
