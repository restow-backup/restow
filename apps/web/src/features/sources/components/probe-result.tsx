import { Lock, LockOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { formatDateTime, formatRelative } from "@/lib/format";
import type { ImapProbeResult } from "../types";
import { ToneLine } from "./status";

/**
 * What a connection test found: on success the transport, server and what it
 * offers; on failure the classified reason plus the server's own words.
 */
export function ProbeResult({
  probe,
  compact = false,
}: { probe: ImapProbeResult; compact?: boolean }) {
  const { t, i18n } = useTranslation("sources");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const testedAt = formatRelative(probe.checkedAt, language);

  if (!probe.ok) {
    return (
      <div className="space-y-2">
        <ToneLine tone="destructive">
          <span className="font-medium">{t("imap.probe.failed")}</span>
          {": "}
          {t(`imap.probe.reasons.${probe.reason}`)}
        </ToneLine>
        {/* A refused address never reached a server, so there are no server words to show. */}
        {probe.message && probe.reason !== "blocked_address" ? (
          <p className="break-words pl-5.5 font-mono text-xs text-muted-foreground">
            {t("imap.probe.detail", { message: probe.message })}
            {probe.code ? ` (${probe.code})` : null}
          </p>
        ) : null}
        {!compact && testedAt ? (
          <p
            className="pl-5.5 text-xs text-muted-foreground"
            title={formatDateTime(probe.checkedAt, language) ?? undefined}
          >
            {t("imap.probe.testedAt", { when: testedAt })}
          </p>
        ) : null}
      </div>
    );
  }

  const serverName = [probe.server?.name, probe.server?.version].filter(Boolean).join(" ");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToneLine tone="ok" className="font-medium">
          {t("imap.probe.ok")}
        </ToneLine>
        <Badge variant={probe.secure ? "outline" : "warning"}>
          {probe.secure ? <Lock aria-hidden="true" /> : <LockOpen aria-hidden="true" />}
          {probe.secure ? t("imap.probe.secure") : t("imap.probe.insecure")}
        </Badge>
        <Badge variant="muted">{t("imap.probe.mailboxes", { count: probe.mailboxes })}</Badge>
      </div>
      {serverName ? (
        <p className="text-xs text-muted-foreground">
          {t("imap.probe.server", { name: serverName })}
        </p>
      ) : null}
      {!compact && probe.specialUse.length > 0 ? (
        <BadgeRow label={t("imap.probe.specialUse")} values={probe.specialUse} />
      ) : null}
      {!compact && probe.capabilities.length > 0 ? (
        <BadgeRow label={t("imap.probe.capabilities")} values={probe.capabilities} />
      ) : null}
      {!compact && testedAt ? (
        <p
          className="text-xs text-muted-foreground"
          title={formatDateTime(probe.checkedAt, language) ?? undefined}
        >
          {t("imap.probe.testedAt", { when: testedAt })}
        </p>
      ) : null}
    </div>
  );
}

function BadgeRow({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <Badge key={value} variant="outline" className="font-mono">
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}
