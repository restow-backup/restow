import { Info, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ExtensionSlot } from "@/lib/extensions";

import type { CaptureKind } from "../api.js";
import {
  type CaptureSettingsKey,
  type CaptureWays,
  forwardingChosen,
  needsJournal,
} from "../capture-ways.js";
import { JOB_PURPOSES, type JobPurpose } from "../form.js";
import { CaptureWaysField } from "./capture-ways-field.js";
import { EditorSection } from "./editor-section.js";

/**
 * The first question of a mail job's editor: what the job is for (docs/ARCHIVE.md, "Journaling
 * und Postfach-Sicherung"). A backup restores folders, calendar, contacts and whole mailboxes; the
 * archive keeps every mail, unchanged, from before anyone could change or delete it. While the job
 * archives, the section offers the capture ways that fit the kinds of mail objects the job covers
 * (capture-ways-field.tsx), says what the storage does for immutability, and shows what the
 * Business modules add for the ways chosen (slot `jobs.archiveSetup`: the journal address only
 * where Exchange journaling is chosen).
 */
export function PurposeSection({
  idPrefix,
  purpose,
  objectLock,
  onChange,
  captureKinds,
  scopeMode,
  capture,
  onCaptureChange,
  captureMissing,
  captureServerMessage,
}: {
  idPrefix: string;
  purpose: JobPurpose;
  /** Whether the tenant's storage has Object Lock; null while unknown. */
  objectLock: boolean | null;
  onChange: (purpose: JobPurpose) => void;
  /** The kinds of mail objects the job covers. */
  captureKinds: readonly CaptureKind[];
  scopeMode: "all" | "selected";
  capture: CaptureWays;
  onCaptureChange: (capture: CaptureWays) => void;
  /** Kinds without a way, once a save was tried. */
  captureMissing: readonly CaptureSettingsKey[];
  captureServerMessage?: string;
}) {
  const { t } = useTranslation("backupjobs");
  const id = (name: string) => `${idPrefix}-${name}`;
  const archive = purpose !== "backup";
  // Without the Business modules nothing receives journal reports or forwarded copies.
  const smtpChosen = needsJournal(capture, captureKinds) || forwardingChosen(capture, captureKinds);

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
          <CaptureWaysField
            idPrefix={id("capture")}
            kinds={captureKinds}
            scopeMode={scopeMode}
            value={capture}
            onChange={onCaptureChange}
            missing={captureMissing}
            serverMessage={captureServerMessage}
          />
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
            props={{ archive, kinds: captureKinds, capture }}
            fallback={
              smtpChosen ? (
                <Alert data-slot="archive-edition">
                  <Info aria-hidden="true" />
                  <AlertDescription>{t("editor.archive.edition")}</AlertDescription>
                </Alert>
              ) : null
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
