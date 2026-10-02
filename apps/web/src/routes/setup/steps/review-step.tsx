import { useTranslation } from "react-i18next";

import type { SetupFormValues, SetupLanguage } from "@/routes/setup/schema";

interface ReviewStepProps {
  values: SetupFormValues;
  /** The language chosen in the first step. */
  language: SetupLanguage;
}

/** Read-only summary of every entry before the wizard submits. */
export function ReviewStep({ values, language }: ReviewStepProps) {
  const { t } = useTranslation("setup");

  const mailSummary = values.mail.skipped
    ? t("review.mailSkipped")
    : values.mail.transport === "smtp"
      ? `${t("mail.transport.smtp")} · ${values.mail.smtp.host}:${values.mail.smtp.port} · ${values.mail.smtp.from}`
      : `${t("mail.transport.graph")} · ${values.mail.graph.sender}`;

  return (
    <dl className="divide-y divide-border text-sm">
      <ReviewRow label={t("review.language")} value={t("language.card.title", { lng: language })} />
      <ReviewRow
        label={t("review.mode")}
        value={values.operatingMode === "local" ? t("mode.local") : t("mode.public")}
      />
      {values.operatingMode === "public" ? (
        <ReviewRow label={t("review.publicUrl")} value={values.publicUrl} mono />
      ) : null}
      <ReviewRow label={t("review.organisation")} value={values.organisationName} />
      <ReviewRow label={t("review.admin")} value={`${values.admin.name} · ${values.admin.email}`} />
      <ReviewRow label={t("review.mail")} value={mailSummary} />
      {values.mail.skipped ? null : (
        <ReviewRow
          label={t("review.sendTest")}
          value={values.sendTest ? t("review.yes") : t("review.no")}
        />
      )}
    </dl>
  );
}

function ReviewRow({
  label,
  value,
  mono = false,
}: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={mono ? "break-all font-mono text-xs sm:text-right" : "font-medium sm:text-right"}
      >
        {value}
      </dd>
    </div>
  );
}
