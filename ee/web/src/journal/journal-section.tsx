import {
  ChevronDown,
  CircleCheck,
  ExternalLink,
  Info,
  Mail,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog, CopyButton, RelativeTime, StatusBadge } from "@/components/kit";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import "@/features/archive/i18n";
import { errorMessageKey } from "@/lib/api";

import type { JournalSetup } from "./api";
import { useJournalScope, useJournalSetup, useRotateJournalAddress } from "./hooks";
import {
  type ChecklistState,
  GUIDE_STEPS,
  STATUS_TONE,
  checklistItems,
  guideOpenByDefault,
  isNotSetUp,
} from "./presenters";

const CHECKLIST_ICON = {
  ok: { Icon: CircleCheck, className: "text-foreground" },
  warn: { Icon: TriangleAlert, className: "text-warning-text" },
  todo: { Icon: Info, className: "text-muted-foreground" },
} as const satisfies Record<ChecklistState, unknown>;

/**
 * Exchange journaling on the archive page (slot `archive.sections`): the
 * tenant's journal address with a copy button, whether reports are arriving,
 * what this installation must provide for Exchange Online and a step-by-step
 * guide for the connector and the journal rule (docs/ARCHIVE.md). Rotating the
 * address asks first, because the old one stops working at once. Rendered only
 * for a tenant administrator on an edition with the journal receiver; the
 * archive page itself handles every other access state.
 *
 * An installation that does not use journaling (`JOURNAL_SMTP_PORT` unset) is
 * not broken: it shows a neutral "not set up" state with one sentence on what
 * is needed and the guide folded away. Red and amber are kept for a receiver
 * that is configured and has a problem.
 */
export function JournalSection() {
  const { t } = useTranslation("archive");
  const { enabled, canManage, licensed } = useJournalScope();
  const setup = useJournalSetup();

  if (!enabled || !canManage || !licensed) {
    return null;
  }

  return (
    <section className="space-y-4 rounded-md border p-4" aria-labelledby="journal-title">
      <div className="space-y-1">
        <h3 id="journal-title" className="flex items-center gap-2 font-medium">
          <Mail aria-hidden="true" className="size-4" />
          {t("journal.title")}
        </h3>
        <p className="text-muted-foreground text-sm">{t("journal.description")}</p>
      </div>

      {setup.data ? (
        <JournalSetupView setup={setup.data} />
      ) : setup.isError ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            {t(`common:${errorMessageKey(setup.error)}`)}
            <Button variant="outline" size="sm" onClick={() => void setup.refetch()}>
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}
    </section>
  );
}

function JournalSetupView({ setup }: { setup: JournalSetup }) {
  const { t } = useTranslation("archive");
  const rotate = useRotateJournalAddress();
  const hostLabel = setup.hostname ?? t("journal.guide.hostFallback");
  const notSetUp = isNotSetUp(setup.status);

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <StatusBadge tone={STATUS_TONE[setup.status]} icon live={setup.status === "receiving"}>
          {t(`journal.status.${setup.status}`)}
        </StatusBadge>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">{t("journal.lastReport")}</dt>
            <dd>
              {setup.lastReportAt ? (
                <RelativeTime value={setup.lastReportAt} />
              ) : (
                t("journal.noReportYet")
              )}
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">{t("journal.counts.last24Hours")}</dt>
            <dd>{t("journal.counts.value", { count: setup.counts.last24Hours })}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-muted-foreground">{t("journal.counts.last7Days")}</dt>
            <dd>{t("journal.counts.value", { count: setup.counts.last7Days })}</dd>
          </div>
        </dl>
      </div>

      {notSetUp ? (
        <p className="text-muted-foreground flex gap-2 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{t("journal.notConfigured")}</span>
        </p>
      ) : setup.receiver.reason ? (
        <Alert variant="destructive">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{t(`journal.reason.${setup.receiver.reason}`)}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <p id="journal-address-label" className="text-sm font-medium">
          {setup.address ? t("journal.address.label") : t("journal.address.soFar")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code
            id="journal-address"
            aria-labelledby="journal-address-label"
            className="bg-muted/40 min-w-0 flex-1 basis-full select-all break-all rounded-md border px-3 py-2 font-mono text-xs sm:basis-0"
          >
            {setup.address ?? `${setup.localPart}@`}
          </code>
          {setup.address ? (
            <CopyButton value={setup.address} label={t("journal.address.copy")} variant="outline" />
          ) : null}
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                <RotateCw aria-hidden="true" />
                {t("journal.rotate.action")}
              </Button>
            }
            title={t("journal.rotate.title")}
            description={
              <>
                <p>{t("journal.rotate.description")}</p>
                <p>{t("journal.rotate.consequence")}</p>
              </>
            }
            confirmLabel={t("journal.rotate.confirm")}
            destructive
            onConfirm={() =>
              rotate.mutateAsync().then(() => {
                toast.success(t("journal.rotate.done"));
              })
            }
          />
        </div>
        {setup.hostnameIssue && !notSetUp ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              {t(
                setup.hostnameIssue === "missing"
                  ? "journal.address.hostMissing"
                  : "journal.address.hostInvalid",
              )}
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <Collapsible defaultOpen={guideOpenByDefault(setup.status)} className="space-y-3">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2 group">
            <ChevronDown
              aria-hidden="true"
              className="transition-transform group-data-[state=closed]:-rotate-90"
            />
            {t("journal.setup.title")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4">
          <div className="space-y-2">
            <h4 className="text-sm font-medium">{t("journal.checklist.title")}</h4>
            <ul className="space-y-1.5 text-sm">
              {checklistItems(setup).map((item) => {
                const { Icon, className } = CHECKLIST_ICON[item.state];
                return (
                  <li key={item.id} className="flex gap-2" data-state={item.state}>
                    <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${className}`} />
                    <span>{t(`journal.checklist.${item.key}`, item.params)}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="space-y-3">
            <h4 className="text-sm font-medium">{t("journal.guide.title")}</h4>
            <p className="text-muted-foreground text-sm">{t("journal.guide.intro")}</p>
            <ol className="space-y-3 text-sm">
              {GUIDE_STEPS.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span
                    aria-hidden="true"
                    className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium"
                  >
                    {index + 1}
                  </span>
                  <div className="space-y-0.5">
                    <p className="font-medium">{t(`journal.guide.${step}.title`)}</p>
                    <p className="text-muted-foreground">
                      {t(`journal.guide.${step}.body`, { host: hostLabel })}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            {setup.docsUrl ? (
              <Button variant="link" size="sm" className="-ml-2" asChild>
                <a href={setup.docsUrl} target="_blank" rel="noreferrer noopener">
                  {t("journal.guide.docs")}
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
