import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CauseLine } from "@/features/failures";
import { formatDateTime, formatRelative } from "@/lib/format";
import { sourceDetailTo } from "../paths";
import { sourceCause, summarizeSource } from "../presenters";
import type { SourceDto } from "../types";
import { SourceKindIcon, SourceStatusBadge, ToneLine } from "./status";

/** The line under the name: which tenant or account the source points at. */
function sourceSubtitle(source: SourceDto): string | null {
  if (source.kind === "m365") {
    return source.m365?.entraTenantHint ?? source.m365?.entraTenantId ?? null;
  }
  return source.imap ? `${source.imap.username} · ${source.imap.host}` : null;
}

/** A source in the list: what it is, its status, and what it needs next. */
export function SourceCard({ source }: { source: SourceDto }) {
  const { t, i18n } = useTranslation("sources");
  const language = i18n.resolvedLanguage ?? i18n.language;
  // An import source has no connection: it only holds imported mailboxes.
  const imported = source.kind === "import";
  const summary = imported ? null : summarizeSource(source);
  const cause = sourceCause(source);
  const lastSync = formatRelative(source.lastSyncAt, language);

  return (
    <Link
      to={sourceDetailTo(source.id)}
      className="group block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Card className="h-full gap-3 transition-colors group-hover:border-foreground/20 group-hover:bg-muted/30">
        <CardHeader className="flex flex-row items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <SourceKindIcon kind={source.kind} className="size-4" />
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <CardTitle className="truncate text-base">{source.name}</CardTitle>
            <CardDescription className="truncate text-xs">
              {sourceSubtitle(source) ?? t(`kindLong.${source.kind}`)}
            </CardDescription>
          </div>
          {imported ? null : <SourceStatusBadge status={source.status} />}
        </CardHeader>
        <CardContent className="space-y-2">
          {summary ? (
            <ToneLine tone={summary.tone}>{t(summary.key, summary.values)}</ToneLine>
          ) : (
            <p className="text-sm">
              {t("list.importedMailboxes", { count: source.importedMailboxes ?? 0 })}
            </p>
          )}
          {/* The cause of a broken connection or sync in one line; the detail page explains it fully. */}
          {cause ? <CauseLine failure={cause} className="block pl-5.5" /> : null}
          {/* Only Microsoft 365 has a directory sync; an IMAP source has nothing to show here. */}
          {source.kind === "m365" ? (
            <p
              className="text-xs text-muted-foreground"
              title={
                lastSync
                  ? (formatDateTime(source.lastSyncAt, language) ?? undefined)
                  : t("list.neverSyncedHint")
              }
            >
              {lastSync ? t("list.lastSync", { when: lastSync }) : t("list.neverSynced")}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
}
