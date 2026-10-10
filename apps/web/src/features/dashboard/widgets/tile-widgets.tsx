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

/** The VMs and containers of the tile; zeros from a server that does not count them yet. */
export function guestsOf(data: ObjectsData): NonNullable<ObjectsData["guests"]> {
  return data.guests ?? { protected: 0, withoutJob: 0, failedLastBackup: 0, restorePoints: 0 };
}

/** The file shares of the tile; zeros from a server that does not count them yet. */
export function sharesOf(data: ObjectsData): NonNullable<ObjectsData["fileShares"]> {
  return (
    data.fileShares ?? {
      protected: 0,
      withoutJob: 0,
      failedLastBackup: 0,
      warnings: 0,
      restorePoints: 0,
    }
  );
}

/**
 * "No errors in the latest runs" only when there were runs to judge: nothing failed, nothing left
 * items behind, everything protected has a backup and no machine, guest or share is left
 * without a job.
 */
export function protectedHealthy(data: ObjectsData): boolean {
  const guests = guestsOf(data);
  const shares = sharesOf(data);
  return (
    data.failed === 0 &&
    data.withItemFailures === 0 &&
    data.machines.failedLastBackup === 0 &&
    data.machines.withoutJob === 0 &&
    guests.failedLastBackup === 0 &&
    guests.withoutJob === 0 &&
    shares.failedLastBackup === 0 &&
    shares.withoutJob === 0 &&
    shares.warnings === 0 &&
    data.noBackup === 0
  );
}

/**
 * Whether the tenant has nothing to show: no protected object, and no machine, no guest and no
 * file share, in a job or not. Only then does the tile say "nothing protected yet".
 */
export function nothingProtected(data: ObjectsData): boolean {
  const guests = guestsOf(data);
  const shares = sharesOf(data);
  return (
    data.active +
      data.machines.protected +
      data.machines.withoutJob +
      guests.protected +
      guests.withoutJob +
      shares.protected +
      shares.withoutJob ===
    0
  );
}

function useLanguage(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage ?? i18n.language;
}

// ---------------------------------------------------------------------------
// Protected objects
// ---------------------------------------------------------------------------

/**
 * Objects under protection and how their latest runs ended, servers and
 * clients in a backup job included. Runs that left items behind are counted
 * apart from failed runs, never as successes; "no errors" is said only when
 * everything protected has at least one backup and nothing failed.
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
        nothingProtected(data)
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
      {(data) => {
        const guests = guestsOf(data);
        const shares = sharesOf(data);
        const failed =
          data.failed +
          data.machines.failedLastBackup +
          guests.failedLastBackup +
          shares.failedLastBackup;
        return (
          <KpiTile
            label={t("protectedObjects.title")}
            icon={ShieldCheck}
            value={formatInteger(
              data.active + data.machines.protected + guests.protected + shares.protected,
              language,
            )}
            hint={
              <span className="flex flex-wrap gap-1.5">
                {data.machines.protected > 0 ? (
                  <span className="w-full text-xs text-muted-foreground" data-line="machines">
                    {t("protectedObjects.withMachines", { count: data.machines.protected })}
                  </span>
                ) : null}
                {guests.protected > 0 ? (
                  <span className="w-full text-xs text-muted-foreground" data-line="guests">
                    {t("protectedObjects.withGuests", { count: guests.protected })}
                  </span>
                ) : null}
                {shares.protected > 0 ? (
                  <span className="w-full text-xs text-muted-foreground" data-line="shares">
                    {t("protectedObjects.withShares", { count: shares.protected })}
                  </span>
                ) : null}
                {protectedHealthy(data) ? (
                  <StatusBadge tone="neutral">{t("protectedObjects.healthy")}</StatusBadge>
                ) : null}
                {failed > 0 ? (
                  <StatusBadge tone="destructive">
                    {t("protectedObjects.failed", { count: failed })}
                  </StatusBadge>
                ) : null}
                {data.noBackup > 0 ? (
                  <StatusBadge tone="warning">
                    {t("protectedObjects.noBackup", { count: data.noBackup })}
                  </StatusBadge>
                ) : null}
                {data.machines.withoutJob > 0 ? (
                  <StatusBadge tone="warning">
                    {t("protectedObjects.withoutJob", { count: data.machines.withoutJob })}
                  </StatusBadge>
                ) : null}
                {guests.withoutJob > 0 ? (
                  <StatusBadge tone="warning">
                    {t("protectedObjects.guestsWithoutJob", { count: guests.withoutJob })}
                  </StatusBadge>
                ) : null}
                {shares.withoutJob > 0 ? (
                  <StatusBadge tone="warning">
                    {t("protectedObjects.sharesWithoutJob", { count: shares.withoutJob })}
                  </StatusBadge>
                ) : null}
                {shares.warnings > 0 ? (
                  <StatusBadge tone="warning">
                    {t("protectedObjects.sharesWithWarnings", { count: shares.warnings })}
                  </StatusBadge>
                ) : null}
                {data.withItemFailures > 0 ? (
                  <StatusBadge tone="warning">
                    {t("protectedObjects.withItemFailures", { count: data.withItemFailures })}
                  </StatusBadge>
                ) : null}
                {(data.acknowledgedWarnings ?? 0) > 0 ? (
                  <StatusBadge tone="muted">
                    {t("protectedObjects.acknowledged", { count: data.acknowledgedWarnings ?? 0 })}
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
                <span className="flex flex-wrap gap-x-3">
                  {/* A warning badge always leads to its reasons (features/warnings). */}
                  {data.withItemFailures > 0 ||
                  (data.acknowledgedWarnings ?? 0) > 0 ||
                  shares.warnings > 0 ? (
                    <LinkButton to={to(PATHS.warnings)} variant="link" size="xs" className="px-0">
                      {t("protectedObjects.warningsLink")}
                    </LinkButton>
                  ) : null}
                  <LinkButton
                    to={to(PATHS.protectedObjects)}
                    variant="link"
                    size="xs"
                    className="px-0"
                  >
                    {t("protectedObjects.link")}
                  </LinkButton>
                </span>
              ) : undefined
            }
          />
        );
      }}
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
