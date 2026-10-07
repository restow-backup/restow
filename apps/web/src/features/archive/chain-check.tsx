import { CircleAlert, CircleCheck, Link as LinkIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { ErrorState } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { formatDateTime, formatInteger } from "@/lib/format";

import { CONTENT_SAMPLE, type ChainVerification } from "./api.js";
import { useVerifyChain } from "./hooks.js";
import { chainVerdictOf } from "./presenters.js";

/** A sealed anchor's UTC day (`YYYY-MM-DD`) as a date in the UI language. */
function formatDay(day: string, language: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeZone: "UTC" }).format(date);
}

/**
 * "Kette prüfen" (docs/ARCHIVE.md): the links, the daily anchors and, on
 * request, a sample of the stored messages. Each part says what it covered,
 * so a passed check never claims more than was looked at; a break names the
 * entry (1-based position, subject, date) and opens it.
 */
export function ChainCheck({ onOpenItem }: { onOpenItem: (itemId: string) => void }) {
  const { t } = useTranslation("archive");
  const verifyChain = useVerifyChain();

  return (
    <section className="space-y-3 rounded-md border p-4" data-slot="archive-chain">
      <h3 className="flex items-center gap-2 font-medium">
        <LinkIcon aria-hidden="true" className="size-4" />
        {t("chain.title")}
      </h3>
      <p className="text-muted-foreground text-sm">{t("chain.description")}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => verifyChain.mutate(0)}
          loading={verifyChain.isPending && verifyChain.variables === 0}
          disabled={verifyChain.isPending}
        >
          {t("actions.verifyChain")}
        </Button>
        <Button
          variant="outline"
          onClick={() => verifyChain.mutate(CONTENT_SAMPLE)}
          loading={verifyChain.isPending && verifyChain.variables === CONTENT_SAMPLE}
          disabled={verifyChain.isPending}
        >
          {t("chain.verifyWithContent")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t("chain.contentHint", { count: CONTENT_SAMPLE })}
      </p>
      {verifyChain.isError ? (
        <ErrorState
          title={t("chain.loadError")}
          error={verifyChain.error}
          onRetry={() => verifyChain.mutate(verifyChain.variables ?? 0)}
          retrying={verifyChain.isPending}
        />
      ) : verifyChain.data ? (
        <ChainResult result={verifyChain.data} onOpenItem={onOpenItem} />
      ) : null}
    </section>
  );
}

/** The outcome of one check, part by part (exported for tests). */
export function ChainResult({
  result,
  onOpenItem,
}: {
  result: ChainVerification;
  onOpenItem: (itemId: string) => void;
}) {
  const { t, i18n } = useTranslation("archive");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const verdict = chainVerdictOf(result);
  const date = (iso: string) => formatDateTime(iso, language) ?? iso;

  if (verdict === "empty") {
    return (
      <Alert variant="info" data-chain-verdict={verdict}>
        <CircleCheck aria-hidden="true" />
        <AlertDescription>{t("chain.empty")}</AlertDescription>
      </Alert>
    );
  }

  const ok = verdict === "ok";
  const anchors = result.anchors;
  const content = result.content;
  // Green is proof: only when the stored messages themselves were read back, not the database rows alone.
  const contentRead = (content?.checked ?? 0) > 0;
  return (
    <Alert
      variant={ok ? (contentRead ? "success" : "info") : "destructive"}
      data-chain-verdict={verdict}
    >
      {ok ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <AlertTitle>{t(ok ? "chain.passed" : "chain.failed")}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc space-y-1.5 pl-4">
          <li data-chain-part="links">
            {result.brokenAt ? (
              <>
                {t("chain.links.broken", {
                  position: formatInteger(result.brokenAt.position, language),
                  total: formatInteger(result.checked, language),
                  subject: result.brokenAt.subject ?? t("chain.noSubject"),
                  date: date(result.brokenAt.receivedAt),
                })}{" "}
                <OpenItem itemId={result.brokenAt.itemId} onOpenItem={onOpenItem} />
              </>
            ) : (
              t("chain.links.ok", { count: result.checked })
            )}
          </li>
          {anchors ? (
            <li data-chain-part="anchors">
              {anchors.failed
                ? t(`chain.anchors.${anchors.failed.reason}`, {
                    date: formatDay(anchors.failed.date, language),
                    entries: formatInteger(anchors.failed.count, language),
                  })
                : anchors.checked === 0 || !anchors.latestDate
                  ? t("chain.anchors.none")
                  : t("chain.anchors.ok", {
                      checked: anchors.checked,
                      date: formatDay(anchors.latestDate, language),
                    })}
              {anchors.checked > 0 && anchors.unsealed > 0
                ? ` ${t("chain.anchors.unsealed", { count: anchors.unsealed })}`
                : null}
            </li>
          ) : null}
          {content ? (
            <li data-chain-part="content">
              {content.requested === 0
                ? t("chain.content.skipped")
                : content.checked === 0
                  ? t("chain.content.none")
                  : content.failures.length > 0
                    ? t("chain.content.failed", {
                        failed: formatInteger(content.failures.length, language),
                        total: formatInteger(content.checked, language),
                      })
                    : t("chain.content.ok", { count: content.checked })}
              {content.notRecorded > 0
                ? ` ${t("chain.content.notRecorded", { count: content.notRecorded })}`
                : null}
              {content.failures.length > 0 ? (
                <ul className="mt-1 space-y-1">
                  {content.failures.map((failure) => (
                    <li key={failure.itemId}>
                      {t("chain.contentFailure", {
                        subject: failure.subject ?? t("chain.noSubject"),
                        date: date(failure.receivedAt),
                        problem: t(`chain.problem.${failure.problem}`),
                      })}{" "}
                      <OpenItem itemId={failure.itemId} onOpenItem={onOpenItem} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
        {result.checkedAt ? (
          <p className="mt-2 text-xs opacity-80">
            {t("chain.checkedAt", { date: date(result.checkedAt) })}
          </p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function OpenItem({
  itemId,
  onOpenItem,
}: {
  itemId: string;
  onOpenItem: (itemId: string) => void;
}) {
  const { t } = useTranslation("archive");
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      className="h-auto p-0 align-baseline"
      onClick={() => onOpenItem(itemId)}
      data-open-item={itemId}
    >
      {t("chain.openItem")}
    </Button>
  );
}
