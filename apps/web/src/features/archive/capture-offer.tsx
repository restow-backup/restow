import { Link } from "@tanstack/react-router";
import { Sparkles, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { jobDefinitionTo, linkProps } from "@/features/backup-jobs/paths";
import { useSession } from "@/lib/session";

import type { CaptureJobChoice } from "./api.js";
import { useCaptureStatus } from "./hooks.js";

/** The most jobs the notice names; the rest are counted. */
const SHOWN_JOBS = 5;

/** Where the notice remembers that it was put away, per tenant (this browser only). */
export function captureOfferDismissedKey(tenantId: string): string {
  return `restow.archive.captureOffer.dismissed.${tenantId}`;
}

function readDismissed(tenantId: string | null): boolean {
  if (!tenantId) {
    return false;
  }
  try {
    return window.localStorage.getItem(captureOfferDismissedKey(tenantId)) === "1";
  } catch {
    return false;
  }
}

/** What a job could switch on, one line each. */
function choiceLines(job: CaptureJobChoice, t: (key: string) => string): string[] {
  return [
    ...(job.graphOff ? [t("capture.offer.graphOff")] : []),
    ...job.pending.map((kind) => t(`capture.offer.pending.${kind}`)),
  ];
}

/**
 * The 0.4.4 news on the archive page (docs/ARCHIVE.md "Erfassungswege"): mail can now be
 * captured from the mailboxes by Microsoft Graph and IMAP. Names the jobs where a way could be
 * switched on (Graph off for their Microsoft 365 mailboxes, or IMAP and Google accounts that
 * wait for a way since the update), each with a link to the job. Only where the edition has
 * the mailbox ways (`archive.mailboxCapture`); the page itself is for administrators. It can
 * be put away (remembered per tenant in this browser).
 */
export function CaptureOfferNotice() {
  const { t } = useTranslation("archive");
  const session = useSession();
  const tenantId = session.activeTenant?.id ?? null;
  const available = session.features?.includes("archive.mailboxCapture") ?? false;
  const status = useCaptureStatus();
  const [dismissed, setDismissed] = React.useState(() => readDismissed(tenantId));
  React.useEffect(() => setDismissed(readDismissed(tenantId)), [tenantId]);
  const jobs = status.data?.jobs ?? [];
  if (!available || dismissed || jobs.length === 0) {
    return null;
  }
  const more = jobs.length - SHOWN_JOBS;
  return (
    <Alert data-slot="archive-capture-offer" className="pr-12">
      <Sparkles aria-hidden="true" />
      <AlertTitle>{t("capture.offer.title")}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{t("capture.offer.description")}</p>
        <ul className="space-y-1">
          {jobs.slice(0, SHOWN_JOBS).map((job) => (
            <li key={job.jobId} className="flex flex-wrap items-baseline gap-x-2">
              <Link
                {...linkProps(jobDefinitionTo(job.jobId, "mail", "settings"))}
                className="font-medium text-primary underline underline-offset-4 hover:no-underline"
                aria-label={`${t("capture.offer.open")}: ${job.name}`}
              >
                {job.name}
              </Link>
              <span className="text-muted-foreground text-xs">
                {choiceLines(job, t).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
        {more > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t("capture.offer.more", { count: more })}
          </p>
        ) : null}
      </AlertDescription>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="absolute top-2 right-2"
        aria-label={t("capture.offer.dismiss")}
        onClick={() => {
          try {
            if (tenantId) {
              window.localStorage.setItem(captureOfferDismissedKey(tenantId), "1");
            }
          } catch {
            // Not remembered: it comes back on the next visit.
          }
          setDismissed(true);
        }}
      >
        <X aria-hidden="true" />
      </Button>
    </Alert>
  );
}

/**
 * In the capture section: the jobs whose IMAP or Google accounts wait for a way since the
 * update to 0.4.4 (nothing is captured from those accounts until one is chosen in the job).
 */
export function CaptureWaitingJobs({ jobs }: { jobs: readonly CaptureJobChoice[] }) {
  const { t } = useTranslation("archive");
  const waiting = jobs.filter((job) => job.pending.length > 0);
  if (waiting.length === 0) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-md border p-3" data-slot="capture-waiting-jobs">
      <div className="space-y-0.5">
        <p className="font-medium text-sm">{t("capture.waiting.title")}</p>
        <p className="text-muted-foreground text-xs">{t("capture.waiting.description")}</p>
      </div>
      <ul className="space-y-1 text-sm">
        {waiting.map((job) => (
          <li key={job.jobId} className="flex flex-wrap items-baseline gap-x-2">
            <Link
              {...linkProps(jobDefinitionTo(job.jobId, "mail", "settings"))}
              className="font-medium text-primary underline underline-offset-4 hover:no-underline"
            >
              {job.name}
            </Link>
            <span className="text-muted-foreground text-xs">
              {job.pending.map((kind) => t(`capture.offer.pending.${kind}`)).join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
