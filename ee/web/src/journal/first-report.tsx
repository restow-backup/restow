import { Hourglass, X } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { RelativeTime, StatusBadge } from "@/components/kit";
import { Button } from "@/components/ui/button";

import type { JournalSetup } from "./api";
import { FIRST_REPORT_WAIT_MS, reportArrivedSince } from "./powershell";

/** The wait for the first journal report: when it began, and whether it ran out. */
export interface FirstReportWait {
  since: number | null;
  expired: boolean;
  start: () => void;
  stop: () => void;
}

/**
 * The state of "wait for the first report": while it runs the journal setup is asked for
 * every 5 seconds (journal-section.tsx), until a report arrived at or after the start, or
 * 30 minutes passed.
 */
export function useFirstReportWait(): FirstReportWait {
  const [since, setSince] = React.useState<number | null>(null);
  const [expired, setExpired] = React.useState(false);
  React.useEffect(() => {
    if (since === null) {
      return;
    }
    const timer = window.setTimeout(() => setExpired(true), FIRST_REPORT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [since]);
  return {
    since,
    expired,
    start: () => {
      setExpired(false);
      setSince(Date.now());
    },
    stop: () => {
      setExpired(false);
      setSince(null);
    },
  };
}

/** Whether the page should ask for the setup every few seconds. */
export function firstReportPolling(
  wait: FirstReportWait,
  setup: JournalSetup | undefined,
): boolean {
  return (
    wait.since !== null &&
    !wait.expired &&
    !reportArrivedSince(setup?.lastReportAt ?? null, wait.since)
  );
}

/**
 * After the journal rule is set up: the first report so far, and a button that waits for the
 * next one (a test mail), saying when it arrived. Arrival is shown in Lapis, not green: a
 * report that arrived is running capture, not a passed restore check.
 */
export function FirstReport({ setup, wait }: { setup: JournalSetup; wait: FirstReportWait }) {
  const { t } = useTranslation("archive");
  const arrived = wait.since !== null && reportArrivedSince(setup.lastReportAt, wait.since);
  const waiting = wait.since !== null && !arrived && !wait.expired;

  return (
    <div className="space-y-2" data-slot="journal-first-report" aria-live="polite">
      {setup.firstReportAt ? (
        <p className="text-sm">
          <span className="text-muted-foreground">{t("journal.firstReport.first")}</span>{" "}
          <RelativeTime value={setup.firstReportAt} />
        </p>
      ) : null}
      {waiting ? (
        <div className="flex flex-wrap items-center gap-2" data-state="waiting">
          <StatusBadge tone="info" icon live>
            {t("journal.firstReport.waiting")}
          </StatusBadge>
          <Button variant="ghost" size="sm" onClick={wait.stop}>
            <X aria-hidden="true" />
            {t("journal.firstReport.stop")}
          </Button>
          <p className="text-muted-foreground basis-full text-xs">
            {t("journal.firstReport.waitingHint")}
          </p>
        </div>
      ) : arrived ? (
        <div className="flex flex-wrap items-center gap-2" data-state="arrived">
          <StatusBadge tone="info" icon>
            {t("journal.firstReport.arrived")}
          </StatusBadge>
          <span className="text-muted-foreground text-xs">
            {setup.lastReportAt ? <RelativeTime value={setup.lastReportAt} /> : null}
          </span>
        </div>
      ) : (
        <div className="space-y-1" data-state={wait.expired ? "expired" : "idle"}>
          {wait.expired ? (
            <p className="text-muted-foreground text-xs">{t("journal.firstReport.expired")}</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={wait.start}
            disabled={!setup.receiver.listening}
          >
            <Hourglass aria-hidden="true" />
            {t("journal.firstReport.start")}
          </Button>
          <p className="text-muted-foreground text-xs">{t("journal.firstReport.hint")}</p>
        </div>
      )}
    </div>
  );
}
