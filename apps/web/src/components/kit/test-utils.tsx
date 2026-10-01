import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";

import { i18n } from "@/i18n";

import "./i18n.js";

/**
 * Static markup is enough for the kit's contracts (states, attributes,
 * texts); no DOM is needed. Effects do not run, so logic that lives in
 * effects is covered by the pure helpers each module exports.
 */
export function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

/** Number of occurrences of `needle` in `html`. */
export function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}
