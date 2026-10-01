import { createRoute } from "@tanstack/react-router";
import { Webhook } from "lucide-react";
import { createElement } from "react";

import type { NavItem } from "@/lib/navigation";
import { appLayoutRoute } from "@/routes/tree";

import "./i18n";
import { IntegrationsPage } from "./integrations-page";
import { INTEGRATIONS_PATH, WEBHOOK_DETAIL_PATH } from "./paths";
import { INTEGRATIONS_ROLES, parseIntegrationsSearch } from "./presenters";
import { WebhookDetailPage } from "./webhooks/webhook-detail-page";

/**
 * Integrations feature: API keys with scopes (tenant keys, and provider keys
 * where the installation offers them) and webhooks with signed deliveries, retries
 * and a delivery log, for RMM, PSA and ticket systems.
 */

export const integrationsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: INTEGRATIONS_PATH,
  validateSearch: (search: Record<string, unknown>) => parseIntegrationsSearch(search),
  component: IntegrationsPage,
});

export const webhookDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: WEBHOOK_DETAIL_PATH,
  component: function WebhookDetailRoute() {
    const { webhookId } = webhookDetailRoute.useParams();
    return createElement(WebhookDetailPage, { webhookId });
  },
});

export const routes = [integrationsRoute, webhookDetailRoute];

export const navItems: NavItem[] = [
  {
    id: "integrations",
    path: INTEGRATIONS_PATH,
    labelKey: "integrations:nav",
    icon: Webhook,
    roles: [...INTEGRATIONS_ROLES],
    group: "admin",
    order: 50,
  },
];
