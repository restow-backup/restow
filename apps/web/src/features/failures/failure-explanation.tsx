import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CircleAlert,
  ExternalLink,
  Info,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { CopyButton } from "@/components/kit/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { phaseLabel } from "@/features/jobs/presenters";
import { formatDateTime, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { Failure } from "./api";
import { stepLink } from "./paths";
import { failureTone, supportText, technicalRows, textVariables } from "./presenters";

/**
 * What a failed job, item, source, sync or verification tells the operator,
 * in three parts: what happened, why, and what to do. The cause comes from the
 * server as a stable code with parameters; every word is translated here
 * (`failures` namespace). Old rows without a classified cause, and codes of a
 * newer server, still show the recorded message and the technical details
 * instead of nothing.
 */

/** What the failure happened to; picks the sentence of "What happened". */
export type FailureSubject =
  | {
      kind: "job";
      /** The translated name of the job type, e.g. "Backup". */
      queue: string;
      /** The mailbox, drive or account, when the job concerns one. */
      object?: string | null;
    }
  | { kind: "item"; item: string }
  | { kind: "source"; name: string }
  | { kind: "sync"; name: string }
  | { kind: "credential"; name: string }
  | { kind: "verify"; object: string }
  | { kind: "none" };

export interface FailureExplanationProps {
  /** The classified cause; null for a row from before causes were kept. */
  failure: Failure | null;
  /** The recorded message (never contains secrets); the only detail an old row has. */
  message?: string | null;
  subject: FailureSubject;
  /** The source the failure concerns, so steps can link to it. */
  sourceId?: string | null;
  /** The time to state when the failure has none of its own (old rows). */
  at?: string | null;
  /** The troubleshooting page to offer when the failure carries none (old rows). */
  docsUrl?: string | null;
  /** How many items the failure affected, when it is about a run. */
  affectedItems?: number;
  /** The job is queued again after this failure: the failure describes an earlier attempt. */
  retrying?: boolean;
  /** Called by "Retry now"; the button shows only where a retry makes sense. */
  onRetry?: (() => void) | null;
  retryPending?: boolean;
  /** Skip the "What happened" sentence (the surrounding UI already says it). */
  hideWhat?: boolean;
  /**
   * Force the tone. Without it a failure Restow is retrying by itself is a
   * warning and everything else an error; failed items of a run that
   * finished are a warning too (the run itself went through). `info` is for a
   * check that could not complete: it explains the cause but proves nothing
   * broken, so it is neither amber nor red.
   */
  tone?: "warning" | "destructive" | "info";
  /** Targets not to link to, because the operator is already on that page. */
  skipTargets?: readonly string[];
  className?: string;
}

function knownCode(exists: (key: string) => boolean, code: string): boolean {
  return exists(`failures:cause.${code}.title`);
}

export function FailureExplanation({
  failure,
  message = null,
  subject,
  sourceId = null,
  at = null,
  docsUrl: fallbackDocsUrl = null,
  affectedItems = 0,
  retrying = false,
  onRetry = null,
  retryPending = false,
  hideWhat = false,
  tone: forcedTone,
  skipTargets = [],
  className,
}: FailureExplanationProps) {
  const { t, i18n } = useTranslation("failures");
  const { t: tb } = useTranslation("backup");
  const language = i18n.resolvedLanguage ?? i18n.language;
  const known = failure !== null && knownCode(i18n.exists.bind(i18n), failure.code);
  const code = known && failure ? failure.code : "unknown";
  const variables = textVariables(failure ?? { params: {} });
  const tone = forcedTone ?? failureTone(failure, { willRetry: retrying });
  const Icon = tone === "warning" ? TriangleAlert : tone === "info" ? Info : CircleAlert;
  const titleId = React.useId();

  const when = formatRelative(failure?.occurredAt ?? at, language) ?? "";
  const nextAttempt = failure?.retry?.nextAttemptAt
    ? formatDateTime(failure.retry.nextAttemptAt, language)
    : null;
  const stepName = failure?.step
    ? tb(phaseLabel(failure.step).key, phaseLabel(failure.step).values)
    : null;

  const rows = failure ? technicalRows(failure) : [];
  // Old rows and unclassified errors: the message is the only thing there is to read, so it is visible.
  const showMessageUpfront = message && (failure === null || code === "unknown");
  const canRetry = onRetry !== null && !retrying && (failure === null || failure.retryable);
  const steps = failure?.steps ?? [];
  const docsUrl = failure?.docsUrl ?? fallbackDocsUrl;

  return (
    <Alert variant={tone} className={cn("items-start", className)} aria-labelledby={titleId}>
      <Icon aria-hidden="true" />
      <AlertTitle id={titleId} className="text-base font-semibold">
        {t(`cause.${code}.title`, variables)}
      </AlertTitle>
      <AlertDescription className="mt-2 w-full text-sm">
        <div className="w-full space-y-4">
          {hideWhat ? null : (
            <Section heading={t("section.what")}>
              <p>{whatSentence(t, subject, when, retrying)}</p>
              {stepName ? <p>{t("what.step", { step: stepName })}</p> : null}
              {affectedItems > 0 ? <p>{t("what.items", { count: affectedItems })}</p> : null}
              {failure?.retry ? (
                <p className="font-medium">
                  {nextAttempt
                    ? t("what.retry", {
                        attempt: failure.retry.attempt,
                        limit: failure.retry.limit,
                        when: nextAttempt,
                      })
                    : t("what.retryUnknown", {
                        attempt: failure.retry.attempt,
                        limit: failure.retry.limit,
                      })}
                </p>
              ) : null}
            </Section>
          )}

          <Section heading={t("section.why")}>
            {failure === null ? (
              <p>{t("section.olderFailure")}</p>
            ) : (
              <p>{t(`cause.${code}.why`, variables)}</p>
            )}
            {showMessageUpfront ? (
              <p className="break-words rounded-md bg-background/60 p-2 font-mono text-xs">
                <span className="sr-only">{t("section.recordedMessage")}: </span>
                {message}
              </p>
            ) : null}
          </Section>

          {steps.length > 0 || canRetry || docsUrl ? (
            <Section heading={t("section.todo")}>
              {steps.length > 0 ? (
                <ol className="list-decimal space-y-2 pl-5">
                  {steps.map((step, index) => {
                    // Several steps about the same page link to it once, at the first of them.
                    const firstOfTarget =
                      steps.findIndex((other) => other.target === step.target) === index;
                    const link =
                      firstOfTarget && !skipTargets.includes(String(step.target))
                        ? stepLink(step, { sourceId })
                        : null;
                    return (
                      <li key={`${step.id}-${step.target}`}>
                        <span>{t(`steps.${step.id}`, variables)}</span>
                        {link && step.target ? (
                          <div className="mt-0.5">
                            <Link
                              to={link.to}
                              {...(link.search ? { search: link.search as never } : {})}
                              className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4 hover:no-underline"
                            >
                              {t(`go.${step.target}`)}
                              <ArrowRight className="size-3.5" aria-hidden="true" />
                            </Link>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
              ) : null}
              <div className="flex flex-wrap items-center gap-3 pt-1">
                {canRetry ? (
                  <Button size="sm" variant="outline" loading={retryPending} onClick={onRetry}>
                    {retryPending ? null : <RotateCcw aria-hidden="true" />}
                    {t("section.retryNow")}
                  </Button>
                ) : null}
                {docsUrl ? (
                  <a
                    href={docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-4 hover:no-underline"
                  >
                    {t("section.docs")}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                ) : null}
              </div>
            </Section>
          ) : null}

          {failure || message ? (
            <details className="group rounded-md border border-border/60 bg-background/50">
              <summary className="cursor-pointer select-none px-3 py-2 font-medium">
                {t("section.technical")}
              </summary>
              <div className="space-y-3 border-t border-border/60 px-3 py-3">
                <p className="text-xs text-muted-foreground">{t("section.technicalHelp")}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                  {failure ? (
                    <>
                      <TechnicalRow label={t("technicalKeys.code")} value={failure.code} />
                      <TechnicalRow
                        label={t("technicalKeys.occurredAt")}
                        value={failure.occurredAt}
                      />
                      {failure.step ? (
                        <TechnicalRow label={t("technicalKeys.step")} value={failure.step} />
                      ) : null}
                    </>
                  ) : null}
                  {rows.map((row) => (
                    <TechnicalRow
                      key={row.key}
                      label={
                        i18n.exists(`failures:technicalKeys.${row.key}`)
                          ? t(`technicalKeys.${row.key}`)
                          : row.key
                      }
                      value={row.value}
                    />
                  ))}
                  {message && !rows.some((row) => row.key === "message") ? (
                    <TechnicalRow label={t("section.recordedMessage")} value={message} />
                  ) : null}
                </dl>
                {failure ? (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CopyButton
                      value={supportText(failure, rows)}
                      label={t("section.copy")}
                      variant="ghost"
                      size="icon-sm"
                    />
                    <span>{t("section.copy")}</span>
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}

function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {heading}
      </h3>
      {children}
    </section>
  );
}

function TechnicalRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{value}</dd>
    </>
  );
}

/** The sentence that states what happened to the subject. */
function whatSentence(
  t: (key: string, values?: Record<string, unknown>) => string,
  subject: FailureSubject,
  when: string,
  retrying: boolean,
): string {
  const sentence = sentenceFor(t, subject, when, retrying);
  // Without a time the sentence would end in a stray space before its full stop.
  return sentence.replace(/\s+([.,)])/g, "$1");
}

function sentenceFor(
  t: (key: string, values?: Record<string, unknown>) => string,
  subject: FailureSubject,
  when: string,
  retrying: boolean,
): string {
  switch (subject.kind) {
    case "job":
      if (retrying) {
        return subject.object
          ? t("what.attempt", { queue: subject.queue, object: subject.object, when })
          : t("what.attemptNoObject", { queue: subject.queue, when });
      }
      return subject.object
        ? t("what.job", { queue: subject.queue, object: subject.object, when })
        : t("what.jobNoObject", { queue: subject.queue, when });
    case "item":
      return t("what.item", { item: subject.item, when });
    case "source":
      return t("what.source", { name: subject.name, when });
    case "sync":
      return t("what.sync", { name: subject.name, when });
    case "credential":
      return t("what.credential", { name: subject.name, when });
    case "verify":
      return t("what.verify", { object: subject.object, when });
    default:
      return "";
  }
}
