import { Link } from "@tanstack/react-router";
import { ArrowRight, Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ARCHIVE_PATH } from "@/features/archive/paths";
import { ExtensionSlot } from "@/lib/extensions";

import { JOB_PURPOSES, type JobPurpose } from "../form.js";
import { EditorSection } from "./editor-section.js";

/**
 * The first question of a mail job's editor: what the job is for (docs/ARCHIVE.md, "Journaling
 * und Postfach-Sicherung"). A backup restores folders, calendar, contacts and whole mailboxes; the
 * archive keeps every mail, unchanged, from before anyone could change or delete it. While the job
 * archives, the section names how mail reaches the archive (Exchange journaling, set up once per
 * tenant) with the way to its setup, what the storage does for immutability, and what the
 * Business modules say about the journal (slot `jobs.archiveSetup`).
 */
export function PurposeSection({
  idPrefix,
  purpose,
  objectLock,
  onChange,
}: {
  idPrefix: string;
  purpose: JobPurpose;
  /** Whether the tenant's storage has Object Lock; null while unknown. */
  objectLock: boolean | null;
  onChange: (purpose: JobPurpose) => void;
}) {
  const { t } = useTranslation("backupjobs");
  const id = (name: string) => `${idPrefix}-${name}`;
  const archive = purpose !== "backup";

  return (
    <EditorSection id={idPrefix} title={t("editor.purpose.title")}>
      <RadioGroup
        aria-label={t("editor.purpose.title")}
        value={purpose}
        onValueChange={(value) => onChange(value as JobPurpose)}
        data-slot="job-purpose"
      >
        {JOB_PURPOSES.map((option) => (
          <div key={option} className="flex items-start gap-2">
            <RadioGroupItem
              id={id(option)}
              value={option}
              className="mt-0.5"
              aria-describedby={id(`${option}-hint`)}
            />
            <div className="space-y-0.5">
              <Label htmlFor={id(option)} className="font-normal">
                {t(`editor.purpose.${option}.label`)}
              </Label>
              <p id={id(`${option}-hint`)} className="text-xs text-muted-foreground">
                {t(`editor.purpose.${option}.hint`)}
              </p>
            </div>
          </div>
        ))}
      </RadioGroup>

      {archive ? (
        <div className="space-y-3">
          <div className="space-y-2 rounded-md border p-3" data-slot="archive-capture">
            <p className="text-sm font-medium">{t("editor.purpose.capture.title")}</p>
            <p className="text-xs text-muted-foreground">
              {t("editor.purpose.capture.journaling")}
            </p>
            <Link
              to={ARCHIVE_PATH}
              className={buttonVariants({ variant: "outline", size: "sm" })}
              data-slot="archive-capture-setup"
            >
              {t("editor.purpose.capture.setup")}
              <ArrowRight aria-hidden="true" />
            </Link>
          </div>
          {objectLock === false ? (
            <Alert variant="warning" data-slot="archive-object-lock">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>{t("editor.archive.noObjectLock")}</AlertDescription>
            </Alert>
          ) : objectLock === null ? (
            <p className="text-xs text-muted-foreground" data-slot="archive-object-lock">
              {t("editor.archive.objectLockUnknown")}
            </p>
          ) : null}
          <ExtensionSlot
            name="jobs.archiveSetup"
            props={{ archive }}
            fallback={
              <Alert data-slot="archive-edition">
                <Info aria-hidden="true" />
                <AlertDescription>{t("editor.archive.edition")}</AlertDescription>
              </Alert>
            }
          />
        </div>
      ) : (
        <Alert data-slot="backup-only">
          <Info aria-hidden="true" />
          <AlertTitle>{t("editor.purpose.backupOnly.title")}</AlertTitle>
          <AlertDescription>{t("editor.purpose.backupOnly.description")}</AlertDescription>
        </Alert>
      )}
    </EditorSection>
  );
}
