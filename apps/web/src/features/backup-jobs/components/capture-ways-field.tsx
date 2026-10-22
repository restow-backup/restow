import { Link } from "@tanstack/react-router";
import { ArrowRight, Info, Lock } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  ARCHIVE_PATH,
  FORWARDING_SECTION_ANCHOR,
  JOURNAL_SECTION_ANCHOR,
} from "@/features/archive/paths";
import type { GatedFeature } from "@/lib/api";
import { useSession } from "@/lib/session";

import type { CaptureKind } from "../api.js";
import {
  CAPTURE_WAY_OPTIONS,
  type CaptureSettingsKey,
  type CaptureWays,
  captureKeysOf,
  choicePending,
  wayChosen,
  withWay,
} from "../capture-ways.js";

/**
 * How mail reaches the archive, per kind of mail object of the job (docs/ARCHIVE.md
 * "Erfassungswege"): one card per kind with only the ways that fit it, each labelled
 * "echt" (at transport) or "zeitnah" (from the mailbox) with one line on what that means.
 * A way the installation's edition does not include (the gated features of `/me`) is shown
 * locked with the edition that has it. A kind needs at least one way (`missing` names those
 * without, as the API would). A kind of a job from before 0.4.4 that still waits for its first
 * way says so (nothing is captured from these accounts until a way is chosen). An IMAP account
 * on a Microsoft host gets the hint that a Microsoft 365 source captures it better.
 */
export function CaptureWaysField({
  idPrefix,
  kinds,
  scopeMode,
  value,
  onChange,
  missing,
  serverMessage,
}: {
  idPrefix: string;
  /** The kinds of mail objects the job covers. */
  kinds: readonly CaptureKind[];
  scopeMode: "all" | "selected";
  value: CaptureWays;
  onChange: (value: CaptureWays) => void;
  /** Kinds without a way, after a save was tried. */
  missing: readonly CaptureSettingsKey[];
  /** What the server said about the ways, if anything. */
  serverMessage?: string;
}) {
  const { t } = useTranslation("backupjobs");
  const session = useSession();
  const keys = captureKeysOf(kinds);
  const available = (feature: GatedFeature) => session.features?.includes(feature) ?? false;
  const id = (name: string) => `${idPrefix}-${name}`;

  return (
    <div className="space-y-3" data-slot="archive-capture">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{t("editor.capture.title")}</p>
        <p className="text-xs text-muted-foreground">{t("editor.capture.description")}</p>
      </div>

      {keys.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-slot="capture-no-kinds">
          {t(scopeMode === "all" ? "editor.capture.noMail" : "editor.capture.pickFirst")}
        </p>
      ) : null}

      {keys.map((key) => {
        const without = missing.includes(key);
        const errorId = id(`${key}-error`);
        const forward = key !== "m365" && wayChosen(value, key, "forward");
        const journal = key === "m365" && wayChosen(value, key, "journal");
        return (
          <fieldset
            key={key}
            className="min-w-0 space-y-3 rounded-md border p-3"
            data-slot={`capture-kind-${key}`}
            aria-describedby={without ? errorId : undefined}
          >
            <legend className="px-1 text-sm font-medium">{t(`editor.capture.kind.${key}`)}</legend>
            {CAPTURE_WAY_OPTIONS[key].map((option) => {
              const inputId = id(`${key}-${option.field}`);
              const hintId = `${inputId}-hint`;
              const open = available(option.feature);
              return (
                <div
                  key={option.field}
                  className="flex items-start gap-2"
                  data-slot={`capture-way-${key}-${option.field}`}
                  data-available={open ? "true" : "false"}
                >
                  <Checkbox
                    id={inputId}
                    className="mt-0.5"
                    checked={wayChosen(value, key, option.field)}
                    disabled={!open}
                    aria-describedby={hintId}
                    aria-invalid={without || undefined}
                    onCheckedChange={(checked) =>
                      onChange(withWay(value, key, option.field, checked === true))
                    }
                  />
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor={inputId} className="font-normal">
                        {t(`editor.capture.way.${key}.${option.field}`)}
                      </Label>
                      <Badge variant="outline" data-assurance={option.assurance}>
                        {t(`editor.capture.assurance.${option.assurance}.label`)}
                      </Badge>
                    </div>
                    <p id={hintId} className="text-xs text-muted-foreground">
                      {t(`editor.capture.wayHint.${key}.${option.field}`)}{" "}
                      {t(`editor.capture.assurance.${option.assurance}.hint`)}
                      {open ? null : (
                        <span className="mt-1 flex items-center gap-1" data-slot="capture-edition">
                          <Lock aria-hidden="true" className="size-3 shrink-0" />
                          {t("editor.capture.edition")}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}

            {key !== "m365" && choicePending(value, key) ? (
              <Alert data-slot={`capture-pending-${key}`}>
                <Info aria-hidden="true" />
                <AlertDescription>{t(`editor.capture.pending.${key}`)}</AlertDescription>
              </Alert>
            ) : null}

            {key === "imap" && kinds.includes("imap_microsoft") ? (
              <Alert data-slot="capture-imap-microsoft">
                <Info aria-hidden="true" />
                <AlertDescription>{t("editor.capture.imapMicrosoft")}</AlertDescription>
              </Alert>
            ) : null}

            {journal || forward ? (
              <Link
                to={ARCHIVE_PATH}
                hash={journal ? JOURNAL_SECTION_ANCHOR : FORWARDING_SECTION_ANCHOR}
                className={buttonVariants({ variant: "outline", size: "sm" })}
                data-slot={journal ? "capture-journal-setup" : "capture-forward-setup"}
              >
                {t(journal ? "editor.capture.setupJournal" : "editor.capture.setupForward")}
                <ArrowRight aria-hidden="true" />
              </Link>
            ) : null}

            {without ? (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {serverMessage ?? t("editor.capture.noWay")}
              </p>
            ) : null}
          </fieldset>
        );
      })}
    </div>
  );
}
