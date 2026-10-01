import type { LinkProps } from "@tanstack/react-router";

/**
 * Paths of the integrations pages. Feature routes are registered at runtime,
 * so the static route typing cannot know them (same approach as the sidebar).
 */
export const INTEGRATIONS_PATH = "/integrations";
export const WEBHOOK_DETAIL_PATH = `${INTEGRATIONS_PATH}/webhooks/$webhookId` as const;

export function integrationsTo(): LinkProps["to"] {
  return INTEGRATIONS_PATH as LinkProps["to"];
}

export function webhookDetailTo(webhookId: string): LinkProps["to"] {
  return `${INTEGRATIONS_PATH}/webhooks/${encodeURIComponent(webhookId)}` as LinkProps["to"];
}
