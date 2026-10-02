import { type AnyRoute, createRoute } from "@tanstack/react-router";
import { createElement } from "react";

import { appLayoutRoute } from "@/routes/tree";

import { RESOURCES_PATH, resourcesSoonItem, soonNavItems } from "./items";
import { SoonPage } from "./soon-page";

export { SoonPage } from "./soon-page";
export { RESOURCES_PATH, SOON_CONTENT, soonNavItems } from "./items";

/**
 * Pages of features that come with a later release (items.ts): capacity
 * planning (`/resources`, 0.5.0). The job definitions left this list with
 * 0.2.0 (features/backup-jobs).
 */
export function createSoonRoutes(getParentRoute: () => AnyRoute): AnyRoute[] {
  const parent = getParentRoute as () => typeof appLayoutRoute;
  const resources = createRoute({
    getParentRoute: parent,
    path: RESOURCES_PATH,
    component: () => createElement(SoonPage, { item: resourcesSoonItem() }),
  });
  return [resources];
}

export const routes: AnyRoute[] = createSoonRoutes(() => appLayoutRoute);

export const navItems = soonNavItems;
