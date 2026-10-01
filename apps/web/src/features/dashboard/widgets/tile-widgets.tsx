import { HardDrive, Inbox, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { KpiTile, StatusBadge } from "@/components/kit";
import { formatBytes, formatInteger, formatPercent } from "@/lib/format";

import type {
  MailboxUsageWidget as MailboxData,
  ProtectedObjectsWidget as ObjectsData,
  StorageWidget as StorageData,
} from "../api.js";
import { LinkButton } from "../components/link-button.js";
import { TileWidget, type WidgetStateProps } from "../components/widget-frame.js";
import { PATHS, to } from "../paths.js";
import { dedupSaving } from "../presenters.js";

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

// ---------------------------------------------------------------------------
// Protected objects
// ---------------------------------------------------------------------------

/**
 * Objects under protection and how their latest runs ended. Runs that left
 * items behind are counted apart from failed runs, never as successes.
 */
export function ProtectedObjectsWidget({
  canAdminister,
  ...props
}: WidgetStateProps<ObjectsData> & { canAdminister: boolean }) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  return (
    <TileWidget
      id="protectedObjects"
      {...props}
      label={t("protectedObjects.title")}
      icon={ShieldCheck}
      empty={(data) =>
        data.active === 0
          ? {
              icon: ShieldCheck,
              title: t("protectedObjects.empty.title"),
              description: t("protectedObjects.empty.description"),
              action: canAdminister ? (
                <LinkButton to={to(PATHS.protectedObjects)}>
                  {t("protectedObjects.empty.action")}
                </LinkButton>
              ) : undefined,
            }
          : null
      }
    >
      {(data) => (
        <KpiTile
          label={t("protectedObjects.title")}
          icon={ShieldCheck}
          value={formatInteger(data.active, language)}
          hint={
            <span className="flex flex-wrap gap-1.5">
              {data.failed === 0 && data.withItemFailures === 0 ? (
                <StatusBadge tone="neutral">{t("protectedObjects.healthy")}</StatusBadge>
              ) : null}
              {data.failed > 0 ? (
                <StatusBadge tone="destructive">
                  {t("protectedObjects.failed", { count: data.failed })}
                </StatusBadge>
              ) : null}
              {data.withItemFailures > 0 ? (
                <StatusBadge tone="warning">
                  {t("protectedObjects.withItemFailures", { count: data.withItemFailures })}
                </StatusBadge>
              ) : null}
              {data.runningBackups > 0 ? (
                <StatusBadge tone="info" live>
                  {t("protectedObjects.running", { count: data.runningBackups })}
                </StatusBadge>
              ) : null}
            </span>
          }
          link={
            canAdminister ? (
              <LinkButton to={to(PATHS.protectedObjects)} variant="link" size="xs" className="px-0">
                {t("protectedObjects.link")}
              </LinkButton>
            ) : undefined
          }
        />
      )}
    </TileWidget>
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function StorageTargetBadge({ target }: { target: StorageData["target"] }) {
  const { t } = useTranslation("dashboard");
  switch (target.status) {
    case "ok":
      return null;
    case "unverified":
      return (
        <StatusBadge tone="warning" icon>
          {t("storage.target.unverified")}
        </StatusBadge>
      );
    case "error":
      return (
        <StatusBadge tone="destructive" icon>
          {t("storage.target.error")}
        </StatusBadge>
      );
    case "misconfigured":
      return (
        <StatusBadge tone="destructive" icon>
          {t("storage.target.misconfigured")}
        </StatusBadge>
      );
  }
}

/** Bytes in the chunk store after deduplication, and whether the target answers. */
export function StorageWidget({
  canAdminister,
  ...props
}: WidgetStateProps<StorageData> & { canAdminister: boolean }) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  return (
    <TileWidget
      id="storage"
      {...props}
      label={t("storage.title")}
      icon={HardDrive}
      empty={(data) =>
        data.logicalBytes === 0 && data.physicalBytes === 0 && data.target.status === "ok"
          ? {
              icon: HardDrive,
              title: t("storage.empty.title"),
              description: t("storage.empty.description"),
            }
          : null
      }
    >
      {(data) => (
        <KpiTile
          label={t("storage.title")}
          icon={HardDrive}
          value={formatBytes(data.physicalBytes, language)}
          hint={
            <span className="flex flex-col gap-1.5">
              <span>
                {t("storage.logical", { bytes: formatBytes(data.logicalBytes, language) })}
                {data.logicalBytes > 0
                  ? ` · ${t("storage.saved", {
                      share: formatPercent(
                        dedupSaving(data.logicalBytes, data.physicalBytes),
                        language,
                      ),
                    })}`
                  : null}
              </span>
              <StorageTargetBadge target={data.target} />
            </span>
          }
          link={
            canAdminister ? (
              <LinkButton to={to(PATHS.storage)} variant="link" size="xs" className="px-0">
                {t("storage.link")}
              </LinkButton>
            ) : undefined
          }
        />
      )}
    </TileWidget>
  );
}

// ---------------------------------------------------------------------------
// Mailbox usage
// ---------------------------------------------------------------------------

/**
 * Protected mailboxes: the installation's for a provider admin (with a link
 * to the tenant list, which breaks them down per tenant), the tenant's own
 * for everyone else, with the cap the provider agreed for the tenant when one
 * is set. Nothing limits the number; there is no allowance to measure against.
 */
export function MailboxUsageWidget({
  isProviderAdmin,
  ...props
}: WidgetStateProps<MailboxData> & { isProviderAdmin: boolean }) {
  const { t } = useTranslation("dashboard");
  const language = useLanguage();
  return (
    <TileWidget
      id="mailboxUsage"
      {...props}
      label={t("mailboxUsage.title")}
      icon={Inbox}
      empty={(data) =>
        data.used === 0
          ? {
              icon: Inbox,
              title: t("mailboxUsage.empty.title"),
              description: t("mailboxUsage.empty.description"),
            }
          : null
      }
    >
      {(data) => (
        <KpiTile
          label={t(data.scope === "tenant" ? "mailboxUsage.tenantTitle" : "mailboxUsage.title")}
          icon={Inbox}
          value={formatInteger(data.used, language)}
          hint={
            data.scope === "tenant" && data.tenant.cap !== null ? (
              <span>
                {t("mailboxUsage.cap", { cap: formatInteger(data.tenant.cap, language) })}
              </span>
            ) : undefined
          }
          link={
            isProviderAdmin && data.scope === "installation" ? (
              <LinkButton to={to(PATHS.tenants)} variant="link" size="xs" className="px-0">
                {t("mailboxUsage.link")}
              </LinkButton>
            ) : undefined
          }
        />
      )}
    </TileWidget>
  );
}
