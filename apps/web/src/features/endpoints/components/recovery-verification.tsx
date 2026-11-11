import { AlertTriangle, CheckCircle2, ChevronDown, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { StatusBadge } from "@/components/kit";

import {
  RECOVERY_CHECK_IDS,
  RECOVERY_SERVER_WARNING_CODES,
  type RecoveryCheckResult,
  type RecoveryDetail,
  type RecoveryVerification,
} from "../api.js";

/**
 * What the recovery ISO reported at the end (docs/BAREMETAL.md 10.17, 14.6): the ten checks with
 * their findings and evidence, the warnings of the finish, and the hints for the time after the
 * restore. Everything is shown as text and marked as reported by the ISO; nothing of it is HTML.
 */

const RESULT_TONE: Record<RecoveryCheckResult, "success" | "warning" | "destructive"> = {
  ok: "success",
  warning: "warning",
  failed: "destructive",
};

function ResultIcon({ result }: { result: RecoveryCheckResult }) {
  if (result === "ok") {
    return <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-success-text" />;
  }
  if (result === "warning") {
    return <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-warning-text" />;
  }
  return <XCircle aria-hidden="true" className="size-4 shrink-0 text-destructive-text" />;
}

/** The checks in the order of 10.17; an id a newer ISO adds comes last, by its id. */
function orderedChecks(verification: RecoveryVerification) {
  const known = RECOVERY_CHECK_IDS as readonly string[];
  return [...verification.checks].sort((a, b) => {
    const left = known.indexOf(a.id);
    const right = known.indexOf(b.id);
    return (left < 0 ? known.length : left) - (right < 0 ? known.length : right);
  });
}

/** The verification report (`restow-verify-v1`). */
export function RecoveryVerificationBlock({
  verification,
}: {
  verification: RecoveryVerification;
}) {
  const { t } = useTranslation("endpoints");
  return (
    <section className="grid gap-2" data-slot="recovery-verification">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{t("recovery.verification.title")}</h3>
        <StatusBadge tone={RESULT_TONE[verification.result]} data-slot="verification-result">
          {t(`recovery.verification.result.${verification.result}`)}
        </StatusBadge>
      </div>
      <ul className="grid gap-1">
        {orderedChecks(verification).map((check) => {
          const evidence = Object.entries(check.evidence);
          return (
            <li
              key={check.id}
              className="grid gap-1 rounded-md border px-2 py-1.5 text-sm"
              data-check={check.id}
              data-result={check.result}
            >
              <span className="flex items-center gap-2">
                <ResultIcon result={check.result} />
                <span>
                  {t(`recovery.verification.checks.${check.id}`, { defaultValue: check.id })}
                </span>
              </span>
              {check.findings.length > 0 ? (
                <ul className="grid gap-0.5 pl-6 text-xs">
                  {check.findings.map((finding) => (
                    <li key={`${finding.code}:${finding.ref ?? ""}:${finding.message}`}>
                      {t(`recovery.reported.${finding.code}`, { defaultValue: finding.code })}
                      {finding.ref ? <span className="font-mono"> ({finding.ref})</span> : null}
                      {finding.message ? (
                        <span className="block text-muted-foreground">{finding.message}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {evidence.length > 0 ? (
                <details className="pl-6 text-xs">
                  <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                    <ChevronDown aria-hidden="true" className="size-3" />
                    {t("recovery.verification.evidence")}
                  </summary>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 font-mono">
                    {evidence.map(([key, value]) => (
                      <div key={key} className="contents">
                        <dt className="text-muted-foreground">{key}</dt>
                        <dd className="break-all">{String(value)}</dd>
                      </div>
                    ))}
                  </dl>
                </details>
              ) : null}
            </li>
          );
        })}
      </ul>
      {verification.restoreErrors > 0 ? (
        <p className="text-sm" data-slot="verification-restore-errors">
          {t("recovery.verification.restoreErrors", { count: verification.restoreErrors })}
        </p>
      ) : null}
      {verification.notAdaptedKernels.length > 0 ? (
        <p className="text-sm" data-slot="verification-kernels">
          {t("recovery.verification.notAdaptedKernels", {
            kernels: verification.notAdaptedKernels.join(", "),
          })}
        </p>
      ) : null}
      {verification.fixups.length > 0 ? (
        <div className="grid gap-0.5 text-sm" data-slot="verification-fixups">
          <span className="font-medium">{t("recovery.verification.fixups")}</span>
          <ul className="font-mono text-xs">
            {verification.fixups.map((fixup) => (
              <li key={`${fixup.path}-${fixup.rule}`}>
                {fixup.path} ({fixup.rule}){fixup.backup ? ` -> ${fixup.backup}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("recovery.verification.isoReported")}</p>
    </section>
  );
}

/**
 * The warnings of the finish: a text of our own per code, the ISO's message below it. A warning the
 * server set itself (a reported success it did not take) says so, and names the checks concerned.
 */
export function RecoveryWarnings({ warnings }: { warnings: RecoveryDetail["warnings"] }) {
  const { t } = useTranslation("endpoints");
  if (warnings.length === 0) {
    return null;
  }
  return (
    <ul className="grid gap-1 text-sm" data-slot="recovery-warnings">
      {warnings.map((warning) => {
        const byServer = (RECOVERY_SERVER_WARNING_CODES as readonly string[]).includes(
          warning.code,
        );
        return (
          <li
            key={`${warning.code}:${warning.message}`}
            className="rounded-md border border-warning/40 bg-warning/5 px-2 py-1"
            data-code={warning.code}
            data-reported-by={byServer ? "server" : "iso"}
          >
            {byServer
              ? t(`recovery.serverReported.codes.${warning.code}`, { defaultValue: warning.code })
              : t(`recovery.reported.${warning.code}`, { defaultValue: warning.code })}
            {warning.message ? (
              <span className="block text-xs text-muted-foreground">
                {byServer
                  ? t("recovery.serverReported.checks", {
                      checks: warning.message
                        .split(", ")
                        .map((id) => t(`recovery.verification.checks.${id}`, { defaultValue: id }))
                        .join(", "),
                    })
                  : t("recovery.verification.isoMessage", { message: warning.message })}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The hints for the time after the restore (step 6 of the wizard), with their parameters. */
export function RecoveryHints({ hints }: { hints: RecoveryVerification["hints"] }) {
  const { t } = useTranslation("endpoints");
  if (hints.length === 0) {
    return null;
  }
  return (
    <ul className="grid list-disc gap-1 pl-5 text-sm" data-slot="recovery-hints">
      {hints.map((hint) => (
        <li key={`${hint.code}:${JSON.stringify(hint.params)}`} data-hint={hint.code}>
          {t(`recovery.hints.${hint.code}`, { ...hint.params, defaultValue: hint.code })}
        </li>
      ))}
    </ul>
  );
}
