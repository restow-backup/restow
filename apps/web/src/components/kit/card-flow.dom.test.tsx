// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { CARD_FLOW_CLASS, CardFlow, type CardFlowLayout, cardFlowClass } from "./card-flow.js";

/**
 * The layout rules of the card flow (kit/card-flow.tsx): no card is stretched to its
 * neighbour's height, an odd card at the end takes the whole row, cards of different height fill
 * their columns from the top, a card with nothing to show leaves no cell, and key-figure tiles stay
 * a regular grid. happy-dom does not lay out, so the tests check the rules the browser applies:
 * the classes and which cards their selectors pick. The screenshots of the overview, statistics
 * and provider pages check the result in a browser.
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

function Card({ id }: { id: string }) {
  return <div data-card={id}>{id}</div>;
}

/** A card that has nothing to show, as a chart without data. */
function Nothing() {
  return null;
}

function mount(node: React.ReactNode): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  const flow = host.querySelector<HTMLElement>('[data-slot="card-flow"]');
  if (!flow) {
    throw new Error("no card flow");
  }
  return flow;
}

const cards = (flow: HTMLElement) =>
  [...flow.children].map((child) => child.getAttribute("data-card"));

/** The card the "an odd card at the end takes the whole row" rule picks, if any. */
const spanning = (flow: HTMLElement) =>
  [...flow.children]
    .filter((child) => child.matches(":last-child:nth-child(odd)"))
    .map((child) => child.getAttribute("data-card"));

const classes = (layout: CardFlowLayout, tiles?: 2 | 3 | 4) =>
  cardFlowClass(layout, tiles).split(/\s+/);

describe("CardFlow", () => {
  it("is its own container, so the column count follows its width", () => {
    const flow = mount(
      <CardFlow>
        <Card id="a" />
      </CardFlow>,
    );
    expect(flow.parentElement?.className).toBe("@container/card-flow");
    expect(flow.getAttribute("data-layout")).toBe("rows");
  });

  it("keeps every card at its own height in rows, never stretched to its neighbour", () => {
    expect(classes("rows")).toContain("items-start");
    expect(classes("rows")).toContain("grid-cols-1");
    expect(classes("rows")).toContain("@[42rem]/card-flow:grid-cols-2");
    // Cards shrink to the column, so a wide table scrolls inside its card.
    expect(classes("rows")).toContain("*:min-w-0");
    for (const layout of ["rows", "columns", "stack", "tiles"] as const) {
      expect(CARD_FLOW_CLASS[layout]).not.toMatch(/\bitems-stretch\b|\bh-full\b/);
    }
  });

  it("gives an odd last card the whole row, and leaves an even count alone", () => {
    expect(classes("rows")).toContain(
      "@[42rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-2",
    );
    const odd = mount(
      <CardFlow>
        <Card id="a" />
        <Card id="b" />
        <Card id="c" />
      </CardFlow>,
    );
    expect(spanning(odd)).toEqual(["c"]);
    act(() =>
      root?.render(
        <CardFlow>
          <Card id="a" />
          <Card id="b" />
        </CardFlow>,
      ),
    );
    expect(spanning(odd)).toEqual([]);
  });

  it("leaves no cell for a card that renders nothing, and the rest closes up", () => {
    const flow = mount(
      <CardFlow>
        <Card id="a" />
        <Nothing />
        <Card id="b" />
        <Nothing />
        <Card id="c" />
      </CardFlow>,
    );
    expect(cards(flow)).toEqual(["a", "b", "c"]);
    // The odd-last rule counts what is rendered: c takes the row, not a hole beside it.
    expect(spanning(flow)).toEqual(["c"]);
    expect(flow.children).toHaveLength(3);
  });

  it("fills two columns from the top for cards of different height, in DOM order", () => {
    const list = classes("columns");
    expect(list).toContain("@[42rem]/card-flow:columns-2");
    // A card is never split across the columns, and the last one adds no space below.
    expect(list).toContain("*:break-inside-avoid");
    expect(list).toContain("*:mb-4");
    expect(list).toContain("*:last:mb-0");
    // No grid: nothing ties a card to the height of a row.
    expect(list).not.toContain("grid");
    const flow = mount(
      <CardFlow layout="columns">
        <Card id="readiness" />
        <Card id="lastBackup" />
        <Card id="price" />
      </CardFlow>,
    );
    // The reading and keyboard order is the DOM order (down the first column, then the second).
    expect(cards(flow)).toEqual(["readiness", "lastBackup", "price"]);
  });

  it("gives a single card in columns the whole width", () => {
    expect(classes("columns")).toContain("*:only:[column-span:all]");
    const flow = mount(
      <CardFlow layout="columns">
        <Nothing />
        <Card id="a" />
      </CardFlow>,
    );
    expect(flow.children[0]?.matches(":only-child")).toBe(true);
  });

  it("stacks two cards across the whole width", () => {
    const list = classes("stack");
    expect(list).toContain("grid-cols-1");
    expect(list.some((name) => /grid-cols-[2-9]|columns-/.test(name))).toBe(false);
  });

  it("keeps key-figure tiles in a regular grid without an empty cell", () => {
    // Two columns from 26rem, with an odd last tile across the row while there are two.
    expect(classes("tiles", 2)).toEqual(
      expect.arrayContaining([
        "@[26rem]/card-flow:grid-cols-2",
        "@[26rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-2",
      ]),
    );
    expect(classes("tiles", 2).some((name) => name.includes("grid-cols-3"))).toBe(false);
    // Three (or four) a row on a wide page, where the odd-last rule no longer applies.
    expect(classes("tiles", 3)).toEqual(
      expect.arrayContaining([
        "@[48rem]/card-flow:grid-cols-3",
        "@[48rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-1",
      ]),
    );
    expect(classes("tiles", 4)).toEqual(
      expect.arrayContaining([
        "@[56rem]/card-flow:grid-cols-4",
        "@[56rem]/card-flow:[&>:last-child:nth-child(odd)]:col-span-1",
      ]),
    );
    // Tiles hold the same parts and may share a row's height; no items-start there.
    expect(classes("tiles")).not.toContain("items-start");
  });

  it("renders the element asked for and passes data attributes through", () => {
    const flow = mount(
      <CardFlow as="section" layout="stack" data-section="status" aria-label="Status">
        <Card id="a" />
      </CardFlow>,
    );
    expect(flow.tagName).toBe("SECTION");
    expect(flow.getAttribute("data-section")).toBe("status");
    expect(flow.getAttribute("aria-label")).toBe("Status");
    expect(flow.getAttribute("data-layout")).toBe("stack");
  });
});
